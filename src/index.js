import { createServer } from 'node:http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_TRADE_WS = 'wss://fstream.binance.com/stream?streams=';

const ENABLE_5M = true;
const ENABLE_15M = true;
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const RECONNECT_MS = 3000;
const STATS_INTERVAL_MS = 15000;
const HTTP_PORT = Number(process.env.PORT || 3000);

const stats = new Map();
let websocket = null;
let reconnectTimer = null;
let statsTimer = null;
let stopping = false;

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function symbol(asset) { return `${asset.toLowerCase()}usdt`; }
function newBucket(start) {
  return { start, buyVolume: 0, sellVolume: 0, totalVolume: 0, buyTrades: 0, sellTrades: 0, largestBuy: 0, largestSell: 0, cvd: 0 };
}
function getState(asset) {
  let s = stats.get(asset);
  if (!s) {
    const now = Date.now();
    s = { five: newBucket(Math.floor(now / WINDOW_5M) * WINDOW_5M), fifteen: newBucket(Math.floor(now / WINDOW_15M) * WINDOW_15M), lastTrade: null };
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
function addTrade(bucket, isBuyerAggressor, usd) {
  bucket.totalVolume += usd;
  if (isBuyerAggressor) {
    bucket.buyVolume += usd;
    bucket.buyTrades += 1;
    bucket.largestBuy = Math.max(bucket.largestBuy, usd);
    bucket.cvd += usd;
  } else {
    bucket.sellVolume += usd;
    bucket.sellTrades += 1;
    bucket.largestSell = Math.max(bucket.largestSell, usd);
    bucket.cvd -= usd;
  }
}
function snapshot(asset, windowMs) {
  const s = getState(asset);
  const b = windowMs === WINDOW_5M ? s.five : s.fifteen;
  const delta = b.buyVolume - b.sellVolume;
  const deltaPct = b.totalVolume > 0 ? (delta / b.totalVolume) * 100 : 0;
  return {
    asset,
    period: windowMs === WINDOW_5M ? '5M' : '15M',
    start: b.start,
    buyVolume: b.buyVolume,
    sellVolume: b.sellVolume,
    totalVolume: b.totalVolume,
    delta,
    deltaPct,
    cvd: b.cvd,
    buyTrades: b.buyTrades,
    sellTrades: b.sellTrades,
    largestBuy: b.largestBuy,
    largestSell: b.largestSell,
    lastTrade: s.lastTrade,
    ageMs: s.lastTrade ? Math.max(0, Date.now() - s.lastTrade) : null,
    status: s.lastTrade ? 'OK' : 'WAITING'
  };
}
function allStats() {
  return ASSETS.map(asset => ({ asset, five: snapshot(asset, WINDOW_5M), fifteen: snapshot(asset, WINDOW_15M) }));
}
function printStats() {
  console.log('=== AGGTRADE STATISTICS ===');
  for (const row of allStats()) console.log(JSON.stringify(row));
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
      const price = num(data.p);
      const quantity = num(data.q);
      const usd = price * quantity;
      const now = num(data.T || data.E) || Date.now();
      const s = getState(asset);
      rollBuckets(s, now);
      const isBuyerAggressor = data.m === false;
      addTrade(s.five, isBuyerAggressor, usd);
      addTrade(s.fifteen, isBuyerAggressor, usd);
      s.lastTrade = now;
    } catch (e) { console.error('[AggTrade Parse]', e?.message ?? e); }
  });
  websocket.addEventListener('error', error => console.error('[WebSocket]', error?.message ?? error));
  websocket.addEventListener('close', () => {
    if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
}
function shutdown(signal) {
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(statsTimer);
  try { websocket?.close(); } catch {}
  console.log(`Shutdown: ${signal}`);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/trades') {
    const body = JSON.stringify({
      ok: true,
      source: 'Binance Futures AggTrades',
      checkedAt: new Date().toISOString(),
      assets: ASSETS,
      periods: { '5M': ENABLE_5M, '15M': ENABLE_15M },
      alerts: false,
      data: allStats()
    });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
    return;
  }
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: true, service: 'polymarket-aggtrade-monitor', assets: ASSETS, alerts: false }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/trades', '/health'] }));
});
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics listening on :${HTTP_PORT} (/trades)`));

console.log('=== POLYMARKET AGGTRADE MONITOR ===');
console.log('SOURCE: BINANCE FUTURES REALTIME AGGTRADES');
console.log('OI: DISABLED | LIQUIDATIONS: DISABLED | PRESSURE: DISABLED');
console.log('5M: ON | 15M: ON');
console.log(`ASSETS: ${ASSETS.join(', ')}`);
console.log('MODE: STATISTICS ONLY — TELEGRAM ALERTS DISABLED');
console.log('TRACKING: BUY/SELL VOLUME, DELTA, DELTA %, CVD, TRADE COUNTS, LARGEST BUY/SELL');
connect();
statsTimer = setInterval(printStats, STATS_INTERVAL_MS);
