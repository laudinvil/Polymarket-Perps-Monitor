import {
  startPinaxLiquidationEngine,
  stopPinaxLiquidationEngine,
  consumePinaxWindow,
  setPinaxWindowCloseHandler
} from './pinax-liquidation-engine.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ENABLE_5M = true;
const ENABLE_15M = true;
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const MIN_SIZE = 10;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;

let windowStart5m = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
let windowStart15m = Math.floor(Date.now() / WINDOW_15M) * WINDOW_15M;
let lastAlertAsset5m = null;
let lastAlertAsset15m = null;
let flushTimer = null;
let stopping = false;
let advancing = Promise.resolve();

function money(v) {
  return `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })} USDC`;
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
  if (!item || item.notional < MIN_SIZE) return;
  const is15 = period === '15M';
  if (is15 ? !ENABLE_15M : !ENABLE_5M) return;

  const last = is15 ? lastAlertAsset15m : lastAlertAsset5m;
  if (last === item.asset) {
    console.log(`[Pinax OHLCV] duplicate suppressed: ${item.asset} ${period}; waiting for another asset`);
    return;
  }

  const text = [
    `🚨 ${item.side} LIQUIDATION — ${period}`,
    '',
    `${item.asset} — ${item.side} LIQUIDATION`,
    `💥 Size: ${money(item.notional)}`,
    '',
    `▶️ NEXT ${item.asset} ${period} UP/DOWN`,
    nextMarketLink(item.asset, end, is15 ? WINDOW_15M : WINDOW_5M)
  ].join('\n');

  if (await sendTelegram(text)) {
    if (is15) lastAlertAsset15m = item.asset;
    else lastAlertAsset5m = item.asset;
  }
}

async function flushCompletedWindows(now) {
  if (ENABLE_5M) {
    const target = Math.floor(now / WINDOW_5M) * WINDOW_5M;
    while (windowStart5m < target) {
      const start = windowStart5m;
      const end = start + WINDOW_5M;
      windowStart5m = end;
      const items = consumePinaxWindow(WINDOW_5M, start, ASSETS);
      for (const item of items) await sendAlert('5M', item, start, end);
    }
  }

  if (ENABLE_15M) {
    const target = Math.floor(now / WINDOW_15M) * WINDOW_15M;
    while (windowStart15m < target) {
      const start = windowStart15m;
      const end = start + WINDOW_15M;
      windowStart15m = end;
      const items = consumePinaxWindow(WINDOW_15M, start, ASSETS);
      for (const item of items) await sendAlert('15M', item, start, end);
    }
  }
}

function requestAdvance(now) {
  advancing = advancing.then(() => flushCompletedWindows(now)).catch(error => {
    console.error('[Windows]', error?.message ?? error);
  });
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
  }, Math.max(100, next - Date.now() + 100));
}

setPinaxWindowCloseHandler(async now => {
  await requestAdvance(now);
});

function shutdown(signal) {
  stopping = true;
  clearTimeout(flushTimer);
  stopPinaxLiquidationEngine();
  console.log(`Shutdown: ${signal}`);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('=== POLYMARKET LIQUIDATION MONITOR ===');
console.log('SOURCE: PINAX / HYPERLIQUID LIQUIDATION-ONLY OHLCV');
console.log('5M: ENABLED | 15M: ENABLED | minimum size: 10 USDC');
console.log('LONG = aggregate liquidation sell volume | SHORT = aggregate liquidation buy volume');
console.log('One direction per coin per completed window: whichever aggregate is larger wins.');
console.log('Assets: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
console.log('Sequential duplicate suppression is independent per timeframe.');
console.log('Binance liquidation source: DISABLED');

scheduleFlush();
startPinaxLiquidationEngine();
