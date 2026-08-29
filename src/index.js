const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
const GAMMA_API = 'https://gamma-api.polymarket.com/markets';
const ASSETS = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const WINDOW_MS = 5 * 60 * 1000;
const RECONNECT_MS = 3000;

let windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
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

// Find the REAL next 5m Polymarket Up/Down event. Do not manufacture a slug.
async function findNextFiveMinuteMarket(asset, windowEnd) {
  const nextStart = Math.floor(windowEnd / WINDOW_MS) * WINDOW_MS;
  const nextEnd = nextStart + WINDOW_MS;
  const startSec = Math.floor(nextStart / 1000);
  const endSec = Math.floor(nextEnd / 1000);

  const params = new URLSearchParams({
    active: 'true',
    closed: 'false',
    limit: '100',
    order: 'startDate',
    ascending: 'true'
  });

  try {
    const r = await fetch(`${GAMMA_API}?${params}`, { headers: { accept: 'application/json' } });
    if (!r.ok) return null;
    const markets = await r.json();
    if (!Array.isArray(markets)) return null;

    const assetUpper = asset.toUpperCase();
    for (const market of markets) {
      const text = `${market.slug ?? ''} ${market.question ?? ''} ${market.title ?? ''}`.toUpperCase();
      if (!text.includes(assetUpper) || !text.includes('5M')) continue;
      if (!text.includes('UP') || !text.includes('DOWN')) continue;

      const start = Date.parse(market.startDate ?? market.start_date ?? '') / 1000;
      const end = Date.parse(market.endDate ?? market.end_date ?? '') / 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (Math.abs(start - startSec) > 30 || Math.abs(end - endSec) > 30) continue;
      if (!market.slug) continue;

      return `https://polymarket.com/event/${market.slug}`;
    }
  } catch (error) {
    console.error('Polymarket market lookup:', error?.message ?? error);
  }
  return null;
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

  const marketLink = await findNextFiveMinuteMarket(item.asset, end);
  const lines = [
    '🚨 LARGEST LONG LIQUIDATION — 5M',
    '',
    `${item.asset} — LONG LIQUIDATION`,
    `💥 Size: ${money(item.notional, item.quote)}`,
    `Price: ${item.price}`,
    `Qty: ${item.quantity}`,
    `Window: ${windowText(start, end)}`,
    ''
  ];

  if (marketLink) {
    lines.push(`▶️ NEXT ${item.asset} 5M UP/DOWN`, marketLink);
  } else {
    lines.push(`▶️ NEXT ${item.asset} 5M UP/DOWN`, 'Market link not found — no guessed URL sent');
  }

  await sendTelegram(lines.join('\n'));
}

async function advanceWindows(now) {
  const target = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  while (windowStart < target) {
    const start = windowStart;
    const end = start + WINDOW_MS;
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
  }, Math.max(100, windowStart + WINDOW_MS - Date.now() + 50));
}

async function handleForceOrder(payload) {
  const order = payload?.o;
  if (!order) return;
  const parsed = parseSymbol(order.s);
  if (!parsed || !isLongLiquidation(order.S)) return;

  const price = num(order.ap) || num(order.p);
  const quantity = num(order.q);
  const notional = Math.abs(price * quantity);
  if (!(price > 0) || !(quantity > 0)) return;

  const time = num(payload.E) || num(order.T) || Date.now();
  const eventWindow = Math.floor(time / WINDOW_MS) * WINDOW_MS;
  if (eventWindow > windowStart) await requestAdvance(time);
  if (eventWindow < windowStart || eventWindow >= windowStart + WINDOW_MS) return;

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
console.log('LONG liquidations only; no minimum size');
console.log('One largest LONG liquidation per completed 5-minute UTC window');
console.log('Link target: NEXT 5-minute Polymarket Up/Down market');

scheduleFlush();
connect();
