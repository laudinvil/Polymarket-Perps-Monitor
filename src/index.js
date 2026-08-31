const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';

const ENABLE_5M = true;
const ENABLE_15M = false;
const ENABLE_5M_LONG = true;
const ENABLE_5M_SHORT = true;
const ASSETS_5M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_SIZE = 0;
const WINDOW_5M = 5 * 60 * 1000;
const RECONNECT_MS = 3000;
const REQUIRED_PERIODS = 3;

let windowStart5m = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
// Per coin+direction: number of consecutive 5M periods containing at least one liquidation.
const streaks = new Map();
let flushTimer = null;
let websocket = null;
let reconnectTimer = null;
let stopping = false;
let advancing = Promise.resolve();

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function parseSymbol(symbol) {
  const s = String(symbol ?? '').toUpperCase();
  for (const quote of QUOTES) {
    if (s.endsWith(quote)) {
      const asset = s.slice(0, -quote.length);
      if (ASSETS_5M.has(asset)) return { asset, quote };
    }
  }
  return null;
}
function money(v, quote) { return `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${quote}`; }
function marketLink(asset, start) { return `https://polymarket.com/event/${asset.toLowerCase()}-updown-5m-${Math.floor(start / 1000)}`; }
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) });
    if (!response.ok) console.error('[Telegram] HTTP', response.status, await response.text());
    return response.ok;
  } catch (error) { console.error('[Telegram]', error?.message ?? error); return false; }
}

async function sendAlert(item, marketStart) {
  if (!item || item.notional < MIN_SIZE) return false;
  const text = [`🚨 ${item.side} LIQUIDATION — 5M`, '', `${item.asset} — ${item.side} LIQUIDATION`, `💥 Size: ${money(item.notional, item.quote)}`, '', `▶️ NEXT ${item.asset} 5M UP/DOWN`, marketLink(item.asset, marketStart)].join('\n');
  return sendTelegram(text);
}

function periodState() {
  const current = new Map();
  return current;
}

// Holds whether each coin+direction had at least one liquidation in the current 5M period,
// plus the latest liquidation to use in an alert.
const currentPeriod = new Map();

async function closePeriod(start, end) {
  const present = new Set(currentPeriod.keys());
  const keys = new Set([...streaks.keys(), ...present]);

  for (const key of keys) {
    const [asset, side] = key.split('|');
    const hadLiquidation = present.has(key);
    const previous = streaks.get(key) || 0;

    if (!hadLiquidation) {
      streaks.delete(key);
      continue;
    }

    const count = previous + 1;
    streaks.set(key, count);

    if (count === REQUIRED_PERIODS) {
      const item = currentPeriod.get(key);
      // Alert on the next market after the third consecutive 5M period.
      const targetMarketStart = end;
      await sendAlert({ ...item, asset, side }, targetMarketStart);
      // Start a new sequence after an alert; a new alert requires 3 fresh periods.
      streaks.delete(key);
    }
  }
  currentPeriod.clear();
}

async function advanceWindows(now) {
  const target5 = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  while (windowStart5m < target5) {
    const start = windowStart5m;
    const end = start + WINDOW_5M;
    windowStart5m = end;
    await closePeriod(start, end);
  }
}
function requestAdvance(now) { advancing = advancing.then(() => advanceWindows(now)).catch(error => console.error('[Window]', error?.message ?? error)); return advancing; }
function scheduleFlush() {
  clearTimeout(flushTimer);
  const next = windowStart5m + WINDOW_5M;
  flushTimer = setTimeout(async () => { await requestAdvance(Date.now()); if (!stopping) scheduleFlush(); }, Math.max(100, next - Date.now() + 50));
}

async function handleForceOrder(payload) {
  const order = payload?.o; if (!order) return;
  const sideRaw = String(order.S ?? '').toUpperCase();
  if (sideRaw !== 'SELL' && sideRaw !== 'BUY') return;
  const parsed = parseSymbol(order.s); if (!parsed) return;
  const price = num(order.ap) || num(order.p);
  const quantity = num(order.q);
  const notional = Math.abs(price * quantity);
  if (!(price > 0) || !(quantity > 0) || notional < MIN_SIZE) return;

  const side = sideRaw === 'SELL' ? 'LONG' : 'SHORT';
  if (side === 'LONG' && !ENABLE_5M_LONG) return;
  if (side === 'SHORT' && !ENABLE_5M_SHORT) return;

  const time = num(payload.E) || num(order.T) || Date.now();
  await requestAdvance(time);
  const w = Math.floor(time / WINDOW_5M) * WINDOW_5M;
  if (w !== windowStart5m) return;

  const key = `${parsed.asset}|${side}`;
  const item = { asset: parsed.asset, quote: parsed.quote, price, quantity, notional };
  // Multiple liquidations in one 5M period count as ONE occurrence for the streak.
  // Keep the latest one for the alert text.
  currentPeriod.set(key, item);
}

function connect() {
  if (stopping) return;
  websocket = new WebSocket(BINANCE_WS_URL);
  websocket.addEventListener('open', () => console.log('Binance liquidation stream connected'));
  websocket.addEventListener('message', event => {
    try {
      const payload = JSON.parse(String(event.data));
      if (payload?.e === 'forceOrder') void handleForceOrder(payload);
      else if (payload?.data?.e === 'forceOrder') void handleForceOrder(payload.data);
    } catch (error) { console.error('[Parse]', error?.message ?? error); }
  });
  websocket.addEventListener('error', error => console.error('[WebSocket]', error?.message ?? error));
  websocket.addEventListener('close', () => { if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS); });
}
function shutdown(signal) { stopping = true; clearTimeout(flushTimer); clearTimeout(reconnectTimer); try { websocket?.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
console.log('=== POLYMARKET LIQUIDATION MONITOR ===');
console.log('SOURCE: BINANCE FUTURES FORCE ORDER STREAM');
console.log('5M: LONG + SHORT | 15M: DISABLED | minimum size: 0 USDT/USDC');
console.log('5M assets: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
console.log('ALERT MODE: liquidation in 3 consecutive 5M periods, same coin + same direction; alert on next 5M market');
scheduleFlush();
connect();
