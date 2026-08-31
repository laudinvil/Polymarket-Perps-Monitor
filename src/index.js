const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';

const ENABLE_5M = true;
const ENABLE_15M = true;
const ASSETS_5M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const ASSETS_15M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_SIZE = 10;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const RECONNECT_MS = 3000;

let windowStart5m = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
let windowStart15m = Math.floor(Date.now() / WINDOW_15M) * WINDOW_15M;
let largestLong5m = null;
let largestShort5m = null;
let largestLong15m = null;
let largestShort15m = null;
let lastAlertAsset5m = null;
let lastAlertAsset15m = null;
let flushTimer = null;
let websocket = null;
let reconnectTimer = null;
let stopping = false;
let advancing = Promise.resolve();

function num(v) {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
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

function money(v, quote) {
  return `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${quote}`;
}

function nextMarketLink(asset, end, duration) {
  const nextStart = Math.ceil(end / duration) * duration;
  const minutes = duration === WINDOW_15M ? '15m' : '5m';
  return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${minutes}-${Math.floor(nextStart / 1000)}`;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
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

async function sendAlert(period, item, start, end) {
  if (!item || item.notional < MIN_SIZE) return;
  const is15 = period === '15M';
  if (is15 ? !ENABLE_15M : !ENABLE_5M) return;

  const last = is15 ? lastAlertAsset15m : lastAlertAsset5m;
  if (last === item.asset) {
    console.log(`Duplicate suppressed: ${item.asset} ${period} — waiting for a different asset alert`);
    return;
  }

  const text = [
    `🚨 ${item.side} LIQUIDATION — ${period}`,
    '',
    `${item.asset} — ${item.side} LIQUIDATION`,
    `💥 Size: ${money(item.notional, item.quote)}`,
    '',
    `▶️ NEXT ${item.asset} ${period} UP/DOWN`,
    nextMarketLink(item.asset, end, is15 ? WINDOW_15M : WINDOW_5M)
  ].join('\n');

  if (await sendTelegram(text)) {
    if (is15) lastAlertAsset15m = item.asset;
    else lastAlertAsset5m = item.asset;
  }
}

function clearWindowState(period) {
  if (period === '5M') {
    largestLong5m = null;
    largestShort5m = null;
  } else {
    largestLong15m = null;
    largestShort15m = null;
  }
}

async function emitWindow(period, start, end) {
  const is15 = period === '15M';
  const longItem = is15 ? largestLong15m : largestLong5m;
  const shortItem = is15 ? largestShort15m : largestShort5m;
  clearWindowState(period);

  // One alert per completed window: whichever side had the larger liquidation.
  if (!longItem && !shortItem) return;
  if (longItem && shortItem) {
    if (longItem.notional > shortItem.notional) {
      await sendAlert(period, { ...longItem, side: 'LONG' }, start, end);
    } else if (shortItem.notional > longItem.notional) {
      await sendAlert(period, { ...shortItem, side: 'SHORT' }, start, end);
    }
    return;
  }

  if (longItem) await sendAlert(period, { ...longItem, side: 'LONG' }, start, end);
  else if (shortItem) await sendAlert(period, { ...shortItem, side: 'SHORT' }, start, end);
}

async function advanceWindows(now) {
  const target5 = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const target15 = Math.floor(now / WINDOW_15M) * WINDOW_15M;

  if (ENABLE_5M) {
    while (windowStart5m < target5) {
      const start = windowStart5m;
      const end = start + WINDOW_5M;
      windowStart5m = end;
      await emitWindow('5M', start, end);
    }
  }

  if (ENABLE_15M) {
    while (windowStart15m < target15) {
      const start = windowStart15m;
      const end = start + WINDOW_15M;
      windowStart15m = end;
      await emitWindow('15M', start, end);
    }
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
  const next = Math.min(
    ENABLE_5M ? windowStart5m + WINDOW_5M : Infinity,
    ENABLE_15M ? windowStart15m + WINDOW_15M : Infinity
  );
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

  const parsed5 = parseSymbol(order.s, ASSETS_5M);
  const parsed15 = parseSymbol(order.s, ASSETS_15M);
  if (!parsed5 && !parsed15) return;

  const price = num(order.ap) || num(order.p);
  const quantity = num(order.q);
  const notional = Math.abs(price * quantity);
  if (!(price > 0) || !(quantity > 0) || notional < MIN_SIZE) return;

  const time = num(payload.E) || num(order.T) || Date.now();
  await requestAdvance(time);

  const item = {
    asset: (parsed5 || parsed15).asset,
    quote: (parsed5 || parsed15).quote,
    price,
    quantity,
    notional
  };

  if (ENABLE_5M && parsed5) {
    const w = Math.floor(time / WINDOW_5M) * WINDOW_5M;
    if (w === windowStart5m) {
      if (side === 'SELL' && (!largestLong5m || notional > largestLong5m.notional)) largestLong5m = item;
      if (side === 'BUY' && (!largestShort5m || notional > largestShort5m.notional)) largestShort5m = item;
    }
  }

  if (ENABLE_15M && parsed15) {
    const w = Math.floor(time / WINDOW_15M) * WINDOW_15M;
    if (w === windowStart15m) {
      if (side === 'SELL' && (!largestLong15m || notional > largestLong15m.notional)) largestLong15m = item;
      if (side === 'BUY' && (!largestShort15m || notional > largestShort15m.notional)) largestShort15m = item;
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
console.log('5M: ENABLED | 15M: ENABLED | minimum size: 10 USDT/USDC');
console.log('LONG + SHORT enabled independently for both timeframes');
console.log('Assets: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
console.log('One alert per completed window: larger LONG/SHORT liquidation wins');
console.log('Sequential duplicate suppression is independent per timeframe');
console.log('Polymarket link: next market only, one link per alert');

scheduleFlush();
connect();
