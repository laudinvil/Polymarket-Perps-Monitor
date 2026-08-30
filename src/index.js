const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
const ASSETS = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_LIQUIDATION = 600;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const RECONNECT_MS = 3000;

let windowStart = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
let largest = null;
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

function money(value, quote) {
  return `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${quote}`;
}

function windowText(start, end) {
  return `${new Date(start).toISOString().slice(11, 16)}–${new Date(end).toISOString().slice(11, 16)} UTC`;
}

// Polymarket recurring crypto markets use deterministic UTC epoch slugs.
// The link is derived from the NEXT market interval; it is not gated on an API lookup.
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

async function flushWindow(start, end, item) {
  if (!item) return;

  const next5m = nextMarketLink(item.asset, end, WINDOW_5M);
  const next15m = nextMarketLink(item.asset, end, WINDOW_15M);
  const lines = [
    '🚨 LARGEST LONG LIQUIDATION — 5M',
    '',
    `${item.asset} — LONG LIQUIDATION`,
    `💥 Size: ${money(item.notional, item.quote)}`,
    `Price: ${item.price}`,
    `Qty: ${item.quantity}`,
    `Window: ${windowText(start, end)}`,
    '',
    `▶️ NEXT ${item.asset} 5M UP/DOWN`,
    next5m,
    '',
    `▶️ NEXT ${item.asset} 15M UP/DOWN`,
    next15m
  ];

  await sendTelegram(lines.join('\n'));
}

async function advanceWindows(now) {
  const target = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  while (windowStart < target) {
    const start = windowStart;
    const end = start + WINDOW_5M;
    const item = largest;
    largest = null;
    windowStart = end;
    await flushWindow(start, end, item);
  }
}

function requestAdvance(now) {
  advancing = advancing.then(() => advanceWindows(now)).catch(e => console.error('Window:', e?.message ?? e));
  return advancing;
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(async () => {
    await requestAdvance(Date.now());
    if (!stopping) scheduleFlush();
  }, Math.max(100, windowStart + WINDOW_5M - Date.now() + 50));
}

async function handleForceOrder(payload) {
  const order = payload?.o;
  if (!order) return;
  const parsed = parseSymbol(order.s);
  if (!parsed || !isLongLiquidation(order.S)) return;

  const price = num(order.ap) || num(order.p);
  const quantity = num(order.q);
  const notional = Math.abs(price * quantity);
  if (!(price > 0) || !(quantity > 0) || notional < MIN_LIQUIDATION) return;

  const time = num(payload.E) || num(order.T) || Date.now();
  const eventWindow = Math.floor(time / WINDOW_5M) * WINDOW_5M;
  if (eventWindow > windowStart) await requestAdvance(time);
  if (eventWindow < windowStart || eventWindow >= windowStart + WINDOW_5M) return;

  const candidate = { asset: parsed.asset, quote: parsed.quote, price, quantity, notional };
  if (!largest || candidate.notional > largest.notional) largest = candidate;
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
console.log(`LONG liquidations only; minimum ${MIN_LIQUIDATION} USDT/USDC`);
console.log('One largest LONG liquidation per completed 5-minute UTC window');
console.log('Alert links: NEXT 5-minute + NEXT 15-minute Polymarket Up/Down markets');

scheduleFlush();
connect();
