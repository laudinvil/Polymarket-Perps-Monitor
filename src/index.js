import { createServer } from 'node:http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const HYPERLIQUID_WS = 'wss://api.hyperliquid.xyz/ws';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_MS = 5 * 60 * 1000;
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
function getState(asset) { let state = stats.get(asset); if (!state) { state = newBucket(Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS); stats.set(asset, state); } return state; }
async function finalizePeriod(start) {
  if (finalizedPeriods.has(start)) return;
  finalizedPeriods.add(start);
  const candidates = [];
  for (const asset of ASSETS) {
    const bucket = stats.get(asset);
    if (!bucket || bucket.start !== start || !bucket.lastTrade) continue;
    const cvd = bucket.buyVolume - bucket.sellVolume;
    if (cvd !== 0) candidates.push({ asset, value: Math.abs(cvd), cvd });
  }
  if (!candidates.length) return;
  candidates.sort((a, b) => a.value - b.value);
  const winner = candidates[0];
  const direction = winner.cvd > 0 ? '🟢 POSITIVE CVD INFLOW' : '🔴 NEGATIVE CVD OUTFLOW';
  const nextStart = start + WINDOW_MS;
  await sendTelegram([
    direction, '', `${winner.asset} — 5M CVD`, `CVD: ${winner.cvd >= 0 ? '+' : ''}${winner.cvd.toFixed(0)} USDT`, '', '▶️ POLYMARKET',
    `https://polymarket.com/event/${winner.asset.toLowerCase()}-updown-5m-${Math.floor(nextStart / 1000)}`
  ].join('\n'));
}
function finalizeExpiredPeriod() {
  const currentStart = Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS;
  const previousStart = currentStart - WINDOW_MS;
  void finalizePeriod(previousStart);
  for (const state of stats.values()) if (state.start !== currentStart) Object.assign(state, newBucket(currentStart));
}
function addCvd(asset, isBuyerAggressor, usd, now) { const state = getState(asset); const start = Math.floor(now / WINDOW_MS) * WINDOW_MS; if (state.start !== start) Object.assign(state, newBucket(start)); if (isBuyerAggressor) state.buyVolume += usd; else state.sellVolume += usd; state.cvd = state.buyVolume - state.sellVolume; state.lastTrade = now; }
async function sendTelegram(text) { if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.error('[Telegram] Not configured'); return false; } try { const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) }); if (!response.ok) console.error('[Telegram] HTTP', response.status, await response.text()); return response.ok; } catch (error) { console.error('[Telegram]', error?.message ?? error); return false; } }
function snapshot(asset) { const bucket = getState(asset); return { asset, period: '5M', start: bucket.start, buyVolume: bucket.buyVolume, sellVolume: bucket.sellVolume, cvd: bucket.cvd, lastTrade: bucket.lastTrade, ageMs: bucket.lastTrade ? Math.max(0, Date.now() - bucket.lastTrade) : null, status: bucket.lastTrade ? 'OK' : 'WAITING' }; }
function allStats() { return ASSETS.map(snapshot); }
function printStats() { console.log('=== CVD 5M ==='); for (const row of allStats()) console.log(JSON.stringify(row)); }
function subscribeTrades(ws) { for (const coin of ASSETS) ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } })); }
function connect() { if (stopping) return; websocket = new WebSocket(HYPERLIQUID_WS); websocket.addEventListener('open', () => { streamConnected = true; console.log('Hyperliquid trades stream connected'); subscribeTrades(websocket); }); websocket.addEventListener('message', event => { try { const message = JSON.parse(String(event.data)); if (message?.channel !== 'trades' || !Array.isArray(message?.data)) return; lastMessageAt = Date.now(); for (const trade of message.data) { const asset = ASSETS.includes(String(trade?.coin)) ? String(trade.coin) : null; if (!asset) continue; const usd = num(trade.px) * num(trade.sz), now = num(trade.time) || Date.now(); if (usd > 0) addCvd(asset, String(trade.side).toUpperCase() === 'B', usd, now); } } catch (error) { console.error('[Trade Parse]', error?.message ?? error); } }); websocket.addEventListener('error', error => { streamConnected = false; console.error('[WebSocket]', error?.message ?? error); }); websocket.addEventListener('close', () => { streamConnected = false; if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS); }); }
function shutdown(signal) { stopping = true; clearTimeout(reconnectTimer); clearInterval(statsTimer); clearInterval(finalizeTimer); try { websocket?.close(); } catch {} try { server.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
const server = createServer((req, res) => { const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); if (url.pathname === '/cvd' || url.pathname === '/trades') { res.writeHead(200); res.end(JSON.stringify({ ok: true, source: 'Hyperliquid realtime trades', checkedAt: new Date().toISOString(), streamConnected, lastMessageAt, assets: ASSETS, periods: ['5M'], monitor: 'CVD_FLOW_5M', alerts: true, alertRule: 'ONE global smallest absolute non-zero net CVD per completed 5M period; positive=INFLOW, negative=OUTFLOW', data: allStats() })); return; } if (url.pathname === '/health') { res.writeHead(200); res.end(JSON.stringify({ ok: true, service: 'polymarket-cvd-monitor', assets: ASSETS, periods: ['5M'], streamConnected, lastMessageAt, alerts: true })); return; } res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/cvd', '/trades', '/health'] })); });
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics listening on ${HTTP_PORT} (/cvd)`));
console.log('=== POLYMARKET CVD FLOW MONITOR ==='); console.log('SOURCE: HYPERLIQUID REALTIME TRADES ONLY'); console.log('CVD: TOTAL BUY VOLUME - TOTAL SELL VOLUME'); console.log('PERIOD: 5M ONLY'); console.log('ALERT ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB'); console.log('ALERT: ONE GLOBAL SMALLEST ABSOLUTE NON-ZERO NET CVD PER 5M PERIOD'); connect(); statsTimer = setInterval(printStats, STATS_INTERVAL_MS); finalizeTimer = setInterval(finalizeExpiredPeriod, FINALIZE_INTERVAL_MS);
