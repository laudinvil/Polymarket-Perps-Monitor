const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_DEPTH_WS = 'wss://fstream.binance.com/stream?streams=';

const ENABLE_5M = true;
const ENABLE_15M = true;
const PRESSURE_ALERT_THRESHOLD_PCT = 50;
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const RECONNECT_MS = 3000;
const DEPTH_LEVELS = 20;

const state = new Map();
let websocket = null;
let reconnectTimer = null;
let stopping = false;

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function symbol(asset) { return `${asset.toLowerCase()}usdt`; }
function marketLink(asset, start, windowMs) {
  const period = windowMs === WINDOW_15M ? '15m' : '5m';
  return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${period}-${Math.floor(start / 1000)}`;
}
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false })
    });
    if (!r.ok) console.error('[Telegram] HTTP', r.status, await r.text());
    return r.ok;
  } catch (e) { console.error('[Telegram]', e?.message ?? e); return false; }
}
function quoteVolume(levels) {
  return (Array.isArray(levels) ? levels : []).reduce((sum, level) => {
    const price = num(level?.[0]);
    const quantity = num(level?.[1]);
    return sum + price * quantity;
  }, 0);
}
function pressure(bidVolume, askVolume) {
  const total = bidVolume + askVolume;
  if (!(total > 0)) return 0;
  return ((bidVolume - askVolume) / total) * 100;
}
function formatPressure(value) { return `${value >= 0 ? '+' : ''}${value.toFixed(0)}%`; }
function formatUsd(value) { return `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} USDT`; }
function pressureState(asset, windowMs, now) {
  const key = `${asset}:${windowMs}`;
  const period = Math.floor(now / windowMs) * windowMs;
  let s = state.get(key);
  if (!s || s.period !== period) {
    s = { period, lastPressure: null, alerted: false, lastAlertPressure: null, lastUpdate: null, bidVolume: 0, askVolume: 0 };
    state.set(key, s);
  }
  return s;
}
async function processDepth(asset, bids, asks, eventTime) {
  const bidVolume = quoteVolume(bids);
  const askVolume = quoteVolume(asks);
  const p = pressure(bidVolume, askVolume);
  const now = num(eventTime) || Date.now();
  for (const windowMs of [WINDOW_5M, WINDOW_15M]) {
    if ((windowMs === WINDOW_5M && !ENABLE_5M) || (windowMs === WINDOW_15M && !ENABLE_15M)) continue;
    const s = pressureState(asset, windowMs, now);
    s.lastPressure = p;
    s.lastUpdate = now;
    s.bidVolume = bidVolume;
    s.askVolume = askVolume;
    if (s.alerted || Math.abs(p) < PRESSURE_ALERT_THRESHOLD_PCT) continue;
    s.alerted = true;
    s.lastAlertPressure = p;
    const label = windowMs === WINDOW_5M ? '5M' : '15M';
    const linkStart = windowMs === WINDOW_5M ? s.period + WINDOW_5M : s.period;
    const direction = p > 0 ? 'BUY PRESSURE' : 'SELL PRESSURE';
    const text = [
      `🚨 ${direction} — ${label}`,
      '',
      `${asset} — ${direction}`,
      `📊 Pressure: ${formatPressure(p)}`,
      `🟢 Bid volume: ${formatUsd(bidVolume)}`,
      `🔴 Ask volume: ${formatUsd(askVolume)}`,
      '',
      `▶️ ${windowMs === WINDOW_5M ? 'NEXT' : 'CURRENT'} ${asset} ${label} UP/DOWN`,
      marketLink(asset, linkStart, windowMs)
    ].join('\n');
    await sendTelegram(text);
  }
}
function connect() {
  if (stopping) return;
  const streams = ASSETS.map(asset => `${symbol(asset)}@depth20@100ms`).join('/');
  websocket = new WebSocket(`${BINANCE_DEPTH_WS}${streams}`);
  websocket.addEventListener('open', () => console.log('Binance Futures depth stream connected'));
  websocket.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data));
      const data = message?.data;
      if (data?.e !== 'depthUpdate') return;
      const stream = String(message?.stream ?? '');
      const match = stream.match(/^([a-z0-9]+)@depth20@100ms$/i);
      if (!match) return;
      const asset = ASSETS.find(x => symbol(x) === match[1].toLowerCase());
      if (!asset) return;
      void processDepth(asset, data.b || [], data.a || [], data.E || Date.now());
    } catch (e) { console.error('[Depth Parse]', e?.message ?? e); }
  });
  websocket.addEventListener('error', error => console.error('[WebSocket]', error?.message ?? error));
  websocket.addEventListener('close', () => {
    if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS);
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

console.log('=== POLYMARKET ORDER BOOK PRESSURE MONITOR ===');
console.log('SOURCE: BINANCE FUTURES REALTIME DEPTH STREAM');
console.log('OI: DISABLED | LIQUIDATIONS: DISABLED');
console.log('5M: ON | 15M: ON');
console.log(`PRESSURE ALERT: ±${PRESSURE_ALERT_THRESHOLD_PCT}%`);
console.log(`ASSETS: ${ASSETS.join(', ')}`);
console.log('PRESSURE = (BID VOLUME - ASK VOLUME) / (BID VOLUME + ASK VOLUME)');
console.log('5M ALERT: NEXT MARKET | 15M ALERT: CURRENT MARKET');
connect();
