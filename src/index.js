const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';

const ENABLE_5M = true;
const ENABLE_15M = false;
const ENABLE_5M_LONG = true;
const ENABLE_5M_SHORT = true;
const ENABLE_15M_LONG = false;
const ENABLE_15M_SHORT = false;
const ASSETS_5M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_SIZE = 0;
const WINDOW_5M = 5 * 60 * 1000;
const RECONNECT_MS = 3000;

let windowStart5m = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
// For each 5M period store whether a coin had at least one liquidation in each direction.
let currentPeriodLiquidations = new Map();
let previousPeriodLiquidations = new Map();
let flushTimer = null;
let websocket = null;
let reconnectTimer = null;
let stopping = false;
let advancing = Promise.resolve();

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function parseSymbol(symbol, assets) {
  const s = String(symbol ?? '').toUpperCase();
  for (const quote of QUOTES) {
    if (s.endsWith(quote)) {
      const asset = s.slice(0, -quote.length);
      if (assets.has(asset)) return { asset, quote };
    }
  }
  return null;
}
function money(v, quote) { return `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${quote}`; }
function marketLink(asset, start) {
  return `https://polymarket.com/event/${asset.toLowerCase()}-updown-5m-${Math.floor(start / 1000)}`;
}
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false })
    });
    if (!response.ok) console.error('[Telegram] HTTP', response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error('[Telegram]', error?.message ?? error);
    return false;
  }
}

async function sendAlert(asset, side, notional, quote, marketStart) {
  const text = [
    `🚨 ${side} LIQUIDATION — 5M`,
    '',
    `${asset} — ${side} LIQUIDATION`,
    `💥 Size: ${money(notional, quote)}`,
    '',
    `▶️ ${asset} 5M UP/DOWN`,
    marketLink(asset, marketStart)
  ].join('\n');
  return sendTelegram(text);
}

function clearCurrentPeriod() {
  currentPeriodLiquidations = new Map();
}

async function emitWindow5m(start, end) {
  const current = currentPeriodLiquidations;
  const previous = previousPeriodLiquidations;

  // A setup is valid only when the same coin had a liquidation in the same
  // direction in two consecutive 5M periods. If the second period is missing,
  // or direction changes, the counter is reset by replacing previous with current.
  for (const [asset, currentSides] of current) {
    const previousSides = previous.get(asset);
    if (!previousSides) continue;

    for (const side of ['LONG', 'SHORT']) {
      if (!currentSides.has(side) || !previousSides.has(side)) continue;
      if (side === 'LONG' && !ENABLE_5M_LONG) continue;
      if (side === 'SHORT' && !ENABLE_5M_SHORT) continue;

      // We do not track the largest liquidation anymore. The alert size is the
      // total liquidation notional observed for this coin/direction in the
      // confirming (second) 5M period.
      const currentData = currentSides.get(side);
      await sendAlert(asset, side, currentData.notional, currentData.quote, end);
    }
  }

  previousPeriodLiquidations = current;
  clearCurrentPeriod();
}

async function advanceWindows(now) {
  const target5 = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  while (windowStart5m < target5) {
    const start = windowStart5m;
    const end = start + WINDOW_5M;
    windowStart5m = end;
    await emitWindow5m(start, end);
  }
}

function requestAdvance(now) {
  advancing = advancing
    .then(() => advanceWindows(now))
    .catch(error => console.error('[Window]', error?.message ?? error));
  return advancing;
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  const next = windowStart5m + WINDOW_5M;
  flushTimer = setTimeout(async () => {
    await requestAdvance(Date.now());
    if (!stopping) scheduleFlush();
  }, Math.max(100, next - Date.now() + 50));
}

async function handleForceOrder(payload) {
  const order = payload?.o;
  if (!order) return;

  const side = String(order.S ?? '').toUpperCase();
  if (side !== 'SELL' && side !== 'BUY') return;

  const parsed = parseSymbol(order.s, ASSETS_5M);
  if (!parsed) return;

  const price = num(order.ap) || num(order.p);
  const quantity = num(order.q);
  const notional = Math.abs(price * quantity);
  if (!(price > 0) || !(quantity > 0) || notional < MIN_SIZE) return;

  const time = num(payload.E) || num(order.T) || Date.now();
  await requestAdvance(time);

  const w = Math.floor(time / WINDOW_5M) * WINDOW_5M;
  if (w !== windowStart5m) return;

  // Binance liquidation order side mapping:
  // SELL = forced close of a LONG position -> LONG liquidation.
  // BUY  = forced close of a SHORT position -> SHORT liquidation.
  const liquidationDirection = side === 'SELL' ? 'LONG' : 'SHORT';
  if (liquidationDirection === 'LONG' && !ENABLE_5M_LONG) return;
  if (liquidationDirection === 'SHORT' && !ENABLE_5M_SHORT) return;

  let sides = currentPeriodLiquidations.get(parsed.asset);
  if (!sides) {
    sides = new Map();
    currentPeriodLiquidations.set(parsed.asset, sides);
  }

  const existing = sides.get(liquidationDirection);
  if (existing) {
    existing.notional += notional;
  } else {
    sides.set(liquidationDirection, { notional, quote: parsed.quote });
  }
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
    } catch (error) {
      console.error('[Parse]', error?.message ?? error);
    }
  });
  websocket.addEventListener('error', error => console.error('[WebSocket]', error?.message ?? error));
  websocket.addEventListener('close', () => {
    if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
}

function shutdown(signal) {
  stopping = true;
  clearTimeout(flushTimer);
  clearTimeout(reconnectTimer);
  try { websocket?.close(); } catch {}
  console.log(`Shutdown: ${signal}`);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('=== POLYMARKET LIQUIDATION MONITOR ===');
console.log('SOURCE: BINANCE FUTURES FORCE ORDER STREAM');
console.log('5M: LONG + SHORT | 15M: DISABLED | minimum size: 0 USDT/USDC');
console.log('5M assets: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
console.log('ALERT MODE: same coin + same direction in two consecutive 5M periods; otherwise reset');
console.log('ALERT MARKET: next 5M market after the confirming second period');

scheduleFlush();
connect();
