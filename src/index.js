const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
const ASSETS = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_LONG_5M = 600;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const RECONNECT_MS = 3000;

let windowStart5m = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
let windowStart15m = Math.floor(Date.now() / WINDOW_15M) * WINDOW_15M;
let largestLong5m = null;
let largestShort15m = null;
let flushTimer;
let websocket;
let reconnectTimer;
let stopping = false;
let advancing = Promise.resolve();

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;

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

function isLongLiquidation(side) {
  return String(side ?? '').toUpperCase() === 'SELL';
}

function isShortLiquidation(side) {
  return String(side ?? '').toUpperCase() === 'BUY';
}

function money(value, quote) {
  return `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${quote}`;
}

function windowText(start, end) {
  return `${new Date(start).toISOString().slice(11, 16)}–${new Date(end).toISOString().slice(11, 16)} UTC`;
}

function nextMarketLink(asset, windowEnd, durationMs) {
  const nextStart = Math.ceil(windowEnd / durationMs) * durationMs;
  const minutes = durationMs === WINDOW_15M ? '15m' : '5m';
  const slug = `${asset.toLowerCase()}-updown-${minutes}-${Math.floor(nextStart / 1000)}`;
  return `https://polymarket.com/event/${slug}`;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false })
    });
  } catch (error) {
    console.error('Telegram:', error?.message ?? error);
  }
}

async function flush5m(start, end, item) {
  if (!item) return;
  const link = nextMarketLink(item.asset, end, WINDOW_5M);
  const text = [
    '🚨 LARGEST LONG LIQUIDATION — 5M',
    '',
    `${item.asset} — LONG LIQUIDATION`,
    `💥 Size: ${money(item.notional, item.quote)}`,
    `Price: ${item.price}`,
    `Qty: ${item.quantity}`,
    `Window: ${windowText(start, end)}`,
    '',
    `▶️ NEXT ${item.asset} 5M UP/DOWN`,
    link
  ].join('\n');
  await sendTelegram(text);
}

async function flush15m(start, end, item) {
  if (!item) return;
  const link = nextMarketLink(item.asset, end, WINDOW_15M);
  const text = [
    '🚨 LARGEST SHORT LIQUIDATION — 15M',
    '',
    `${item.asset} — SHORT LIQUIDATION`,
    `💥 Size: ${money(item.notional, item.quote)}`,
    `Price: ${item.price}`,
    `Qty: ${item.quantity}`,
    `Window: ${windowText(start, end)}`,
    '',
    `▶️ NEXT ${item.asset} 15M UP/DOWN`,
    link
  ].join('\n');
  await sendTelegram(text);
}

async function advanceWindows(now) {
  const target5m = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const target15m = Math.floor(now / WINDOW_15M) * WINDOW_15M;

  while (windowStart5m < target5m) {
    const start = windowStart5m;
    const end = start + WINDOW_5M;
    const item = largestLong5m;
    largestLong5m = null;
    windowStart5m = end;
    await flush5m(start, end, item);
  }

  while (windowStart15m < target15m) {
    const start = windowStart15m;
    const end = start + WINDOW_15M;
    const item = largestShort15m;
    largestShort15m = null;
    windowStart15m = end;
    await flush15m(start, end, item);
  }
}

function requestAdvance(now) {
  advancing = advancing.then(() => advanceWindows(now)).catch(e => console.error('Window:', e?.message ?? e));
  return advancing;
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  const next5 = windowStart5m + WINDOW_5M;
  const next15 = windowStart15m + WINDOW_15M;
  const next = Math.min(next5, next15);
  flushTimer = setTimeout(async () => {
    await requestAdvance(Date.now());
    if (!stopping) scheduleFlush();
  }, Math.max(100, next - Date.now() + 50));
}

async function handleForceOrder(payload) {
  const order = payload?.o;
  if (!order) return;
  const parsed = parseSymbol(order.s);
  if (!parsed) return;

  const price = num(order.ap) || num(order.p);
  const quantity = num(order.q);
  const notional = Math.abs(price * quantity);
  if (!(price > 0) || !(quantity > 0)) return;

  const time = num(payload.E) || num(order.T) || Date.now();
  await requestAdvance(time);

  const side = String(order.S ?? '').toUpperCase();

  // 5M: LONG only, minimum 600 USDT/USDC.
  if (isLongLiquidation(side) && notional >= MIN_LONG_5M) {
    const eventWindow5m = Math.floor(time / WINDOW_5M) * WINDOW_5M;
    if (eventWindow5m === windowStart5m) {
      const candidate = { asset: parsed.asset, quote: parsed.quote, price, quantity, notional };
      if (!largestLong5m || candidate.notional > largestLong5m.notional) largestLong5m = candidate;
    }
  }

  // 15M: SHORT only, NO minimum size.
  if (isShortLiquidation(side)) {
    const eventWindow15m = Math.floor(time / WINDOW_15M) * WINDOW_15M;
    if (eventWindow15m === windowStart15m) {
      const candidate = { asset: parsed.asset, quote: parsed.quote, price, quantity, notional };
      if (!largestShort15m || candidate.notional > largestShort15m.notional) largestShort15m = candidate;
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
    } catch (e) { console.error('Parse:', e?.message ?? e); }
  });
  websocket.addEventListener('error', e => console.error('WebSocket:', e?.message ?? e));
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
console.log('Assets: BTC ETH XRP SOL DOGE HYPE BNB');
console.log(`5M: LONG only, minimum ${MIN_LONG_5M} USDT/USDC`);
console.log('15M: SHORT only, no minimum');
console.log('5M and 15M alerts are independent and each has one link only');
console.log('Links target the NEXT Polymarket Up/Down market for that timeframe');

scheduleFlush();
connect();
