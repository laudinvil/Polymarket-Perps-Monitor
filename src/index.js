import { createServer } from 'node:http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_TRADE_WS = 'wss://fstream.binance.com/stream?streams=';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_5M = 5 * 60 * 1000;
const RECONNECT_MS = 3000;
const STATS_INTERVAL_MS = 15000;
const HTTP_PORT = Number(process.env.PORT || 3000);

const stats = new Map();
let websocket = null;
let reconnectTimer = null;
let statsTimer = null;
let stopping = false;
let streamConnected = false;

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function symbol(asset) { return `${asset.toLowerCase()}usdt`; }
function signOfCvd(cvd) { return cvd > 0 ? 1 : cvd < 0 ? -1 : 0; }
function newBucket(start) { return { start, cvd: 0, lastTrade: null, initialized: false, lastAlertSign: 0 }; }
function getState(asset) {
  let state = stats.get(asset);
  if (!state) {
    state = { five: newBucket(Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M) };
    stats.set(asset, state);
  }
  return state;
}
function rollBucket(state, now) {
  const start = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  if (state.five.start !== start) state.five = newBucket(start);
}
function addCvd(asset, isBuyerAggressor, usd, now) {
  const state = getState(asset);
  rollBucket(state, now);
  const bucket = state.five;
  const previousSign = signOfCvd(bucket.cvd);
  bucket.cvd += isBuyerAggressor ? usd : -usd;
  bucket.lastTrade = now;
  const currentSign = signOfCvd(bucket.cvd);

  // The first realtime trade establishes the baseline for the current 5M window.
  // It must never generate an alert by itself.
  if (!bucket.initialized) {
    bucket.initialized = true;
    bucket.lastAlertSign = currentSign;
    return;
  }

  if (previousSign && currentSign && previousSign !== currentSign && bucket.lastAlertSign !== currentSign) {
    bucket.lastAlertSign = currentSign;
    void alertCvdCrossing(asset, previousSign, currentSign, bucket.cvd, now);
  }
}
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('[Telegram] Not configured');
    return false;
  }
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
async function alertCvdCrossing(asset, previousSign, currentSign, cvd, now) {
  const direction = currentSign > 0 ? 'CVD NEGATIVE → POSITIVE' : 'CVD POSITIVE → NEGATIVE';
  const start = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const nextStart = start + WINDOW_5M;
  const lines = [
    `🚨 ${direction}`,
    '',
    `${asset} — 5M CVD`,
    `📊 CVD: ${cvd >= 0 ? '+' : ''}${cvd.toFixed(0)} USDT`,
    '',
    '▶️ POLYMARKET 5M',
    `https://polymarket.com/event/${asset.toLowerCase()}-updown-5m-${Math.floor(nextStart / 1000)}`
  ];
  await sendTelegram(lines.join('\n'));
}
function snapshot(asset) {
  const state = getState(asset);
  const bucket = state.five;
  return {
    asset,
    period: '5M',
    start: bucket.start,
    cvd: bucket.cvd,
    sign: signOfCvd(bucket.cvd),
    initialized: bucket.initialized,
    lastTrade: bucket.lastTrade,
    ageMs: bucket.lastTrade ? Math.max(0, Date.now() - bucket.lastTrade) : null,
    status: bucket.lastTrade ? 'OK' : 'WAITING'
  };
}
function allStats() { return ASSETS.map(snapshot); }
function printStats() {
  console.log('=== 5M CVD ===');
  for (const row of allStats()) console.log(JSON.stringify(row));
}
function connect() {
  if (stopping) return;
  const streams = ASSETS.map(asset => `${symbol(asset)}@aggTrade`).join('/');
  websocket = new WebSocket(`${BINANCE_TRADE_WS}${streams}`);
  websocket.addEventListener('open', () => {
    streamConnected = true;
    console.log('Binance Futures AggTrade stream connected');
  });
  websocket.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data));
      const data = message?.data;
      if (data?.e !== 'aggTrade') return;
      const stream = String(message?.stream ?? '');
      const match = stream.match(/^([a-z0-9]+)@aggtrade$/i);
      if (!match) return;
      const asset = ASSETS.find(item => symbol(item) === match[1].toLowerCase());
      if (!asset) return;
      const usd = num(data.p) * num(data.q);
      const now = num(data.T || data.E) || Date.now();
      addCvd(asset, data.m === false, usd, now);
    } catch (error) { console.error('[AggTrade Parse]', error?.message ?? error); }
  });
  websocket.addEventListener('error', error => {
    streamConnected = false;
    console.error('[WebSocket]', error?.message ?? error);
  });
  websocket.addEventListener('close', () => {
    streamConnected = false;
    if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
}
function shutdown(signal) {
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(statsTimer);
  try { websocket?.close(); } catch {}
  try { server.close(); } catch {}
  console.log(`Shutdown: ${signal}`);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/cvd' || url.pathname === '/trades') {
    res.writeHead(200);
    res.end(JSON.stringify({
      ok: true,
      source: 'Binance Futures realtime AggTrades',
      checkedAt: new Date().toISOString(),
      streamConnected,
      assets: ASSETS,
      period: '5M',
      monitor: '5M_CVD_ONLY',
      alerts: true,
      data: allStats()
    }));
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'polymarket-cvd-monitor', assets: ASSETS, period: '5M', streamConnected, alerts: true }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/cvd', '/trades', '/health'] }));
});
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics listening on :${HTTP_PORT} (/cvd)`));

console.log('=== POLYMARKET 5M CVD MONITOR ===');
console.log('SOURCE: BINANCE FUTURES REALTIME AGGTRADES ONLY');
console.log('OI: DISABLED | LIQUIDATIONS: DISABLED | PRESSURE: DISABLED');
console.log('ONLY 5M CVD');
console.log('CVD RESETS AT EVERY 5M MARKET BOUNDARY');
console.log('NO REST BOOTSTRAP — FIRST REALTIME TRADE ESTABLISHES BASELINE');
console.log('ALERT: ZERO-CROSSING AFTER BASELINE, MAX ONE ALERT PER DIRECTION');
console.log(`ASSETS: ${ASSETS.join(', ')}`);

connect();
statsTimer = setInterval(printStats, STATS_INTERVAL_MS);
