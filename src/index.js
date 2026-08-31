const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';

// Binance 5M data is collected only as a source for the 15M decision.
// No 5M-period alerts are emitted. Every 15M window produces at most one
// alert for the coin with the largest liquidation notional in that window.
const ENABLE_5M = true;
const ENABLE_15M = true;
const ENABLE_5M_LONG = true;
const ENABLE_5M_SHORT = true;
const ENABLE_15M_LONG = true;
const ENABLE_15M_SHORT = true;
const ASSETS_5M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const ASSETS_15M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_SIZE = 0;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const RECONNECT_MS = 3000;

let windowStart5m = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
let windowStart15m = Math.floor(Date.now() / WINDOW_15M) * WINDOW_15M;
let largestLong5m = null;
let largestShort5m = null;
const totals15m = new Map();
let lastAlertAsset15m = null;
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
function nextMarketLink(asset, end, duration) {
  const nextStart = Math.ceil(end / duration) * duration;
  const minutes = duration === WINDOW_15M ? '15m' : '5m';
  return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${minutes}-${Math.floor(nextStart / 1000)}`;
}
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) });
    if (!response.ok) console.error('[Telegram] HTTP', response.status, await response.text());
    return response.ok;
  } catch (error) { console.error('[Telegram]', error?.message ?? error); return false; }
}
async function sendAlert(item, liquidationPeriodStart, liquidationPeriodEnd) {
  if (!item || item.notional < MIN_SIZE) return false;
  const lastAsset = lastAlertAsset15m;
  if (lastAsset === item.asset) { console.log(`Duplicate suppressed in 15M: ${item.asset} — waiting for a different asset alert`); return false; }
  const text = [`🚨 ${item.side} LIQUIDATION — 15M`, '', `${item.asset} — ${item.side} LIQUIDATION`, `💥 Size: ${money(item.notional, item.quote)}`, '', `▶️ NEXT ${item.asset} 5M UP/DOWN`, nextMarketLink(item.asset, liquidationPeriodEnd, WINDOW_5M)].join('\n');
  if (await sendTelegram(text)) { lastAlertAsset15m = item.asset; return true; }
  return false;
}
function clear5m() { largestLong5m = null; largestShort5m = null; }
function clear15m() { totals15m.clear(); }
async function emitWindow15m(start, end) {
  let best = null;
  for (const [asset, totals] of totals15m) {
    if (ENABLE_15M_LONG && totals.long > 0) {
      const candidate = { asset, quote: totals.quote, side: 'LONG', notional: totals.long };
      if (!best || candidate.notional > best.notional) best = candidate;
    }
    if (ENABLE_15M_SHORT && totals.short > 0) {
      const candidate = { asset, quote: totals.quote, side: 'SHORT', notional: totals.short };
      if (!best || candidate.notional > best.notional) best = candidate;
    }
  }
  clear15m();
  if (best) await sendAlert(best, start, end);
}
async function advanceWindows(now) {
  const target5 = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const target15 = Math.floor(now / WINDOW_15M) * WINDOW_15M;
  if (ENABLE_5M) while (windowStart5m < target5) {
    windowStart5m += WINDOW_5M;
    clear5m();
  }
  if (ENABLE_15M) while (windowStart15m < target15) {
    const start = windowStart15m;
    const end = start + WINDOW_15M;
    windowStart15m = end;
    await emitWindow15m(start, end);
  }
}
function requestAdvance(now) { advancing = advancing.then(() => advanceWindows(now)).catch(error => console.error('[Window]', error?.message ?? error)); return advancing; }
function scheduleFlush() {
  clearTimeout(flushTimer);
  const next = ENABLE_15M ? windowStart15m + WINDOW_15M : Infinity;
  flushTimer = setTimeout(async () => { await requestAdvance(Date.now()); if (!stopping) scheduleFlush(); }, Math.max(100, next - Date.now() + 50));
}
async function handleForceOrder(payload) {
  const order = payload?.o; if (!order) return;
  const side = String(order.S ?? '').toUpperCase(); if (side !== 'SELL' && side !== 'BUY') return;
  const parsed5 = parseSymbol(order.s, ASSETS_5M);
  const parsed15 = parseSymbol(order.s, ASSETS_15M);
  if (!parsed5 && !parsed15) return;
  const parsed = parsed15 || parsed5;
  const price = num(order.ap) || num(order.p);
  const quantity = num(order.q);
  const notional = Math.abs(price * quantity);
  if (!(price > 0) || !(quantity > 0) || notional < MIN_SIZE) return;
  const time = num(payload.E) || num(order.T) || Date.now();
  await requestAdvance(time);

  // We accept all configured coins and both liquidation directions on 5M,
  // but 5M is not an alert period. Its data is accumulated into the active
  // 15M bucket instead, so three 5M slices naturally form one 15M total.
  if (ENABLE_15M && parsed15) {
    const w = Math.floor(time / WINDOW_15M) * WINDOW_15M;
    if (w === windowStart15m) {
      const asset = parsed15.asset;
      let totals = totals15m.get(asset);
      if (!totals) {
        totals = { quote: parsed15.quote, long: 0, short: 0 };
        totals15m.set(asset, totals);
      }
      if (side === 'SELL' && ENABLE_15M_LONG) totals.long += notional;
      if (side === 'BUY' && ENABLE_15M_SHORT) totals.short += notional;
    }
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
    } catch (error) { console.error('[Parse]', error?.message ?? error); }
  });
  websocket.addEventListener('error', error => console.error('[WebSocket]', error?.message ?? error));
  websocket.addEventListener('close', () => { if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS); });
}
function shutdown(signal) { stopping = true; clearTimeout(flushTimer); clearTimeout(reconnectTimer); try { websocket?.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
console.log('=== POLYMARKET LIQUIDATION MONITOR ===');
console.log('SOURCE: BINANCE FUTURES FORCE ORDER STREAM');
console.log('5M: ALL COINS LONG + SHORT DATA SOURCE | NO 5M ALERTS');
console.log('15M: ALL COINS LONG + SHORT | ONE ALERT FOR LARGEST 15M LIQUIDATION');
console.log('ALERT LINK: NEXT 5M UP/DOWN | minimum size: 0 USDT/USDC');
console.log('Assets: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
scheduleFlush();
connect();
