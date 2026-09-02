import { createServer } from 'node:http';
import { startBinanceLiquidationStream, stopBinanceLiquidationStream, getBinanceLiquidationStats } from './binance-liquidations.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PINAX_API_KEY = process.env.PINAX_API_KEY || process.env.PINAX_API_TOKEN;
const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const HTTP_PORT = Number(process.env.PORT || 3000);
const PAGE_LIMIT = 10;
const MAX_PAGES_PER_COIN = 30;
const PAGE_DELAY_MS = 350;
const COIN_DELAY_MS = 700;
const RUN_ONCE = process.env.RUN_ONCE === 'true';
const alertedPeriods = new Set();
let boundaryTimer = null;
let stopping = false;
let lastCheck = null;
let lastResult = null;
let lastProcessed5m = null;
let lastProcessed15m = null;

function windowStart(ms, size) { return Math.floor(ms / size) * size; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function parsePinaxTimestamp(value) { if (value === undefined || value === null) return NaN; const text = String(value).trim(); if (!text) return NaN; if (/^\d+(\.\d+)?$/.test(text)) { const numeric = Number(text); return numeric > 1e12 ? numeric : numeric * 1000; } const normalized = text.includes('T') ? text : text.replace(' ', 'T'); const withZone = /(?:Z|[+-]\d\d:\d\d)$/.test(normalized) ? normalized : `${normalized}Z`; const parsed = Date.parse(withZone); return Number.isFinite(parsed) ? parsed : NaN; }
function eventTimestampMs(e) { return parsePinaxTimestamp(e?.timestamp ?? e?.time ?? e?.created_at); }

async function fetchCoinLiquidations(coin, startMs, endMs) {
  if (!PINAX_API_KEY) throw new Error('PINAX_API_KEY/PINAX_API_TOKEN is not configured');
  const all = [];
  let pagesRead = 0;
  for (let page = 1; page <= MAX_PAGES_PER_COIN; page++) {
    const url = new URL(PINAX_URL);
    url.searchParams.set('coin', coin); url.searchParams.set('dex', 'perps'); url.searchParams.set('sort_by', 'time'); url.searchParams.set('limit', String(PAGE_LIMIT)); url.searchParams.set('page', String(page));
    if (page > 1) await sleep(PAGE_DELAY_MS);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${PINAX_API_KEY}`, Accept: 'application/json' } });
    const raw = await response.text();
    if (response.status === 429) { console.error(`[Pinax][RATE_LIMIT] ${coin} page=${page}; stopping this coin`); break; }
    if (!response.ok) throw new Error(`${coin}: Pinax HTTP ${response.status}: ${raw.slice(0, 500)}`);
    let body; try { body = JSON.parse(raw); } catch { throw new Error(`${coin}: Pinax returned non-JSON response`); }
    const rows = Array.isArray(body?.data) ? body.data : [];
    pagesRead = page;
    if (!rows.length) break;
    all.push(...rows);
    const timestamps = rows.map(eventTimestampMs).filter(Number.isFinite);
    if (timestamps.length && Math.min(...timestamps) < startMs) break;
    if (rows.length < PAGE_LIMIT) break;
  }
  const filtered = all.filter(e => { const ts = eventTimestampMs(e); return Number.isFinite(ts) && ts >= startMs && ts < endMs; });
  console.log(`[Pinax][LOCAL_FILTER] ${coin} pages=${pagesRead} fetched=${all.length} matched=${filtered.length}`);
  return filtered;
}
function getLiquidatedUser(e) { const candidates = [e?.liquidated_user, e?.liquidatedUser, e?.user, e?.account, e?.wallet, e?.address]; for (const value of candidates) { if (value !== undefined && value !== null && String(value).trim()) return String(value).trim().toLowerCase(); } return ''; }
async function fetchLiquidationSpike(startMs, endMs) {
  const binanceStats = getBinanceLiquidationStats(startMs, endMs);
  const results = [];
  for (const coin of ASSETS) {
    try {
      const events = await fetchCoinLiquidations(coin, startMs, endMs);
      const users = new Set(); let longUsers = 0; let shortUsers = 0; let totalNotional = 0; const seenDirectionalUsers = new Set();
      for (const e of events) {
        const user = getLiquidatedUser(e); if (!user) continue;
        const notional = Number(e?.notional || 0); users.add(user); if (Number.isFinite(notional)) totalNotional += notional;
        const direction = String(e?.direction || e?.liquidation_kind || '').toUpperCase(); const key = `${user}:${direction}`;
        if (!seenDirectionalUsers.has(key)) { seenDirectionalUsers.add(key); if (direction.includes('LONG')) longUsers++; if (direction.includes('SHORT')) shortUsers++; }
      }
      const bn = binanceStats[coin] || { events: 0, longVolume: 0, shortVolume: 0, totalVolume: 0 };
      results.push({ coin, users: users.size, longUsers, shortUsers, totalNotional, events: events.length, binanceEvents: bn.events, binanceLongVolume: bn.longVolume, binanceShortVolume: bn.shortVolume, binanceTotalVolume: bn.totalVolume });
    } catch (error) {
      console.error(`[Pinax][ERROR] ${coin}:`, error?.message ?? error); const bn = binanceStats[coin] || { events: 0, longVolume: 0, shortVolume: 0, totalVolume: 0 };
      results.push({ coin, users: 0, longUsers: 0, shortUsers: 0, totalNotional: 0, events: 0, binanceEvents: bn.events, binanceLongVolume: bn.longVolume, binanceShortVolume: bn.shortVolume, binanceTotalVolume: bn.totalVolume, error: error?.message ?? String(error) });
    }
    if (!stopping) await sleep(COIN_DELAY_MS);
  }
  console.log(`[SPIKE][STATS] ${JSON.stringify(results)}`);
  return results;
}

async function process5m(startMs) { if (lastProcessed5m === startMs) return; const endMs = startMs + WINDOW_5M; const stats = await fetchLiquidationSpike(startMs, endMs); lastProcessed5m = startMs; return { periodStart: startMs, periodEnd: endMs, stats }; }
async function process15m(startMs) { if (lastProcessed15m === startMs) return; const endMs = startMs + WINDOW_15M; const stats = await fetchLiquidationSpike(startMs, endMs); lastProcessed15m = startMs; return { periodStart: startMs, periodEnd: endMs, stats }; }
async function processDueWindows() { const now = Date.now(); const closed5m = windowStart(now, WINDOW_5M) - WINDOW_5M; const closed15mStart = windowStart(now, WINDOW_15M) - WINDOW_15M; const five = await process5m(closed5m); const fifteen = lastProcessed15m !== closed15mStart ? await process15m(closed15mStart) : null; lastCheck = new Date().toISOString(); lastResult = { five, fifteen }; console.log('[RESULT]', JSON.stringify(lastResult)); }
function scheduleNextBoundary() { if (stopping) return; clearTimeout(boundaryTimer); const now = Date.now(); const next5m = windowStart(now, WINDOW_5M) + WINDOW_5M; const next15m = windowStart(now, WINDOW_15M) + WINDOW_15M; const nextBoundary = Math.min(next5m, next15m); boundaryTimer = setTimeout(async () => { if (stopping) return; try { await processDueWindows(); } catch (error) { console.error('[Liquidations]', error?.message ?? error); } scheduleNextBoundary(); }, Math.max(0, nextBoundary - now)); }
async function start() { console.log('=== LIQUIDATION DATA MONITOR (ALERTS DISABLED) ==='); console.log('SPIKE data collection remains active for diagnostics; NO SPIKE TELEGRAM ALERTS'); console.log('BINANCE: realtime forceOrder stream'); console.log('PINAX: limit=10, rate-limit-safe sequential pagination'); startBinanceLiquidationStream(); await processDueWindows(); if (RUN_ONCE) { stopping = true; stopBinanceLiquidationStream(); boundaryTimer = null; server.close(() => console.log('[RUN_ONCE] done')); return; } scheduleNextBoundary(); }
function shutdown(signal) { stopping = true; clearTimeout(boundaryTimer); stopBinanceLiquidationStream(); try { server.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
const server = createServer((req, res) => { const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); if (url.pathname === '/health' || url.pathname === '/liquidations') { res.writeHead(200); res.end(JSON.stringify({ ok: true, lastCheck, lastResult })); return; } res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found' })); });
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics server listening on :${HTTP_PORT}`));
start().catch(error => { console.error('[FATAL]', error?.stack ?? error); process.exitCode = 1; });
