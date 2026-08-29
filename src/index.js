const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BINANCE_WS_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const GAMMA_URL = 'https://gamma-api.polymarket.com/events?';

const ASSETS = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTE_ASSETS = new Set(['USDT', 'USDC']);
const WINDOW_MS = 5 * 60 * 1000;

let currentWindowStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
let windowMax = null;
let flushTimer = null;

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatUsd(value, quote) {
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${quote}`;
}

function formatPrice(value) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function parseSymbol(symbol) {
  const match = String(symbol ?? '').toUpperCase().match(/^([A-Z]+)(USDT|USDC)$/);
  if (!match || !ASSETS.has(match[1]) || !QUOTE_ASSETS.has(match[2])) return null;
  return { asset: match[1], quote: match[2] };
}

function liquidationNotional(order) {
  const price = number(order?.ap) || number(order?.p);
  const quantity = number(order?.q);
  return Math.abs(price * quantity);
}

function sideText(side) {
  if (side === 'SELL') return 'LONG LIQUIDATION';
  if (side === 'BUY') return 'SHORT LIQUIDATION';
  return 'LIQUIDATION';
}

function nextFiveMinuteSlug(asset, windowEndMs) {
  const nextStart = Math.floor(windowEndMs / WINDOW_MS) * 300;
  return `${asset.toLowerCase()}-updown-5m-${nextStart}`;
}

async function resolveMarketLink(asset, windowEndMs) {
  const slug = nextFiveMinuteSlug(asset, windowEndMs);
  const fallback = `https://polymarket.com/event/${slug}`;

  try {
    const url = `${GAMMA_URL}series_slug=${encodeURIComponent(`${asset.toLowerCase()}-up-or-down-5m`)}&closed=false&limit=100&order=endDate&ascending=true`;
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) return fallback;

    const data = await response.json();
    const events = Array.isArray(data) ? data : [];
    const targetStart = windowEndMs;
    const event = events.find(item => item?.slug === slug) || events.find(item => {
      const start = Date.parse(item?.eventStartTime || item?.startTime || '');
      return item?.slug?.startsWith(`${asset.toLowerCase()}-updown-5m-`) && start === targetStart;
    });

    if (event?.slug) return `https://polymarket.com/event/${event.slug}`;
  } catch (error) {
    console.error('Polymarket market lookup failed:', error?.message ?? error);
  }

  return fallback;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(text);
    return false;
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false })
  });

  if (!response.ok) {
    console.error('Telegram error:', await response.text());
    return false;
  }
  return true;
}

function windowLabel(startMs, endMs) {
  const start = new Date(startMs).toISOString().slice(11, 16);
  const end = new Date(endMs).toISOString().slice(11, 16);
  return `${start}–${end} UTC`;
}

async function flushWindow(windowStart, windowEnd, maxLiquidation) {
  if (!maxLiquidation) {
    console.log(`5m window ${windowLabel(windowStart, windowEnd)}: no liquidations`);
    return;
  }

  const marketLink = await resolveMarketLink(maxLiquidation.asset, windowEnd);
  const liquidationTime = new Date(maxLiquidation.time).toISOString().replace('T', ' ').replace('.000Z', ' UTC');

  const message = [
    '🚨 LARGEST LIQUIDATION — 5M',
    '',
    `${maxLiquidation.asset} — ${sideText(maxLiquidation.side)}`,
    `💥 Size: ${formatUsd(maxLiquidation.notional, maxLiquidation.quote)}`,
    `Price: ${formatPrice(maxLiquidation.price)}`,
    `Qty: ${maxLiquidation.quantity.toLocaleString('en-US', { maximumFractionDigits: 8 })}`,
    `Source: Binance USDⓈ-M Futures`,
    `Liquidation time: ${liquidationTime}`,
    `Window: ${windowLabel(windowStart, windowEnd)}`,
    '',
    `▶️ Next 5m ${maxLiquidation.asset} Up/Down:`,
    marketLink
  ].join('\n');

  await sendTelegram(message);
}

async function flushCurrentWindow() {
  const windowStart = currentWindowStart;
  const windowEnd = windowStart + WINDOW_MS;
  const max = windowMax;
  currentWindowStart = windowEnd;
  windowMax = null;
  await flushWindow(windowStart, windowEnd, max);
}

function scheduleWindowFlush() {
  clearTimeout(flushTimer);
  const delay = Math.max(100, currentWindowStart + WINDOW_MS - Date.now() + 100);
  flushTimer = setTimeout(async () => {
    try {
      await flushCurrentWindow();
    } catch (error) {
      console.error('5m window flush error:', error?.message ?? error);
    } finally {
      scheduleWindowFlush();
    }
  }, delay);
}

function handleLiquidation(event) {
  const order = event?.o;
  if (!order) return;

  const parsed = parseSymbol(order.s);
  if (!parsed) return;

  const notional = liquidationNotional(order);
  if (!(notional > 0)) return;

  const eventTime = number(event?.E) || Date.now();
  const eventWindowStart = Math.floor(eventTime / WINDOW_MS) * WINDOW_MS;
  if (eventWindowStart < currentWindowStart) return;

  while (eventWindowStart > currentWindowStart) {
    void flushCurrentWindow().catch(error => console.error('Late window flush error:', error?.message ?? error));
  }

  const price = number(order.ap) || number(order.p);
  const quantity = number(order.q);
  const side = String(order.S ?? '').toUpperCase();

  const candidate = {
    asset: parsed.asset,
    quote: parsed.quote,
    symbol: String(order.s).toUpperCase(),
    notional,
    price,
    quantity,
    side,
    time: eventTime
  };

  if (!windowMax || candidate.notional > windowMax.notional) windowMax = candidate;
}

function connect() {
  console.log('LIQUIDATION MONITOR STARTING');
  console.log('Source: Binance USDⓈ-M Futures forceOrder stream');
  console.log('Assets: BTC ETH XRP SOL DOGE HYPE BNB');
  console.log('Quotes: USDT USDC');
  console.log('Logic: ONE largest observed liquidation across all 7 assets per completed 5-minute UTC window');
  console.log('Order Book / Price / OI / Funding / Volume alerts: DISABLED');
  console.log('Telegram start alert: DISABLED');

  const ws = new WebSocket(BINANCE_WS_URL);
  let reconnectTimer;

  ws.addEventListener('open', () => console.log('Binance liquidation WebSocket connected'));

  ws.addEventListener('message', message => {
    try {
      const payload = JSON.parse(String(message.data));
      if (payload?.e === 'forceOrder' || payload?.e === '!forceOrder@arr') handleLiquidation(payload);
      else if (payload?.data?.e === 'forceOrder') handleLiquidation(payload.data);
    } catch (error) {
      console.error('Liquidation event parse error:', error?.message ?? error);
    }
  });

  ws.addEventListener('error', error => console.error('Binance WebSocket error:', error?.message ?? error));

  ws.addEventListener('close', () => {
    console.error('Binance WebSocket closed; reconnecting in 3s');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  });
}

scheduleWindowFlush();
connect();
