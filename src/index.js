const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
const GAMMA_MARKET_URL = 'https://gamma-api.polymarket.com/markets/slug/';
const ASSETS = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const WINDOW_MS = 5 * 60 * 1000;
const RECONNECT_MS = 3000;

let windowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
let largest = null;
let flushTimer = null;
let websocket = null;
let reconnectTimer = null;
let stopping = false;
let advancing = Promise.resolve();

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

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

function formatMoney(value, quote) {
  return `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${quote}`;
}

function formatNumber(value) {
  return Number(value).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function sideLabel(side) {
  if (side === 'SELL') return 'LONG LIQUIDATION';
  if (side === 'BUY') return 'SHORT LIQUIDATION';
  return 'LIQUIDATION';
}

function tradeSignal(side) {
  if (side === 'SELL') return '🟢 BUY UP';
  if (side === 'BUY') return '🔴 BUY DOWN';
  return '';
}

function windowText(start, end) {
  const a = new Date(start).toISOString().slice(11, 16);
  const b = new Date(end).toISOString().slice(11, 16);
  return `${a}–${b} UTC`;
}

function nextMarketSlug(asset, windowEnd) {
  return `${asset.toLowerCase()}-updown-5m-${Math.floor(windowEnd / 1000)}`;
}

async function findNextMarket(asset, windowEnd) {
  const slug = nextMarketSlug(asset, windowEnd);
  const fallback = `https://polymarket.com/event/${slug}`;

  try {
    const response = await fetch(`${GAMMA_MARKET_URL}${encodeURIComponent(slug)}`, {
      headers: { accept: 'application/json' }
    });
    if (response.ok) {
      const market = await response.json();
      if (market?.slug && market?.active && !market?.closed) {
        return `https://polymarket.com/event/${market.slug}`;
      }
    }
  } catch (error) {
    console.error('Polymarket lookup error:', error?.message ?? error);
  }

  return fallback;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('TELEGRAM NOT CONFIGURED');
    console.log(text);
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false })
    });
    if (!response.ok) console.error('Telegram error:', await response.text());
  } catch (error) {
    console.error('Telegram request error:', error?.message ?? error);
  }
}

async function flushWindow(start, end, item) {
  if (!item) {
    console.log(`5m window ${windowText(start, end)}: no liquidation observed`);
    return;
  }

  const marketLink = await findNextMarket(item.asset, end);
  const message = [
    '🚨 LARGEST LIQUIDATION — 5M',
    '',
    `${item.asset} — ${sideLabel(item.side)}`,
    `${tradeSignal(item.side)}`,
    `💥 Size: ${formatMoney(item.notional, item.quote)}`,
    `Price: ${formatNumber(item.price)}`,
    `Qty: ${formatNumber(item.quantity)}`,
    `Window: ${windowText(start, end)}`,
    '',
    `▶️ NEXT 5M ${item.asset} UP/DOWN`,
    marketLink
  ].join('\n');

  console.log(message);
  await sendTelegram(message);
}

async function advanceWindows(now) {
  const targetStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;

  while (windowStart < targetStart) {
    const start = windowStart;
    const end = start + WINDOW_MS;
    const item = largest;
    largest = null;
    windowStart = end;
    await flushWindow(start, end, item);
  }
}

function requestAdvance(now) {
  advancing = advancing
    .then(() => advanceWindows(now))
    .catch(error => console.error('Window advance error:', error?.message ?? error));
  return advancing;
}

function scheduleFlush() {
  clearTimeout(flushTimer);
  const delay = Math.max(100, windowStart + WINDOW_MS - Date.now() + 50);
  flushTimer = setTimeout(async () => {
    await requestAdvance(Date.now());
    if (!stopping) scheduleFlush();
  }, delay);
}

async function handleForceOrder(payload) {
  const order = payload?.o;
  if (!order) return;

  const parsed = parseSymbol(order.s);
  if (!parsed) return;

  const price = num(order.ap) || num(order.p);
  const quantity = num(order.q);
  const notional = Math.abs(price * quantity);
  if (!(price > 0) || !(quantity > 0) || !(notional > 0)) return;

  const time = num(payload.E) || num(order.T) || Date.now();
  const eventWindow = Math.floor(time / WINDOW_MS) * WINDOW_MS;

  if (eventWindow > windowStart) await requestAdvance(time);
  if (eventWindow < windowStart || eventWindow >= windowStart + WINDOW_MS) return;

  const candidate = {
    asset: parsed.asset,
    quote: parsed.quote,
    side: String(order.S ?? '').toUpperCase(),
    price,
    quantity,
    notional,
    time
  };

  if (!largest || candidate.notional > largest.notional) {
    largest = candidate;
    console.log(`NEW 5M MAX: ${candidate.asset} ${formatMoney(candidate.notional, candidate.quote)} ${sideLabel(candidate.side)}`);
  }
}

function connect() {
  if (stopping) return;

  console.log('Connecting to Binance liquidation stream...');
  websocket = new WebSocket(BINANCE_WS_URL);

  websocket.addEventListener('open', () => console.log('Binance liquidation WebSocket connected'));

  websocket.addEventListener('message', event => {
    try {
      const payload = JSON.parse(String(event.data));
      if (payload?.e === 'forceOrder') void handleForceOrder(payload);
      else if (payload?.data?.e === 'forceOrder') void handleForceOrder(payload.data);
    } catch (error) {
      console.error('Liquidation message parse error:', error?.message ?? error);
    }
  });

  websocket.addEventListener('error', error => console.error('Binance WebSocket error:', error?.message ?? error));

  websocket.addEventListener('close', () => {
    if (stopping) return;
    console.error('Binance liquidation WebSocket closed; reconnecting in 3s');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
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
console.log('Quotes: USDT + USDC');
console.log('Logic: largest observed liquidation across all 7 assets per completed 5-minute UTC window');
console.log('Telegram: enabled when TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are present');

scheduleFlush();
connect();
