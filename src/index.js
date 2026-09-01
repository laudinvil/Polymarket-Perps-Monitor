import { createServer } from 'node:http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HYPERLIQUID_WS = 'wss://api.hyperliquid.xyz/ws';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const ALERT_5M_ASSETS = ASSETS;
const WINDOWS = { '5M': 5 * 60 * 1000, '15M': 15 * 60 * 1000 };
const RECONNECT_MS = 3000;
const STATS_INTERVAL_MS = 15000;
const FINALIZE_INTERVAL_MS = 1000;
const HTTP_PORT = Number(process.env.PORT || 3000);
const stats = new Map();
const finalizedPeriods = new Set();
let websocket = null, reconnectTimer = null, statsTimer = null, finalizeTimer = null;
let stopping = false, streamConnected = false, lastMessageAt = null;
function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function newBucket(start) { return { start, buyVolume: 0, sellVolume: 0, cvd: 0, lastTrade: null }; }
function newState() { return { '5M': newBucket(Math.floor(Date.now() / WINDOWS['5M']) * WINDOWS['5M']), '15M': newBucket(Math.floor(Date.now() / WINDOWS['15M']) * WINDOWS['15M']) }; }
function getState(asset) { let state = stats.get(asset); if (!state) { state = newState(); stats.set(asset, state); } return state; }
async function finalizePeriod(period, start) {
  const periodKey = `${period}:${start}`;
  if (finalizedPeriods.has(periodKey)) return;
  finalizedPeriods.add(periodKey);
  const allowed = period === '5M' ? ALERT_5M_ASSETS : ASSETS;
  const positive = [];
  const negative = [];
  for (const asset of allowed) {
    const state = stats.get(asset), bucket = state?.[period];
    if (!bucket || bucket.start !== start || !bucket.lastTrade) continue;
    const cvd = bucket.buyVolume - bucket.sellVolume;
    if (cvd > 0) positive.push({ asset, direction: 'POSITIVE', cvd, value: cvd });
    if (cvd < 0) negative.push({ asset, direction: 'NEGATIVE', cvd, value: Math.abs(cvd) });
  }
  positive.sort((a, b) => a.value - b.value);
  negative.sort((a, b) => a.value - b.value);
  const winners = [positive[0], negative[0]].filter(Boolean);
  if (!winners.length) return;
  const nextStart = start + WINDOWS[period];
  for (const winner of winners) {
    await sendTelegram([
      winner.direction === 'POSITIVE' ? '🟢 POSITIVE CVD INFLOW' : '🔴 NEGATIVE CVD OUTFLOW', '',
      `${winner.asset} — ${period} CVD`, `CVD: ${winner.cvd >= 0 ? '+' : ''}${winner.cvd.toFixed(0)} USDT`, '', '▶️ POLYMARKET',
      `https://polymarket.com/event/${winner.asset.toLowerCase()}-updown-${period.toLowerCase()}-${Math.floor(nextStart / 1000)}`
    ].join('\n'));
  }
}
function finalizeExpiredPeriods() {
  const now = Date.now();
  for (const period of Object.keys(WINDOWS)) {
    const currentStart = Math.floor(now / WINDOWS[period]) * WINDOWS[period], previousStart = currentStart - WINDOWS[period];
    void finalizePeriod(period, previousStart);
    for (const state of stats.values()) if (state[period].start < currentStart) state[period] = newBucket(currentStart);
  }
}
function rollBuckets(asset, state, now) { for (const period of Object.keys(WINDOWS)) { const start = Math.floor(now / WINDOWS[period]) * WINDOWS[period]; if (state[period].start !== start) state[period] = newBucket(start); } }
function addCvd(asset, isBuyerAggressor, usd, now) {
  const state = getState(asset); rollBuckets(asset, state, now);
  for (const period of Object.keys(WINDOWS)) { const bucket = state[period]; if (isBuyerAggressor) bucket.buyVolume += usd; else bucket.sellVolume += usd; bucket.cvd = bucket.buyVolume - bucket.sellVolume; bucket.lastTrade = now; }
}
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.error('[Telegram] Not configured'); return false; }
  try { const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) }); if (!response.ok) console.error('[Telegram] HTTP', response.status, await response.text()); return response.ok; } catch (error) { console.error('[Telegram]', error?.message ?? error); return false; }
}
function snapshot(asset) { const state = getState(asset), out = {}; for (const period of Object.keys(WINDOWS)) { const bucket = state[period]; out[period] = { start: bucket.start, buyVolume: bucket.buyVolume, sellVolume: bucket.sellVolume, cvd: bucket.cvd, lastTrade: bucket.lastTrade, ageMs: bucket.lastTrade ? Math.max(0, Date.now() - bucket.lastTrade) : null, status: bucket.lastTrade ? 'OK' : 'WAITING', alertEligible: true }; } return { asset, ...out }; }
function allStats() { return ASSETS.map(snapshot); }
function printStats() { console.log('=== CVD 5M / 15M ==='); for (const row of allStats()) console.log(JSON.stringify(row)); }
function subscribeTrades(ws) { for (const coin of ASSETS) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } })); }
function connect() { if (stopping) return; websocket = new WebSocket(HYPERLIQUID_WS); websocket.addEventListener('open', () => { streamConnected = true; console.log('Hyperliquid trades stream connected'); subscribeTrades(websocket); }); websocket.addEventListener('message', event => { try { const message = JSON.parse(String(event.data)); if (message?.channel !== 'trades' || !Array.isArray(message?.data)) return; lastMessageAt = Date.now(); for (const trade of message.data) { const asset = ASSETS.includes(String(trade?.coin)) ? String(trade.coin) : null; if (!asset) continue; const usd = num(trade.px) * num(trade.sz), now = num(trade.time) || Date.now(); if (usd > 0) addCvd(asset, String(trade.side).toUpperCase() === 'B', usd, now); } } catch (error) { console.error('[Trade Parse]', error?.message ?? error); } }); websocket.addEventListener('error', error => { streamConnected = false; console.error('[WebSocket]', error?.message ?? error); }); websocket.addEventListener('close', () => { streamConnected = false; if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS); }); }
function shutdown(signal) { stopping = true; clearTimeout(reconnectTimer); clearInterval(statsTimer); clearInterval(finalizeTimer); try { websocket?.close(); } catch {} try { server.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
const server = createServer((req, res) => { const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); if (url.pathname === '/cvd' || url.pathname === '/trades') { res.writeHead(200); res.end(JSON.stringify({ ok: true, source: 'Hyperliquid realtime trades', checkedAt: new Date().toISOString(), streamConnected, lastMessageAt, assets: ASSETS, alert5mAssets: ALERT_5M_ASSETS, periods: ['5M', '15M'], monitor: 'CVD_FLOW_5M_15M', alerts: true, alertRule: 'ONE smallest positive CVD INFLOW and ONE smallest absolute negative CVD OUTFLOW per completed 5M and 15M period; all 7 assets eligible on both timeframes', data: allStats() })); return; } if (url.pathname === '/health') { res.writeHead(200); res.end(JSON.stringify({ ok: true, service: 'polymarket-cvd-monitor', assets: ASSETS, alert5mAssets: ALERT_5M_ASSETS, periods: ['5M', '15M'], streamConnected, lastMessageAt, alerts: true })); return; } res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/cvd', '/trades', '/health'] })); });
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics listening on ${HTTP_PORT} (/cvd)`));
console.log('=== POLYMARKET CVD FLOW MONITOR ==='); console.log('SOURCE: HYPERLIQUID REALTIME TRADES ONLY'); console.log('CVD: TOTAL BUY VOLUME - TOTAL SELL VOLUME'); console.log('PERIODS: 5M + 15M'); console.log('5M ALERT ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB'); console.log('15M ALERT ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB'); console.log('ALERT: SMALLEST POSITIVE INFLOW + SMALLEST ABSOLUTE NEGATIVE OUTFLOW PER PERIOD'); connect(); statsTimer = setInterval(printStats, STATS_INTERVAL_MS); finalizeTimer = setInterval(finalizeExpiredPeriods, FINALIZE_INTERVAL_MS);
