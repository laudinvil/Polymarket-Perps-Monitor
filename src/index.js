const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';

const ENABLE_5M = true;
const ENABLE_15M = true;
const ENABLE_5M_LONG = true;
const ENABLE_5M_SHORT = true;
const ENABLE_15M_LONG = true;
const ENABLE_15M_SHORT = true;
const ASSETS_5M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const ASSETS_15M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_SIZE = 1000000;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const RECONNECT_MS = 3000;

let websocket = null;
let reconnectTimer = null;
let stopping = false;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

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

function money(value, quote) {
  return `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${quote}`;
}

function nextMarketLink(asset, eventTime, duration) {
  const nextStart = Math.floor(eventTime / duration) * duration + duration;
  const minutes = duration === WINDOW_15M ? '15m' : '5m';
  return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${minutes}-${Math.floor(nextStart / 1000)}`;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[Telegram] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
    return false;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: false
      })
    });
    if (!response.ok) console.error('[Telegram] HTTP', response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error('[Telegram]', error?.message ?? error);
    return false;
  }
}

function sideFromOrder(side) {
  // Binance liquidation force-order: SELL means a long position was liquidated;
  // BUY means a short position was liquidated.
  if (side === 'SELL') return 'LONG';
  if (side === 'BUY') return 'SHORT';
  return null;
}

async function sendLiquidationAlert(period, item, eventTime) {
  const is5m = period === '5M';
  if (is5m ? !ENABLE_5M : !ENABLE_15M) return false;
  if (item.side === 'LONG' && (is5m ? !ENABLE_5M_LONG : !ENABLE_15M_LONG)) return false;
  if (item.side === 'SHORT' && (is5m ? !ENABLE_5M_SHORT : !ENABLE_15M_SHORT)) return false;
  if (item.notional < MIN_SIZE) return false;

  const text = [
    `🚨 ${item.side} LIQUIDATION — ${period}`,
    '',
    `${item.asset} — ${item.side} LIQUIDATION`,
    `💥 Size: ${money(item.notional, item.quote)}`,
    '',
    `▶️ NEXT ${item.asset} ${period} UP/DOWN`,
    nextMarketLink(item.asset, eventTime, is5m ? WINDOW_5M : WINDOW_15M)
  ].join('\n');

  return sendTelegram(text);
}

async function handleForceOrder(payload) {
  const order = payload?.o;
  if (!order) return;

  const orderSide = String(order.S ?? '').toUpperCase();
  const liquidationSide = sideFromOrder(orderSide);
  if (!liquidationSide) return;

  const parsed5 = parseSymbol(order.s, ASSETS_5M);
  const parsed15 = parseSymbol(order.s, ASSETS_15M);
  if (!parsed5 && !parsed15) return;

  const parsed = parsed5 || parsed15;
  const price = num(order.ap) || num(order.p);
  const quantity = num(order.q);
  const notional = Math.abs(price * quantity);
  if (!(price > 0) || !(quantity > 0) || notional < MIN_SIZE) return;

  const eventTime = num(payload.E) || num(order.T) || Date.now();
  const item = {
    asset: parsed.asset,
    quote: parsed.quote,
    price,
    quantity,
    notional,
    side: liquidationSide
  };

  // Every liquidation >= MIN_SIZE generates its own alert.
  // 5M and 15M are independent alert streams; no aggregation,
  // largest-per-period selection, or cross-timeframe suppression.
  const alerts = [];
  if (ENABLE_5M && parsed5) alerts.push(sendLiquidationAlert('5M', item, eventTime));
  if (ENABLE_15M && parsed15) alerts.push(sendLiquidationAlert('15M', item, eventTime));
  if (alerts.length) await Promise.allSettled(alerts);
}

function connect() {
  if (stopping) return;

  websocket = new WebSocket(BINANCE_WS_URL);

  websocket.addEventListener('open', () => {
    console.log('Binance liquidation stream connected');
    console.log('5M: LONG + SHORT | 15M: LONG + SHORT | MIN SIZE: 1000000 USDT/USDC');
    console.log('5M assets: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
    console.log('15M assets: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
    console.log('ALERT MODE: every liquidation >= MIN SIZE, independently for 5M and 15M');
  });

  websocket.addEventListener('message', event => {
    try {
      const payload = JSON.parse(String(event.data));
      if (payload?.e === 'forceOrder') void handleForceOrder(payload);
      else if (payload?.data?.e === 'forceOrder') void handleForceOrder(payload.data);
    } catch (error) {
      console.error('[Parse]', error?.message ?? error);
    }
  });

  websocket.addEventListener('error', error => {
    console.error('[WebSocket]', error?.message ?? error);
  });

  websocket.addEventListener('close', () => {
    if (!stopping) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    }
  });
}

function shutdown(signal) {
  stopping = true;
  clearTimeout(reconnectTimer);
  try { websocket?.close(); } catch {}
  console.log(`Shutdown: ${signal}`);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('=== POLYMARKET LIQUIDATION MONITOR ===');
console.log('SOURCE: BINANCE FUTURES FORCE ORDER STREAM');
connect();
