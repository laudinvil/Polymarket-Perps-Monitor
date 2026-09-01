import { createServer } from 'node:http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HYPERLIQUID_WS = 'wss://api.hyperliquid.xyz/ws';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_5M = 5 * 60 * 1000;
const RECONNECT_MS = 3000;
const STATS_INTERVAL_MS = 15000;
const HTTP_PORT = Number(process.env.PORT || 3000);
const CVD_ALERT_MIN_USD = Number(process.env.CVD_ALERT_MIN_USD || 100000);

const stats = new Map();
let websocket = null;
let reconnectTimer = null;
let statsTimer = null;
let stopping = false;
let streamConnected = false;
let lastMessageAt = null;

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function signOfCvd(cvd) { return cvd > 0 ? 1 : cvd < 0 ? -1 : 0; }
function newBucket(start) {
  return {
    start,
    cvd: 0,
    maxAbsCvd: 0,
    lastTrade: null,
    initialized: false,
    lastAlertSign: 0
  };
}
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
  bucket.maxAbsCvd = Math.max(bucket.maxAbsCvd, Math.abs(bucket.cvd));
  bucket.lastTrade = now;
  const currentSign = signOfCvd(bucket.cvd);

  if (!bucket.initialized) {
    bucket.initialized = true;
    bucket.lastAlertSign = currentSign;
    return;
  }

  const significantMove = bucket.maxAbsCvd >= CVD_ALERT_MIN_USD;
  if (
    previousSign &&
    currentSign &&
    previousSign !== currentSign &&
    bucket.lastAlertSign !== currentSign &&
    significantMove
  ) {
    bucket.lastAlertSign = currentSign;
    void alertCvdCrossing(asset, previousSign, currentSign, bucket.cvd, bucket.maxAbsCvd, now);
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
async function alertCvdCrossing(asset, previousSign, currentSign, cvd, maxAbsCvd, now) {
  const direction = currentSign > 0 ? 'CVD NEGATIVE → POSITIVE' : 'CVD POSITIVE → NEGATIVE';
  const start = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const nextStart = start + WINDOW_5M;
  const lines = [
    `🚨 ${direction}`,
    '',
    `${asset} — 5M CVD`,
    `📊 CVD: ${cvd >= 0 ? '+' : ''}${cvd.toFixed(0)} USDT`,
    `📈 Max move: ${maxAbsCvd.toFixed(0)} USDT`,
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
    maxAbsCvd: bucket.maxAbsCvd,
    alertThresholdUsd: CVD_ALERT_MIN_USD,
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
function subscribeTrades(ws) {
  for (const coin of ASSETS) {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
  }
}
function connect() {
  if (stopping) return;
  websocket = new WebSocket(HYPERLIQUID_WS);
  websocket.addEventListener('open', () => {
    streamConnected = true;
    console.log('Hyperliquid trades stream connected');
    subscribeTrades(websocket);
  });
  websocket.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data));
      if (message?.channel !== 'trades' || !Array.isArray(message?.data)) return;
      lastMessageAt = Date.now();
      for (const trade of message.data) {
        const asset = ASSETS.includes(String(trade?.coin)) ? String(trade.coin) : null;
        if (!asset) continue;
        const usd = num(trade.px) * num(trade.sz);
        const now = num(trade.time) || Date.now();
        const isBuyerAggressor = String(trade.side).toUpperCase() === 'B';
        if (usd > 0) addCvd(asset, isBuyerAggressor, usd, now);
      }
    } catch (error) { console.error('[Trade Parse]', error?.message ?? error); }
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
      source: 'Hyperliquid realtime trades',
      checkedAt: new Date().toISOString(),
      streamConnected,
      lastMessageAt,
      assets: ASSETS,
      period: '5M',
      monitor: '5M_CVD_ONLY',
      alerts: true,
      alertThresholdUsd: CVD_ALERT_MIN_USD,
      data: allStats()
    }));
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'polymarket-cvd-monitor', assets: ASSETS, period: '5M', streamConnected, lastMessageAt, alertThresholdUsd: CVD_ALERT_MIN_USD, alerts: true }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/cvd', '/trades', '/health'] }));
});
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics listening on :${HTTP_PORT} (/cvd)`));

console.log('=== POLYMARKET 5M CVD MONITOR ===');
console.log('SOURCE: HYPERLIQUID REALTIME TRADES ONLY');
console.log('OI: DISABLED | LIQUIDATIONS: DISABLED | PRESSURE: DISABLED');
console.log('ONLY 5M CVD');
console.log('CVD RESETS AT EVERY 5M MARKET BOUNDARY');
console.log(`ALERT: ZERO-CROSSING AFTER BASELINE + MINIMUM MAX MOVE ${CVD_ALERT_MIN_USD} USDT`);
console.log(`ASSETS: ${ASSETS.join(', ')}`);

connect();
statsTimer = setInterval(printStats, STATS_INTERVAL_MS);
