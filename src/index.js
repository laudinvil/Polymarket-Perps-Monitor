import { createServer } from 'node:http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PINAX_API_KEY = process.env.PINAX_API_KEY || process.env.PINAX_API_TOKEN;
const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const HTTP_PORT = Number(process.env.PORT || 3000);
const PAGE_LIMIT = 1000;
const alertedPeriods = new Set();
let lastAlertAsset = null;
let boundaryTimer = null;
let stopping = false;
let lastCheck = null;
let lastResult = null;
let lastProcessed5m = null;
let lastProcessed15m = null;

function windowStart(ms, size) { return Math.floor(ms / size) * size; }
function polymarketUrl(asset, startMs, minutes) { return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${minutes}m-${Math.floor(startMs / 1000)}`; }

async function fetchCoinLiquidations(coin, startMs, endMs) {
  if (!PINAX_API_KEY) throw new Error('PINAX_API_KEY/PINAX_API_TOKEN is not configured');
  const all = [];
  let page = 1;
  while (page <= 20) {
    const url = new URL(PINAX_URL);
    url.searchParams.set('coin', coin);
    url.searchParams.set('dex', 'perps');
    url.searchParams.set('start_time', String(Math.floor(startMs / 1000)));
    url.searchParams.set('end_time', String(Math.floor(endMs / 1000)));
    url.searchParams.set('sort_by', 'time');
    url.searchParams.set('limit', String(PAGE_LIMIT));
    url.searchParams.set('page', String(page));
    const response = await fetch(url, { headers: { Authorization: `Bearer ${PINAX_API_KEY}`, Accept: 'application/json' } });
    const raw = await response.text();
    if (!response.ok) throw new Error(`${coin}: Pinax HTTP ${response.status}: ${raw}`);
    let body;
    try { body = JSON.parse(raw); } catch { throw new Error(`${coin}: Pinax returned non-JSON response: ${raw.slice(0, 300)}`); }
    const rows = Array.isArray(body?.data) ? body.data : [];
    all.push(...rows);
    if (rows.length < PAGE_LIMIT) break;
    page += 1;
  }
  return all;
}

function getLiquidatedUser(e) {
  const candidates = [e?.liquidated_user, e?.liquidatedUser, e?.user, e?.account, e?.wallet, e?.address];
  for (const value of candidates) {
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim().toLowerCase();
  }
  return '';
}

async function fetchLiquidationSpike(startMs, endMs) {
  const results = await Promise.all(ASSETS.map(async coin => {
    try {
      const events = await fetchCoinLiquidations(coin, startMs, endMs);
      const users = new Set();
      let longUsers = 0;
      let shortUsers = 0;
      let totalNotional = 0;
      const seenDirectionalUsers = new Set();
      let sampleLogged = false;
      for (const e of events) {
        const user = getLiquidatedUser(e);
        if (!user) {
          if (!sampleLogged) { console.log(`[Pinax] ${coin}: user field missing; sampleKeys=${Object.keys(e || {}).join(',')}`); sampleLogged = true; }
          continue;
        }
        const notional = Number(e?.notional || 0);
        users.add(user);
        totalNotional += Number.isFinite(notional) ? notional : 0;
        const direction = String(e?.direction || e?.liquidation_kind || '').toUpperCase();
        const key = `${user}:${direction}`;
        if (!seenDirectionalUsers.has(key)) {
          seenDirectionalUsers.add(key);
          if (direction.includes('LONG')) longUsers += 1;
          if (direction.includes('SHORT')) shortUsers += 1;
        }
      }
      const result = { coin, users: users.size, longUsers, shortUsers, totalNotional, events: events.length };
      console.log(`[Pinax] ${coin}: events=${events.length} uniqueLiquidated=${users.size} longUsers=${longUsers} shortUsers=${shortUsers} notional=${totalNotional}`);
      return result;
    } catch (error) {
      console.error('[Pinax]', error?.message ?? error);
      return { coin, users: 0, longUsers: 0, shortUsers: 0, totalNotional: 0, events: 0, error: error?.message ?? String(error) };
    }
  }));
  console.log(`[SPIKE] ${JSON.stringify(results)}`);
  return results;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Telegram is not configured');
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
}

async function sendSpikeAlert(periodStart, stats, minutes) {
  const candidates = stats.filter(x => x.users > 0).sort((a, b) => b.users - a.users || b.totalNotional - a.totalNotional);
  if (!candidates.length) return null;
  const winner = candidates.find(x => x.coin !== lastAlertAsset);
  if (!winner) {
    console.log(`[ALERT] skipped ${minutes}M: only qualifying spike is ${lastAlertAsset}`);
    return null;
  }
  const marketStart = periodStart + minutes * 60 * 1000;
  const text = [
    '🚨 LIQUIDATION SPIKE',
    '',
    `${winner.coin} — ${minutes}M`,
    `Liquidated users: ${winner.users}`,
    `LONG users: ${winner.longUsers}`,
    `SHORT users: ${winner.shortUsers}`,
    `Liquidation volume: ${Math.round(winner.totalNotional).toLocaleString('en-US')} USDT`,
    '',
    '▶️ POLYMARKET',
    polymarketUrl(winner.coin, marketStart, minutes)
  ].join('\n');
  await sendTelegram(text);
  lastAlertAsset = winner.coin;
  return { coin: winner.coin, users: winner.users, longUsers: winner.longUsers, shortUsers: winner.shortUsers, totalNotional: winner.totalNotional, timeframe: minutes, market: polymarketUrl(winner.coin, marketStart, minutes) };
}

async function process5m(startMs) {
  if (lastProcessed5m === startMs) return;
  const endMs = startMs + WINDOW_5M;
  const stats = await fetchLiquidationSpike(startMs, endMs);
  lastProcessed5m = startMs;
  const key = `5m:${startMs}`;
  let alert5m = null;
  if (!alertedPeriods.has(key)) { alert5m = await sendSpikeAlert(startMs, stats, 5); if (alert5m) alertedPeriods.add(key); }
  return { periodStart: startMs, periodEnd: endMs, stats, alert5m };
}

async function process15m(startMs) {
  if (lastProcessed15m === startMs) return;
  const endMs = startMs + WINDOW_15M;
  const stats = await fetchLiquidationSpike(startMs, endMs);
  lastProcessed15m = startMs;
  const key = `15m:${startMs}`;
  let alert15m = null;
  if (!alertedPeriods.has(key)) { alert15m = await sendSpikeAlert(startMs, stats, 15); if (alert15m) alertedPeriods.add(key); }
  return { periodStart: startMs, periodEnd: endMs, stats, alert15m };
}

async function processDueWindows() {
  const now = Date.now();
  const closed5m = windowStart(now, WINDOW_5M) - WINDOW_5M;
  const closed15m = windowStart(now, WINDOW_15M) - WINDOW_15M;
  const five = await process5m(closed5m);
  let fifteen = null;
  if (lastProcessed15m !== closed15m) fifteen = await process15m(closed15m);
  lastCheck = new Date().toISOString();
  lastResult = { five, fifteen };
  console.log('[RESULT]', JSON.stringify(lastResult));
}

function scheduleNextBoundary() {
  if (stopping) return;
  clearTimeout(boundaryTimer);
  const now = Date.now();
  const next5m = windowStart(now, WINDOW_5M) + WINDOW_5M;
  const next15m = windowStart(now, WINDOW_15M) + WINDOW_15M;
  const nextBoundary = Math.min(next5m, next15m);
  const delay = Math.max(0, nextBoundary - now);
  console.log(`[SCHEDULER] next boundary: ${new Date(nextBoundary).toISOString()} | delayMs=${delay}`);
  boundaryTimer = setTimeout(async () => {
    if (stopping) return;
    try { await processDueWindows(); } catch (error) { console.error('[Liquidations]', error?.message ?? error); }
    scheduleNextBoundary();
  }, delay);
}

async function start() {
  console.log('=== POLYMARKET LIQUIDATION SPIKE MONITOR ===');
  console.log('SOURCE: PINAX HYPERLIQUID MARKET LIQUIDATIONS');
  console.log('ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
  console.log('PERIODS: 5M + 15M');
  console.log('NO LIQUIDATION SIZE THRESHOLD — ALL LIQUIDATIONS COUNT');
  console.log('RULE: LARGEST NUMBER OF UNIQUE LIQUIDATED USERS PER COIN');
  console.log('REPEAT RULE: CROSS-TIMEFRAME — SAME COIN CANNOT ALERT TWICE IN A ROW');
  console.log('OLD RULE REMOVED: NO MORE ALERTS FOR SINGLE LARGEST LIQUIDATION');
  await processDueWindows();
  scheduleNextBoundary();
}

function shutdown(signal) { stopping = true; clearTimeout(boundaryTimer); try { server.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/health' || url.pathname === '/liquidations') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'polymarket-liquidation-spike-monitor', source: 'Pinax Hyperliquid market liquidations', assets: ASSETS, periods: ['5M', '15M'], minLiquidationSizeUsdt: null, rule: 'largest number of unique liquidated users per coin', repeatRule: 'cross-timeframe same coin cannot alert twice in a row', lastCheck, lastResult }));
    return;
  }
  res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/health', '/liquidations'] }));
});

server.listen(HTTP_PORT, () => {
  console.log(`HTTP diagnostics listening on ${HTTP_PORT}`);
  void start();
});
