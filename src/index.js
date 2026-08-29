const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BINANCE_WS_URL = 'wss://fstream.binance.com/ws/!forceOrder@arr';
const GAMMA_URL = 'https://gamma-api.polymarket.com/events?slug=';
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS ?? 0);

const ASSETS = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const lastAlertAt = new Map();

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatUsd(value, asset = '') {
  const digits = value >= 100000 ? 0 : value >= 1000 ? 0 : 2;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}${asset ? ` ${asset}` : ''}`;
}

function assetFromSymbol(symbol) {
  const match = String(symbol ?? '').match(/^([A-Z]+)USDT$/);
  return match?.[1] ?? '';
}

function liquidationNotional(order) {
  const avgPrice = number(order?.ap) || number(order?.p);
  const quantity = number(order?.q);
  return Math.abs(avgPrice * quantity);
}

function nextFiveMinuteSlug(asset, timestampMs) {
  const nextStart = (Math.floor(timestampMs / 300000) + 1) * 300;
  return `${asset.toLowerCase()}-updown-5m-${nextStart}`;
}

async function resolveMarketLink(asset, timestampMs) {
  const slug = nextFiveMinuteSlug(asset, timestampMs);
  const fallback = `https://polymarket.com/event/${slug}`;

  try {
    const response = await fetch(`${GAMMA_URL}${encodeURIComponent(slug)}`, {
      headers: { 'accept': 'application/json' }
    });
    if (!response.ok) return fallback;

    const data = await response.json();
    const event = Array.isArray(data) ? data[0] : data;
    if (event?.slug) return `https://polymarket.com/event/${event.slug}`;
  } catch (error) {
    console.error('Polymarket market lookup failed:', error?.message ?? error);
  }

  return fallback;
}

function sideText(side) {
  if (side === 'SELL') return 'LONG LIQUIDATION';
  if (side === 'BUY') return 'SHORT LIQUIDATION';
  return 'LIQUIDATION';
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(text);
    return false;
  }

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false
    })
  });

  if (!response.ok) {
    console.error('Telegram error:', await response.text());
    return false;
  }
  return true;
}

async function handleLiquidation(event) {
  const order = event?.o;
  if (!order) return;

  const symbol = String(order.s ?? '').toUpperCase();
  const asset = assetFromSymbol(symbol);
  if (!ASSETS.has(asset)) return;

  const notional = liquidationNotional(order);
  if (!(notional > 0)) return;

  const eventTime = number(event?.E) || Date.now();
  const cooldownKey = asset;
  const now = Date.now();
  if (ALERT_COOLDOWN_MS > 0 && (lastAlertAt.get(cooldownKey) ?? 0) + ALERT_COOLDOWN_MS > now) {
    return;
  }

  // Binance's public forceOrder stream reports the largest liquidation order
  // seen for each symbol within a 1000 ms window. We forward that event as-is.
  const marketLink = await resolveMarketLink(asset, eventTime);
  const side = String(order.S ?? '').toUpperCase();
  const liquidationTime = new Date(eventTime).toISOString().replace('T', ' ').replace('.000Z', ' UTC');
  const price = number(order.ap) || number(order.p);
  const quantity = number(order.q);

  const message = [
    '🚨 LIQUIDATION',
    '',
    `${asset} — ${sideText(side)}`,
    `💥 Size: ${formatUsd(notional, 'USDT')}`,
    `Price: ${price.toLocaleString('en-US', { maximumFractionDigits: 8 })}`,
    `Qty: ${quantity.toLocaleString('en-US', { maximumFractionDigits: 8 })}`,
    'Source: Binance Futures',
    `Time: ${liquidationTime}`,
    '',
    `▶️ Next 5m ${asset} Up/Down:`,
    marketLink
  ].join('\n');

  const sent = await sendTelegram(message);
  if (sent || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    lastAlertAt.set(cooldownKey, now);
  }
}

function connect() {
  console.log('LIQUIDATION MONITOR STARTING');
  console.log('Source: Binance USDⓈ-M Futures forceOrder stream');
  console.log('Assets: BTC ETH XRP SOL DOGE HYPE BNB');
  console.log('Old alerts: DISABLED');
  console.log('Polymarket Order Book: DISABLED');
  console.log('Telegram start alert: DISABLED');

  const ws = new WebSocket(BINANCE_WS_URL);
  let reconnectTimer;

  ws.addEventListener('open', () => {
    console.log('Binance liquidation WebSocket connected');
  });

  ws.addEventListener('message', async (message) => {
    try {
      const event = JSON.parse(String(message.data));
      if (event?.e === 'forceOrder') {
        await handleLiquidation(event);
        return;
      }
      if (event?.e === '!forceOrder@arr' && event?.o) {
        await handleLiquidation(event);
        return;
      }
      if (event?.data?.e === 'forceOrder') {
        await handleLiquidation(event.data);
      }
    } catch (error) {
      console.error('Liquidation event parse/handle error:', error?.message ?? error);
    }
  });

  ws.addEventListener('error', (error) => {
    console.error('Binance WebSocket error:', error?.message ?? error);
  });

  ws.addEventListener('close', () => {
    console.error('Binance WebSocket closed; reconnecting in 3s');
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  });
}

connect();
