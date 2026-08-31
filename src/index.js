const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';

const ENABLE_5M = true;
const ENABLE_15M = true;
const ENABLE_5M_SHORT = false;
const ENABLE_15M_SHORT = true;
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
let totalLong15m = 0;
let totalShort15m = 0;
let totalLong15mItem = null;
let totalShort15mItem = null;
let lastAlertAsset5m = null;
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
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false })
    });
    if (!response.ok) console.error('[Telegram] HTTP', response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error('[Telegram]', error?.message ?? error);
    return false;
  }
}

async function sendAlert(period, item, start, end) {
  if (!item || item.notional < MIN_SIZE) return false;
  const is15 = period === '15M';
  if (is15 ? !ENABLE_15M : !ENABLE_5M) return false;
  if (item.side === 'SHORT' && (is15 ? !ENABLE_15M_SHORT : !ENABLE_5M_SHORT)) return false;

  // 5M and 15M are independent alert streams. A 5M alert must NOT suppress
  // the 15M aggregate alert, because every liquidation contributes to 15M.
  const lastAsset = is15 ? lastAlertAsset15m : lastAlertAsset5m;
  if (lastAsset === item.asset) {
    console.log(`Duplicate suppressed in ${period}: ${item.asset} — waiting for a different asset alert`);
    return false;
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
    return true;
  }
  return false;
}

function clearWindowState(period) {
  if (period === '5M') {
    largestLong5m = null;
    largestShort5m = null;
  } else {
    totalLong15m = 0;
    totalShort15m = 0;
    totalLong15mItem = null;
    totalShort15mItem = null;
  }
}

async function emitWindow(period, start, end) {
  if (period === '5M') {
    const longItem = largestLong5m;
    const shortItem = largestShort5m;
    clearWindowState('5M');

    if (!longItem && !shortItem) return;
    if (longItem && shortItem) {
      if (longItem.notional > shortItem.notional) await sendAlert('5M', { ...longItem, side: 'LONG' }, start, end);
      else if (shortItem.notional > longItem.notional) await sendAlert('5M', { ...shortItem, side: 'SHORT' }, start, end);
      return;
    }
    if (longItem) await sendAlert('5M', { ...longItem, side: 'LONG' }, start, end);
    else await sendAlert('5M', { ...shortItem, side: 'SHORT' }, start, end);
    return;
  }

  // 15M is an aggregate of ALL liquidation sizes during the whole 15M window.
  // It is NOT the largest single liquidation and is independent from 5M.
  const longItem = totalLong15mItem && totalLong15m > 0
    ? { ...totalLong15mItem, side: 'LONG', notional: totalLong15m }
    : null;
  const shortItem = totalShort15mItem && totalShort15m > 0
    ? { ...totalShort15mItem, side: 'SHORT', notional: totalShort15m }
    : null;

  clearWindowState('15M');

  if (!longItem && !shortItem) return;
  if (longItem && shortItem) {
    if (longItem.notional > shortItem.notional) await sendAlert('15M', longItem, start, end);
    else if (shortItem.notional > longItem.notional) await sendAlert('15M', shortItem, start, end);
    return;
  }
  if (longItem) await sendAlert('15M', longItem, start, end);
  else await sendAlert('15M', shortItem, start, end);
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
  advancing = advancing.then(() => advanceWindows(now)).catch(error => console.error('[Window]', error?.message ?? error));
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

function liquidationKey(order, time) {
  return [
    String(order.s ?? '').toUpperCase(),
    String(order.S ?? '').toUpperCase(),
    order.T ?? time,
    order.ap || order.p,
    order.q
  ].join(':');
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
    notional,
    liquidationKey: liquidationKey(order, time)
  };

  // 5M keeps the largest single liquidation. Current 5M SHORT setting remains OFF.
  if (ENABLE_5M && parsed5) {
    const w = Math.floor(time / WINDOW_5M) * WINDOW_5M;
    if (w === windowStart5m) {
      if (side === 'SELL' && (!largestLong5m || notional > largestLong5m.notional)) largestLong5m = item;
      if (side === 'BUY' && ENABLE_5M_SHORT && (!largestShort5m || notional > largestShort5m.notional)) largestShort5m = item;
    }
  }

  // 15M accumulates EVERY liquidation in the full 15-minute window.
  // A liquidation may contribute to both 5M and 15M; this is intentional.
  if (ENABLE_15M && parsed15) {
    const w = Math.floor(time / WINDOW_15M) * WINDOW_15M;
    if (w === windowStart15m) {
      if (side === 'SELL') {
        totalLong15m += notional;
        if (!totalLong15mItem) totalLong15mItem = item;
      }
      if (side === 'BUY' && ENABLE_15M_SHORT) {
        totalShort15m += notional;
        if (!totalShort15mItem) totalShort15mItem = item;
      }
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
console.log('5M: LONG ONLY | 15M: LONG + SHORT | minimum size: 10 USDT/USDC');
console.log('Assets: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
console.log('15M: aggregate ALL liquidation sizes across the full 15-minute window');
console.log('5M and 15M use independent alert sequence suppression');
console.log('Polymarket link: next market only, one link per alert');

scheduleFlush();
connect();
