import { createServer } from 'node:http';

const BINANCE_TRADE_WS = 'wss://fstream.binance.com/stream?streams=';
const BINANCE_AGGTRADES_REST = 'https://fapi.binance.com/fapi/v1/aggTrades';
const ENABLE_5M = true;
const ENABLE_15M = true;
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const RECONNECT_MS = 3000;
const STATS_INTERVAL_MS = 15000;
const HTTP_PORT = Number(process.env.PORT || 3000);
const REST_LIMIT = 1000;
const REST_DELAY_MS = 50;

const stats = new Map();
let websocket = null;
let reconnectTimer = null;
let statsTimer = null;
let stopping = false;
let bootstrapComplete = false;

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function symbol(asset) { return `${asset.toLowerCase()}usdt`; }
function restSymbol(asset) { return `${asset}USDT`; }
function newBucket(start) { return { start, cvd: 0, lastTrade: null }; }
function getState(asset) {
  let s = stats.get(asset);
  if (!s) {
    const now = Date.now();
    s = { five: newBucket(Math.floor(now / WINDOW_5M) * WINDOW_5M), fifteen: newBucket(Math.floor(now / WINDOW_15M) * WINDOW_15M) };
    stats.set(asset, s);
  }
  return s;
}
function rollBuckets(s, now) {
  const five = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const fifteen = Math.floor(now / WINDOW_15M) * WINDOW_15M;
  if (s.five.start !== five) s.five = newBucket(five);
  if (s.fifteen.start !== fifteen) s.fifteen = newBucket(fifteen);
}
function addCvd(bucket, isBuyerAggressor, usd, now) {
  bucket.cvd += isBuyerAggressor ? usd : -usd;
  bucket.lastTrade = now;
}
function applyTrade(asset, isBuyerAggressor, usd, now) {
  const s = getState(asset);
  rollBuckets(s, now);
  if (ENABLE_5M) addCvd(s.five, isBuyerAggressor, usd, now);
  if (ENABLE_15M) addCvd(s.fifteen, isBuyerAggressor, usd, now);
}
function snapshot(asset, windowMs) {
  const s = getState(asset);
  const b = windowMs === WINDOW_5M ? s.five : s.fifteen;
  return { asset, period: windowMs === WINDOW_5M ? '5M' : '15M', start: b.start, cvd: b.cvd, lastTrade: b.lastTrade, ageMs: b.lastTrade ? Math.max(0, Date.now() - b.lastTrade) : null, status: b.lastTrade ? 'OK' : 'WAITING' };
}
function allStats() { return ASSETS.map(asset => ({ asset, five: snapshot(asset, WINDOW_5M), fifteen: snapshot(asset, WINDOW_15M) })); }
function printStats() { console.log('=== CVD STATISTICS ==='); for (const row of allStats()) console.log(JSON.stringify(row)); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchAggTrades(asset, startTime, endTime) {
  const result = [];
  let cursor = startTime;
  let pages = 0;
  while (cursor < endTime && pages < 100) {
    const url = new URL(BINANCE_AGGTRADES_REST);
    url.searchParams.set('symbol', restSymbol(asset));
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(endTime));
    url.searchParams.set('limit', String(REST_LIMIT));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Binance REST ${response.status}`);
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    result.push(...rows);
    pages += 1;
    const lastTime = num(rows[rows.length - 1]?.T);
    if (!(lastTime >= cursor)) break;
    cursor = lastTime + 1;
    if (rows.length < REST_LIMIT) break;
    await sleep(REST_DELAY_MS);
  }
  return result;
}

async function bootstrapCurrentPeriods() {
  const now = Date.now();
  const fiveStart = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const fifteenStart = Math.floor(now / WINDOW_15M) * WINDOW_15M;
  console.log('=== CVD BOOTSTRAP ===');
  console.log(`Loading current periods: 5M=${new Date(fiveStart).toISOString()} 15M=${new Date(fifteenStart).toISOString()}`);
  await Promise.all(ASSETS.map(async asset => {
    try {
      const trades = await fetchAggTrades(asset, fifteenStart, now);
      const s = getState(asset);
      s.five = newBucket(fiveStart);
      s.fifteen = newBucket(fifteenStart);
      for (const trade of trades) {
        const t = num(trade?.T);
        if (!(t >= fifteenStart && t <= now)) continue;
        const usd = num(trade?.p) * num(trade?.q);
        const isBuyerAggressor = trade?.m === false;
        if (t >= fiveStart && ENABLE_5M) addCvd(s.five, isBuyerAggressor, usd, t);
        if (ENABLE_15M) addCvd(s.fifteen, isBuyerAggressor, usd, t);
      }
      console.log(`[Bootstrap] ${asset}: ${trades.length} aggTrades loaded`);
    } catch (e) {
      console.error(`[Bootstrap] ${asset}:`, e?.message ?? e);
    }
  }));
  bootstrapComplete = true;
  console.log('CVD bootstrap complete; switching to realtime WebSocket');
}

function connect() {
  if (stopping) return;
  const streams = ASSETS.map(asset => `${symbol(asset)}@aggTrade`).join('/');
  websocket = new WebSocket(`${BINANCE_TRADE_WS}${streams}`);
  websocket.addEventListener('open', () => console.log('Binance Futures AggTrade stream connected'));
  websocket.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data));
      const data = message?.data;
      if (data?.e !== 'aggTrade') return;
      const stream = String(message?.stream ?? '');
      const match = stream.match(/^([a-z0-9]+)@aggtrade$/i);
      if (!match) return;
      const asset = ASSETS.find(x => symbol(x) === match[1].toLowerCase());
      if (!asset) return;
      const usd = num(data.p) * num(data.q);
      const now = num(data.T || data.E) || Date.now();
      applyTrade(asset, data.m === false, usd, now);
    } catch (e) { console.error('[AggTrade Parse]', e?.message ?? e); }
  });
  websocket.addEventListener('error', error => console.error('[WebSocket]', error?.message ?? error));
  websocket.addEventListener('close', () => { if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS); });
}
function shutdown(signal) { stopping = true; clearTimeout(reconnectTimer); clearInterval(statsTimer); try { websocket?.close(); } catch {} try { server.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/trades' || url.pathname === '/cvd') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, source: 'Binance Futures AggTrades', checkedAt: new Date().toISOString(), bootstrapComplete, assets: ASSETS, periods: { '5M': ENABLE_5M, '15M': ENABLE_15M }, alerts: false, monitor: 'CVD_ONLY', data: allStats() }));
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'polymarket-cvd-monitor', assets: ASSETS, bootstrapComplete, alerts: false }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/cvd', '/trades', '/health'] }));
});
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics listening on :${HTTP_PORT} (/cvd)`));

console.log('=== POLYMARKET CVD MONITOR ===');
console.log('SOURCE: BINANCE FUTURES REALTIME AGGTRADES');
console.log('OI: DISABLED | LIQUIDATIONS: DISABLED | PRESSURE: DISABLED');
console.log('5M: ON | 15M: ON');
console.log(`ASSETS: ${ASSETS.join(', ')}`);
console.log('MODE: CVD ONLY — TELEGRAM ALERTS DISABLED');
console.log('5M CVD and 15M CVD are calculated independently and reset at each period boundary');

await bootstrapCurrentPeriods();
connect();
statsTimer = setInterval(printStats, STATS_INTERVAL_MS);
