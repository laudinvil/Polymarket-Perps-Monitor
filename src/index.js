import { createServer } from 'node:http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HYPERLIQUID_WS = 'wss://api.hyperliquid.xyz/ws';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOWS = { '5M': 5 * 60 * 1000, '15M': 15 * 60 * 1000 };
const RECONNECT_MS = 3000;
const STATS_INTERVAL_MS = 15000;
const HTTP_PORT = Number(process.env.PORT || 3000);

const stats = new Map();
const recent5mAlerts = new Map();
const finalized = new Set();
let websocket = null;
let reconnectTimer = null;
let statsTimer = null;
let finalizeTimer = null;
let stopping = false;
let streamConnected = false;
let lastMessageAt = null;

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function newBucket(start) { return { start, cvd: 0, maxPositive: 0, maxNegative: 0, maxPositiveAt: null, maxNegativeAt: null, lastTrade: null }; }
function newState() { return { '5M': newBucket(Math.floor(Date.now() / WINDOWS['5M']) * WINDOWS['5M']), '15M': newBucket(Math.floor(Date.now() / WINDOWS['15M']) * WINDOWS['15M']) }; }
function getState(asset) { let state = stats.get(asset); if (!state) { state = newState(); stats.set(asset, state); } return state; }

async function finalizeBucket(asset, period, bucket) {
  const key = `${asset}:${period}:${bucket.start}`;
  if (finalized.has(key) || !bucket.lastTrade) return;
  finalized.add(key);
  const positive = bucket.maxPositive;
  const negative = Math.abs(bucket.maxNegative);
  if (positive === 0 && negative === 0) return;
  const direction = positive >= negative ? 'POSITIVE' : 'NEGATIVE';
  if (period === '15M') {
    const previous5m = recent5mAlerts.get(`${asset}:${direction}`) || [];
    if (previous5m.some(ts => ts >= bucket.start && ts < bucket.start + WINDOWS['15M'])) return;
  }
  const value = direction === 'POSITIVE' ? positive : negative;
  const nextStart = bucket.start + WINDOWS[period];
  const sent = await sendTelegram([
    direction === 'POSITIVE' ? '🟢 POSITIVE CVD INFLOW' : '🔴 NEGATIVE CVD OUTFLOW',
    '', `${asset} — ${period} CVD`,
    `CVD: ${value.toFixed(0)} USDT`,
    '', '▶️ POLYMARKET',
    `https://polymarket.com/event/${asset.toLowerCase()}-updown-${period.toLowerCase()}-${Math.floor(nextStart / 1000)}`
  ].join('\n'));
  if (sent && period === '5M') {
    const key5 = `${asset}:${direction}`;
    const arr = recent5mAlerts.get(key5) || [];
    arr.push(bucket.start);
    recent5mAlerts.set(key5, arr.filter(ts => ts >= Date.now() - 30 * 60 * 1000));
  }
}

function finalizeExpiredBuckets() {
  const now = Date.now();
  for (const [asset, state] of stats.entries()) {
    for (const period of Object.keys(WINDOWS)) {
      const currentStart = Math.floor(now / WINDOWS[period]) * WINDOWS[period];
      const bucket = state[period];
      if (bucket.start < currentStart) {
        void finalizeBucket(asset, period, bucket);
        state[period] = newBucket(currentStart);
      }
    }
  }
}

function rollBuckets(asset, state, now) {
  for (const period of Object.keys(WINDOWS)) {
    const start = Math.floor(now / WINDOWS[period]) * WINDOWS[period];
    if (state[period].start !== start) {
      const oldBucket = state[period];
      state[period] = newBucket(start);
      void finalizeBucket(asset, period, oldBucket);
    }
  }
}
function addCvd(asset, isBuyerAggressor, usd, now) {
  const state = getState(asset); rollBuckets(asset, state, now);
  for (const period of Object.keys(WINDOWS)) {
    const bucket = state[period];
    bucket.cvd += isBuyerAggressor ? usd : -usd;
    bucket.lastTrade = now;
    if (bucket.cvd > bucket.maxPositive) { bucket.maxPositive = bucket.cvd; bucket.maxPositiveAt = now; }
    if (bucket.cvd < bucket.maxNegative) { bucket.maxNegative = bucket.cvd; bucket.maxNegativeAt = now; }
  }
}
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.error('[Telegram] Not configured'); return false; }
  try { const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) }); if (!response.ok) console.error('[Telegram] HTTP', response.status, await response.text()); return response.ok; } catch (error) { console.error('[Telegram]', error?.message ?? error); return false; }
}
function snapshot(asset) { const state = getState(asset); const out = {}; for (const period of Object.keys(WINDOWS)) { const bucket = state[period]; out[period] = { start: bucket.start, cvd: bucket.cvd, maxPositive: bucket.maxPositive, maxNegative: bucket.maxNegative, maxPositiveAt: bucket.maxPositiveAt, maxNegativeAt: bucket.maxNegativeAt, lastTrade: bucket.lastTrade, ageMs: bucket.lastTrade ? Math.max(0, Date.now() - bucket.lastTrade) : null, status: bucket.lastTrade ? 'OK' : 'WAITING' }; } return { asset, ...out }; }
function allStats() { return ASSETS.map(snapshot); }
function printStats() { console.log('=== CVD 5M / 15M ==='); for (const row of allStats()) console.log(JSON.stringify(row)); }
function subscribeTrades(ws) { for (const coin of ASSETS) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } })); }
function connect() {
  if (stopping) return;
  websocket = new WebSocket(HYPERLIQUID_WS);
  websocket.addEventListener('open', () => { streamConnected = true; console.log('Hyperliquid trades stream connected'); subscribeTrades(websocket); });
  websocket.addEventListener('message', event => { try { const message = JSON.parse(String(event.data)); if (message?.channel !== 'trades' || !Array.isArray(message?.data)) return; lastMessageAt = Date.now(); for (const trade of message.data) { const asset = ASSETS.includes(String(trade?.coin)) ? String(trade.coin) : null; if (!asset) continue; const usd = num(trade.px) * num(trade.sz); const now = num(trade.time) || Date.now(); const isBuyerAggressor = String(trade.side).toUpperCase() === 'B'; if (usd > 0) addCvd(asset, isBuyerAggressor, usd, now); } } catch (error) { console.error('[Trade Parse]', error?.message ?? error); } });
  websocket.addEventListener('error', error => { streamConnected = false; console.error('[WebSocket]', error?.message ?? error); });
  websocket.addEventListener('close', () => { streamConnected = false; if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS); });
}
function shutdown(signal) { stopping = true; clearTimeout(reconnectTimer); clearInterval(statsTimer); clearInterval(finalizeTimer); try { websocket?.close(); } catch {} try { server.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
const server = createServer((req, res) => { const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); if (url.pathname === '/cvd' || url.pathname === '/trades') { res.writeHead(200); res.end(JSON.stringify({ ok: true, source: 'Hyperliquid realtime trades', checkedAt: new Date().toISOString(), streamConnected, lastMessageAt, assets: ASSETS, periods: ['5M', '15M'], monitor: 'CVD_FLOW_5M_15M', alerts: true, alertRule: 'exactly one strongest positive or negative flow per completed period; 15M duplicate of 5M suppressed', data: allStats() })); return; } if (url.pathname === '/health') { res.writeHead(200); res.end(JSON.stringify({ ok: true, service: 'polymarket-cvd-monitor', assets: ASSETS, periods: ['5M', '15M'], streamConnected, lastMessageAt, alerts: true }); return; } res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/cvd', '/trades', '/health'] })); });
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics listening on ${HTTP_PORT} (/cvd)`));
console.log('=== POLYMARKET CVD FLOW MONITOR ===');
console.log('SOURCE: HYPERLIQUID REALTIME TRADES ONLY');
console.log('OI: DISABLED | LIQUIDATIONS: DISABLED | PRESSURE: DISABLED');
console.log('PERIODS: 5M + 15M');
console.log('ALERT: ONE STRONGEST POSITIVE OR NEGATIVE FLOW PER COMPLETED PERIOD');
console.log('NO MINIMUM CVD THRESHOLD');
console.log('15M DUPLICATE OF 5M IS SUPPRESSED');
connect(); statsTimer = setInterval(printStats, STATS_INTERVAL_MS); finalizeTimer = setInterval(finalizeExpiredBuckets, 1000);
