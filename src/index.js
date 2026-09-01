const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';

const ENABLE_5M = true;
const ENABLE_15M = false;
const ENABLE_5M_LONG = true;
const ENABLE_5M_SHORT = true;
const ASSETS = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_SIZE = 0;
const WINDOW_5M = 5 * 60 * 1000;
const RECONNECT_MS = 3000;

let windowStart5m = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
let alerted5mWindow = null;
let lastAlertAsset = null;
let flush5mTimer = null;
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
      if (ASSETS.has(asset)) return { asset, quote };
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
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) });
    if (!response.ok) console.error('[Telegram] HTTP', response.status, await response.text());
    return response.ok;
  } catch (error) { console.error('[Telegram]', error?.message ?? error); return false; }
}
async function sendAlert(item, marketStart) {
  if (!item || item.notional < MIN_SIZE) return false;
  const text = [`🚨 ${item.side} LIQUIDATION — 5M`, '', `${item.asset} — ${item.side} LIQUIDATION`, `💥 Size: ${money(item.notional, item.quote)}`, '', `▶️ ${item.asset} 5M UP/DOWN`, marketLink(item.asset, marketStart)].join('\n');
  return sendTelegram(text);
}
async function advanceWindows(now) {
  const target5 = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  if (target5 > windowStart5m) {
    windowStart5m = target5;
    alerted5mWindow = null;
  }
}
function requestAdvance(now) { advancing = advancing.then(() => advanceWindows(now)).catch(error => console.error('[Window]', error?.message ?? error)); return advancing; }
function scheduleFlush() {
  clearTimeout(flush5mTimer);
  const next = windowStart5m + WINDOW_5M;
  flush5mTimer = setTimeout(async () => { await requestAdvance(Date.now()); if (!stopping) scheduleFlush(); }, Math.max(100, next - Date.now() + 50));
}
async function handleForceOrder(payload) {
  const order = payload?.o; if (!order) return;
  const sideRaw = String(order.S ?? '').toUpperCase();
  if (sideRaw !== 'SELL' && sideRaw !== 'BUY') return;
  const parsed = parseSymbol(order.s); if (!parsed) return;
  const price = num(order.ap) || num(order.p); const quantity = num(order.q); const notional = Math.abs(price * quantity);
  if (!(price > 0) || !(quantity > 0) || notional < MIN_SIZE) return;
  const side = sideRaw === 'SELL' ? 'LONG' : 'SHORT';
  if (side === 'LONG' && !ENABLE_5M_LONG) return;
  if (side === 'SHORT' && !ENABLE_5M_SHORT) return;
  const time = num(payload.E) || num(order.T) || Date.now(); await requestAdvance(time);
  const period = Math.floor(time / WINDOW_5M) * WINDOW_5M;
  if (!ENABLE_5M || period !== windowStart5m || alerted5mWindow === period) return;
  if (lastAlertAsset === parsed.asset) return;
  alerted5mWindow = period;
  const item = { asset: parsed.asset, quote: parsed.quote, price, quantity, notional, side };
  const sent = await sendAlert(item, period);
  if (sent) lastAlertAsset = parsed.asset;
  else console.error('[Alert] Telegram send failed; period remains consumed');
}
function connect() {
  if (stopping) return;
  websocket = new WebSocket(BINANCE_WS_URL);
  websocket.addEventListener('open', () => console.log('Binance liquidation stream connected'));
  websocket.addEventListener('message', event => { try { const payload = JSON.parse(String(event.data)); if (payload?.e === 'forceOrder') void handleForceOrder(payload); else if (payload?.data?.e === 'forceOrder') void handleForceOrder(payload.data); } catch (error) { console.error('[Parse]', error?.message ?? error); } });
  websocket.addEventListener('error', error => console.error('[WebSocket]', error?.message ?? error));
  websocket.addEventListener('close', () => { if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS); });
}
function shutdown(signal) { stopping = true; clearTimeout(flush5mTimer); clearTimeout(reconnectTimer); try { websocket?.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
console.log('=== POLYMARKET LIQUIDATION MONITOR ===');
console.log('SOURCE: BINANCE FUTURES FORCE ORDER STREAM');
console.log('5M: LONG + SHORT | 15M: DISABLED | minimum size: 0 USDT/USDC');
console.log('ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
console.log('ALERT MODE: first liquidation per 5M period across ALL coins/directions; same coin is blocked until another coin alerts; current 5M market link');
scheduleFlush();
connect();
