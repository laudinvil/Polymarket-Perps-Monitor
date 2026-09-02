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
const PAGE_LIMIT = 100;
const MAX_PAGES_PER_COIN = 12;
const PAGE_DELAY_MS = 250;
const COIN_DELAY_MS = 500;
const RUN_ONCE = process.env.RUN_ONCE === 'true';
const alertedPeriods = new Set();
let lastAlertAsset = null;
let boundaryTimer = null;
let stopping = false;
let lastCheck = null;
let lastResult = null;
let lastProcessed5m = null;
let lastProcessed15m = null;

function windowStart(ms, size) { return Math.floor(ms / size) * size; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function polymarketUrl(asset, startMs, minutes) { return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${minutes}m-${Math.floor(startMs / 1000)}`; }
function parsePinaxTimestamp(value) { if (value === undefined || value === null) return NaN; const text = String(value).trim(); if (!text) return NaN; if (/^\d+(\.\d+)?$/.test(text)) { const numeric = Number(text); return numeric > 1e12 ? numeric : numeric * 1000; } const normalized = text.includes('T') ? text : text.replace(' ', 'T'); const withZone = /(?:Z|[+-]\d\d:\d\d)$/.test(normalized) ? normalized : `${normalized}Z`; const parsed = Date.parse(withZone); return Number.isFinite(parsed) ? parsed : NaN; }
function eventTimestampMs(e) { return parsePinaxTimestamp(e?.timestamp ?? e?.time ?? e?.created_at); }

async function fetchCoinLiquidations(coin, startMs, endMs) {
  if (!PINAX_API_KEY) throw new Error('PINAX_API_KEY/PINAX_API_TOKEN is not configured');
  const all = [];
  let pagesRead = 0;
  for (let page = 1; page <= MAX_PAGES_PER_COIN; page++) {
    const url = new URL(PINAX_URL); url.searchParams.set('coin', coin); url.searchParams.set('dex', 'perps'); url.searchParams.set('sort_by', 'time'); url.searchParams.set('limit', String(PAGE_LIMIT)); url.searchParams.set('page', String(page));
    if (page > 1) await sleep(PAGE_DELAY_MS);
    console.log(`[Pinax][REQUEST] ${coin} page=${page}/${MAX_PAGES_PER_COIN} limit=${PAGE_LIMIT}`);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${PINAX_API_KEY}`, Accept: 'application/json' } });
    const raw = await response.text(); if (!response.ok) throw new Error(`${coin}: Pinax HTTP ${response.status}: ${raw.slice(0, 500)}`);
    let body; try { body = JSON.parse(raw); } catch { throw new Error(`${coin}: Pinax returned non-JSON response: ${raw.slice(0, 300)}`); }
    const rows = Array.isArray(body?.data) ? body.data : [];
    pagesRead = page;
    console.log(`[Pinax][RESPONSE] ${coin} page=${page} rows=${rows.length}`);
    if (!rows.length) break;
    all.push(...rows);
    const timestamps = rows.map(eventTimestampMs).filter(Number.isFinite);
    if (timestamps.length) {
      const oldest = Math.min(...timestamps);
      const newest = Math.max(...timestamps);
      console.log(`[Pinax][PAGE_RANGE] ${coin} page=${page} oldest=${new Date(oldest).toISOString()} newest=${new Date(newest).toISOString()}`);
      if (oldest < startMs) break;
    }
    if (rows.length < PAGE_LIMIT) break;
  }
  const filtered = all.filter(e => { const ts = eventTimestampMs(e); return Number.isFinite(ts) && ts >= startMs && ts < endMs; });
  console.log(`[Pinax][LOCAL_FILTER] ${coin} pages=${pagesRead} fetched=${all.length} matched=${filtered.length} window=${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`);
  return filtered;
}
function getLiquidatedUser(e) { const candidates = [e?.liquidated_user, e?.liquidatedUser, e?.user, e?.account, e?.wallet, e?.address]; for (const value of candidates) { if (value !== undefined && value !== null && String(value).trim()) return String(value).trim().toLowerCase(); } return ''; }
async function fetchLiquidationSpike(startMs, endMs) {
  console.log(`[SPIKE][WINDOW] ${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`);
  const binanceStats = getBinanceLiquidationStats(startMs, endMs);
  console.log(`[BINANCE][WINDOW] ${JSON.stringify(binanceStats)}`);
  const results = [];
  for (const coin of ASSETS) {
    try {
      const events = await fetchCoinLiquidations(coin, startMs, endMs);
      const users = new Set(); let longUsers = 0; let shortUsers = 0; let totalNotional = 0; const seenDirectionalUsers = new Set(); let sampleLogged = false;
      for (const e of events) {
        const user = getLiquidatedUser(e);
        if (!user) { if (!sampleLogged) { console.log(`[Pinax][USER_MISSING] ${coin} sample=${JSON.stringify(e).slice(0, 1000)}`); sampleLogged = true; } continue; }
        const notional = Number(e?.notional || 0); users.add(user); totalNotional += Number.isFinite(notional) ? notional : 0;
        const direction = String(e?.direction || e?.liquidation_kind || '').toUpperCase(); const key = `${user}:${direction}`;
        if (!seenDirectionalUsers.has(key)) { seenDirectionalUsers.add(key); if (direction.includes('LONG')) longUsers += 1; if (direction.includes('SHORT')) shortUsers += 1; }
      }
      const bn = binanceStats[coin] || { events: 0, longVolume: 0, shortVolume: 0, totalVolume: 0 };
      const result = { coin, users: users.size, longUsers, shortUsers, totalNotional, events: events.length, binanceEvents: bn.events, binanceLongVolume: bn.longVolume, binanceShortVolume: bn.shortVolume, binanceTotalVolume: bn.totalVolume };
      console.log(`[Pinax][STATS] ${coin} events=${events.length} uniqueLiquidated=${users.size} longUsers=${longUsers} shortUsers=${shortUsers} notional=${totalNotional}`);
      console.log(`[BINANCE][STATS] ${coin} events=${bn.events} longVolume=${bn.longVolume} shortVolume=${bn.shortVolume} totalVolume=${bn.totalVolume}`);
      results.push(result);
    } catch (error) { console.error(`[Pinax][ERROR] ${coin}:`, error?.message ?? error); const bn = binanceStats[coin] || { events: 0, longVolume: 0, shortVolume: 0, totalVolume: 0 }; results.push({ coin, users: 0, longUsers: 0, shortUsers: 0, totalNotional: 0, events: 0, binanceEvents: bn.events, binanceLongVolume: bn.longVolume, binanceShortVolume: bn.shortVolume, binanceTotalVolume: bn.totalVolume, error: error?.message ?? String(error) }); }
    if (!stopping) await sleep(COIN_DELAY_MS);
  }
  console.log(`[SPIKE][STATS] ${JSON.stringify(results)}`); return results;
}
async function sendTelegram(text) { if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Telegram is not configured'); console.log(`[TELEGRAM][SEND] chat=${TELEGRAM_CHAT_ID} text=${JSON.stringify(text)}`); const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) }); const raw = await response.text(); console.log(`[TELEGRAM][RESULT] HTTP ${response.status}: ${raw.slice(0, 500)}`); if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${raw}`); }
async function sendSpikeAlert(periodStart, stats, minutes) {
  const candidates = stats.filter(x => x.users > 0 || x.binanceTotalVolume > 0).sort((a, b) => b.users - a.users || b.totalNotional + b.binanceTotalVolume - (a.totalNotional + a.binanceTotalVolume));
  console.log(`[ALERT][CANDIDATES] ${minutes}M ${JSON.stringify(candidates)}`);
  if (!candidates.length) { console.log(`[ALERT][NO_WINNER] ${minutes}M: no Pinax users and no Binance liquidation volume`); return null; }
  const winner = candidates.find(x => x.coin !== lastAlertAsset);
  if (!winner) { console.log(`[ALERT][SKIP_REPEAT] ${minutes}M: winner=${candidates[0].coin}, lastAlertAsset=${lastAlertAsset}`); return null; }
  const marketStart = periodStart + minutes * 60 * 1000;
  const lines = ['🚨 LIQUIDATION SPIKE', '', `${winner.coin} — ${minutes}M`];
  if (winner.longUsers > 0) lines.push(`LONG users: ${winner.longUsers}`);
  if (winner.shortUsers > 0) lines.push(`SHORT users: ${winner.shortUsers}`);
  lines.push(`Liquidation volume: ${Math.round(winner.totalNotional).toLocaleString('en-US')} USDT`);
  if (winner.binanceTotalVolume > 0) lines.push(`Binance liquidation volume: ${Math.round(winner.binanceTotalVolume).toLocaleString('en-US')} USDT`);
  lines.push('', '▶️ POLYMARKET', polymarketUrl(winner.coin, marketStart, minutes));
  const text = lines.join('\n');
  console.log(`[ALERT][WINNER] ${minutes}M ${winner.coin} users=${winner.users} pinaxVolume=${winner.totalNotional} binanceVolume=${winner.binanceTotalVolume}`);
  await sendTelegram(text); lastAlertAsset = winner.coin; console.log(`[ALERT][SENT] ${minutes}M ${winner.coin}`);
  return { coin: winner.coin, users: winner.users, longUsers: winner.longUsers, shortUsers: winner.shortUsers, totalNotional: winner.totalNotional, binanceTotalVolume: winner.binanceTotalVolume, timeframe: minutes, market: polymarketUrl(winner.coin, marketStart, minutes) };
}
async function process5m(startMs) { if (lastProcessed5m === startMs) return; const endMs = startMs + WINDOW_5M; console.log(`[PROCESS][5M] start=${new Date(startMs).toISOString()}`); const stats = await fetchLiquidationSpike(startMs, endMs); const key = `5m:${startMs}`; let alert5m = null; if (!alertedPeriods.has(key)) { alert5m = await sendSpikeAlert(startMs, stats, 5); if (alert5m) alertedPeriods.add(key); } lastProcessed5m = startMs; return { periodStart: startMs, periodEnd: endMs, stats, alert5m }; }
async function process15m(startMs) { if (lastProcessed15m === startMs) return; const endMs = startMs + WINDOW_15M; console.log(`[PROCESS][15M] start=${new Date(startMs).toISOString()}`); const stats = await fetchLiquidationSpike(startMs, endMs); const key = `15m:${startMs}`; let alert15m = null; if (!alertedPeriods.has(key)) { alert15m = await sendSpikeAlert(startMs, stats, 15); if (alert15m) alertedPeriods.add(key); } lastProcessed15m = startMs; return { periodStart: startMs, periodEnd: endMs, stats, alert15m }; }
async function processDueWindows() { const now = Date.now(); const closed5m = windowStart(now, WINDOW_5M) - WINDOW_5M; const closed15mStart = windowStart(now, WINDOW_15M) - WINDOW_15M; console.log(`[SCHEDULER][DUE] now=${new Date(now).toISOString()} closed5m=${new Date(closed5m).toISOString()} closed15m=${new Date(closed15mStart).toISOString()}..${new Date(closed15mStart + WINDOW_15M).toISOString()}`); const five = await process5m(closed5m); let fifteen = null; if (lastProcessed15m !== closed15mStart) fifteen = await process15m(closed15mStart); lastCheck = new Date().toISOString(); lastResult = { five, fifteen }; console.log('[RESULT]', JSON.stringify(lastResult)); }
function scheduleNextBoundary() { if (stopping) return; clearTimeout(boundaryTimer); const now = Date.now(); const next5m = windowStart(now, WINDOW_5M) + WINDOW_5M; const next15m = windowStart(now, WINDOW_15M) + WINDOW_15M; const nextBoundary = Math.min(next5m, next15m); const delay = Math.max(0, nextBoundary - now); console.log(`[SCHEDULER] next boundary: ${new Date(nextBoundary).toISOString()} | delayMs=${delay}`); boundaryTimer = setTimeout(async () => { if (stopping) return; try { await processDueWindows(); } catch (error) { console.error('[Liquidations]', error?.message ?? error); } scheduleNextBoundary(); }, delay); }
async function start() { console.log('=== POLYMARKET LIQUIDATION SPIKE MONITOR ==='); console.log('SOURCES: PINAX HYPERLIQUID + BINANCE FUTURES FORCE ORDER'); console.log('ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB'); console.log('PERIODS: 5M + 15M'); console.log('PINAX: unique liquidated users + volume'); console.log('BINANCE: liquidation events + volume (no user identities exposed)'); console.log('NO LIQUIDATION SIZE THRESHOLD — ALL LIQUIDATIONS COUNT'); console.log('RULE: rank by unique Pinax users first, then combined liquidation volume; Binance-only volume can produce a candidate when Pinax has no users'); console.log('TIME FILTER: Pinax local timestamp filter; Binance realtime events stored in memory'); console.log(`PAGINATION: max ${MAX_PAGES_PER_COIN} pages/coin, ${PAGE_DELAY_MS}ms page delay, ${COIN_DELAY_MS}ms coin delay, sequential coins`); console.log('15M WINDOW: PREVIOUS FULLY CLOSED POLYMARKET QUARTER-HOUR INTERVAL'); console.log(`RUN_ONCE: ${RUN_ONCE}`); console.log('DIRECTION ALERT: show LONG users only when >0; show SHORT users only when >0'); startBinanceLiquidationStream(); await processDueWindows(); if (RUN_ONCE) { console.log('[RUN_ONCE] Diagnostic cycle complete; exiting.'); stopping = true; stopBinanceLiquidationStream(); boundaryTimer = null; server.close(() => console.log('[RUN_ONCE] HTTP diagnostics server closed.')); return; } scheduleNextBoundary(); }
function shutdown(signal) { stopping = true; clearTimeout(boundaryTimer); stopBinanceLiquidationStream(); try { server.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT')); process.on('SIGTERM', () => shutdown('SIGTERM'));
const server = createServer((req, res) => { const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`); res.setHeader('content-type', 'application/json; charset=utf-8'); res.setHeader('cache-control', 'no-store'); if (url.pathname === '/health' || url.pathname === '/liquidations') { res.writeHead(200); res.end(JSON.stringify({ ok: true, lastCheck, lastResult })); return; } res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found' })); });
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics server listening on :${HTTP_PORT}`));
start().catch(error => { console.error('[FATAL]', error?.stack ?? error); process.exitCode = 1; });
