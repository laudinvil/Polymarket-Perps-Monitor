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
function newCvdState() { return { cvd: 0, lastTrade: null, sign: 0 }; }
function getState(asset) {
  let s = stats.get(asset);
  if (!s) { s = { cvd: newCvdState(), lastAlertSign: 0 }; stats.set(asset, s); }
  return s;
}
function signOfCvd(cvd) { return cvd > 0 ? 1 : cvd < 0 ? -1 : 0; }
function marketLink(asset, start, period) {
  return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${period}-${Math.floor(start / 1000)}`;
}
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.error('[Telegram] Not configured'); return false; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) });
    if (!r.ok) console.error('[Telegram] HTTP', r.status, await r.text());
    return r.ok;
  } catch (e) { console.error('[Telegram]', e?.message ?? e); return false; }
}
async function alertCvdCrossing(asset, previousSign, currentSign, cvd, now) {
  if (!previousSign || !currentSign || previousSign === currentSign) return;
  const direction = currentSign > 0 ? 'CVD NEGATIVE → POSITIVE' : 'CVD POSITIVE → NEGATIVE';
  const fiveStart = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const fifteenStart = Math.floor(now / WINDOW_15M) * WINDOW_15M;
  const text = [
    `🚨 ${direction}`,
    '',
    `${asset} — CVD SIGN CHANGE`,
    `📊 CVD: ${cvd >= 0 ? '+' : ''}${cvd.toFixed(0)} USDT`,
    '',
    ENABLE_5M ? '▶️ NEXT MARKET 5M' : '',
    ENABLE_5M ? marketLink(asset, fiveStart + WINDOW_5M, '5m') : '',
    ENABLE_15M ? '' : '',
    ENABLE_15M ? '▶️ CURRENT MARKET 15M' : '',
    ENABLE_15M ? marketLink(asset, fifteenStart, '15m') : ''
  ].filter(Boolean).join('\n');
  await sendTelegram(text);
}
function processTrade(asset, isBuyerAggressor, usd, now) {
  const s = getState(asset);
  const previousSign = signOfCvd(s.cvd.cvd);
  s.cvd.cvd += isBuyerAggressor ? usd : -usd;
  s.cvd.lastTrade = now;
  const currentSign = signOfCvd(s.cvd.cvd);
  if (currentSign && previousSign && currentSign !== previousSign && currentSign !== s.lastAlertSign) {
    s.lastAlertSign = currentSign;
    void alertCvdCrossing(asset, previousSign, currentSign, s.cvd.cvd, now);
  }
  if (currentSign) s.cvd.sign = currentSign;
}
function snapshot(asset) {
  const s = getState(asset);
  const b = s.cvd;
  return { asset, cvd: b.cvd, sign: b.sign, lastTrade: b.lastTrade, ageMs: b.lastTrade ? Math.max(0, Date.now() - b.lastTrade) : null, status: b.lastTrade ? 'OK' : 'WAITING' };
}
function allStats() { return ASSETS.map(snapshot); }
function printStats() { console.log('=== CONTINUOUS CVD ==='); for (const row of allStats()) console.log(JSON.stringify(row)); }
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
      processTrade(asset, data.m === false, usd, now);
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
  if (url.pathname === '/cvd' || url.pathname === '/trades') {
    res.writeHead(200); res.end(JSON.stringify({ ok: true, source: 'Binance Futures AggTrades', checkedAt: new Date().toISOString(), assets: ASSETS, monitor: 'CONTINUOUS_CVD_ONLY', alerts: true, data: allStats() })); return;
  }
  if (url.pathname === '/health') { res.writeHead(200); res.end(JSON.stringify({ ok: true, service: 'polymarket-cvd-monitor', assets: ASSETS, alerts: true, monitor: 'CVD_ZERO_CROSSING' })); return; }
  res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/cvd', '/trades', '/health'] }));
});
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics listening on :${HTTP_PORT} (/cvd)`));

console.log('=== POLYMARKET CONTINUOUS CVD MONITOR ===');
console.log('SOURCE: BINANCE FUTURES REALTIME AGGTRADES');
console.log('OI: DISABLED | LIQUIDATIONS: DISABLED | PRESSURE: DISABLED');
console.log('CVD: CONTINUOUS — NEVER RESET AT 5M/15M BOUNDARIES');
console.log('ONE NEW CVD ZERO-CROSSING = ONE TELEGRAM ALERT');
console.log('5M -> NEXT MARKET | 15M -> CURRENT MARKET');
console.log(`ASSETS: ${ASSETS.join(', ')}`);
connect();
statsTimer = setInterval(printStats, STATS_INTERVAL_MS);
