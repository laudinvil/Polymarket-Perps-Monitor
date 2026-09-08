const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { TIMEFRAMES, bucketStart, findMarketByEpoch, findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Authoritative monitor: 5m liquidation streaks only.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const ALERT_THRESHOLD = 5;
const ALERT_MIN_GAP_MS = 5000;
const POLL_MS = 4000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}?ref=monitor-status`;
const REQUEST_TIMEOUT_MS = 15000;
const LIQUIDATION_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

const sentAlerts = new Set();
const processedBuckets = new Set();
const streakState = new Map();
const liquidationDedupeKeys = new Set();
let liquidationDedupePeriod = null;
let stateSaveChain = Promise.resolve();
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

for (const symbol of SYMBOLS) streakState.set(symbol, { side: 0, length: 0, lastBucket: 0 });

function getStreak(symbol) { return streakState.get(symbol); }
function side(event) {
  const value = String(event?.side || event?.direction || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 1;
  if (value.includes('short') || value === 'sell') return -1;
  return 0;
}
function formatCount(value) { return Math.max(0, Number(value) || 0).toLocaleString('en-US'); }
function liquidationDedupePeriodStart(ts) { return Math.floor(ts / LIQUIDATION_DEDUPE_WINDOW_MS) * LIQUIDATION_DEDUPE_WINDOW_MS; }
function liquidationDedupeKey(symbol, ts, eventSide, event) {
  const id = event?.id ?? event?.liquidationId ?? event?.eventId ?? event?.tradeId ?? event?.txHash ?? event?.orderId;
  if (id !== undefined && id !== null && String(id) !== '') return `${symbol}:id:${String(id)}`;
  return [symbol, ts, eventSide, event?.price ?? '', event?.qty ?? event?.quantity ?? '', event?.size ?? ''].join('|');
}
function resetLiquidationDedupePeriod(periodStart) {
  if (liquidationDedupePeriod === periodStart) return;
  liquidationDedupePeriod = periodStart;
  liquidationDedupeKeys.clear();
  console.log(`5M LIQUIDATION DEDUPE RESET ${new Date(periodStart).toISOString()} (15m period)`);
}
function githubRequest(method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const u = new URL(STATE_API_URL);
    const req = require('https').request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Polymarket-Perps-Monitor',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN || ''}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {})
      }
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(parsed);
        const error = new Error(`GitHub state request failed: ${response.statusCode}`);
        error.statusCode = response.statusCode;
        reject(error);
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub state request timed out')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}
function normalizeAlertKey(key) {
  if (typeof key !== 'string') return null;
  return /^5m:STREAK:(\d+):([A-Z]+):(1|2)$/.test(key) ? key : null;
}
function loadPersistedState(state) {
  for (const key of [...(state?.sentAlerts || []), ...(state?.alerts || [])]) {
    const normalized = normalizeAlertKey(key);
    if (normalized) sentAlerts.add(normalized);
  }
  for (const symbol of SYMBOLS) {
    const saved = state?.streaks?.['5m']?.[symbol];
    if (!saved) continue;
    const streak = getStreak(symbol);
    streak.side = Number(saved.side) === 1 || Number(saved.side) === -1 ? Number(saved.side) : 0;
    streak.length = Math.max(0, Number(saved.length) || 0);
    streak.lastBucket = Math.max(0, Number(saved.lastBucket) || 0);
  }
}
async function loadState() {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const response = await githubRequest();
    if (!response?.content) return;
    const state = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    loadPersistedState(state);
    console.log('STATE LOADED; 5m liquidation streaks restored; threshold=5+');
  } catch (error) { console.warn(`STATE LOAD FAILED: ${error.message}`); }
}
async function saveGlobalState() {
  if (!process.env.GITHUB_TOKEN) return;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      let response = null;
      try { response = await githubRequest(); } catch (error) { if (error.statusCode !== 404) throw error; }
      const state = response?.content ? JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8')) : {};
      const keys = new Set([...(state.sentAlerts || []), ...(state.alerts || [])].map(normalizeAlertKey).filter(Boolean));
      for (const key of sentAlerts) keys.add(key);
      state.version = 28;
      state.sentAlerts = [...keys].slice(-5000);
      state.streaks = { '5m': {} };
      for (const symbol of SYMBOLS) {
        const streak = getStreak(symbol);
        state.streaks['5m'][symbol] = { side: streak.side, length: streak.length, lastBucket: streak.lastBucket };
      }
      await githubRequest('PUT', {
        message: 'Use 5m liquidation streak monitor only',
        content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'),
        branch: 'monitor-status',
        ...(response?.sha ? { sha: response.sha } : {})
      });
      return;
    } catch (error) {
      if (error.statusCode !== 409 || attempt === 5) { console.warn(`STATE SAVE FAILED: ${error.message}`); return; }
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
}
function queueStateSave() {
  stateSaveChain = stateSaveChain.then(() => saveGlobalState()).catch(error => console.warn(`STATE SAVE QUEUE FAILED: ${error.message}`));
  return stateSaveChain;
}
function enqueueAlertSend(message, key, symbol, streak) {
  const task = alertSendChain.then(async () => {
    const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      console.log(`STREAK 5M ALERT SENT ${symbol} ${streak.side === 1 ? 'LONG' : 'SHORT'} streak=${streak.length}`);
    } catch (error) {
      sentAlerts.delete(key);
      console.warn(`STREAK 5M ALERT SEND FAILED ${symbol}: ${error.message}`);
    }
  });
  alertSendChain = task.catch(error => { sentAlerts.delete(key); console.warn(`ALERT QUEUE FAILED 5m ${symbol}: ${error.message}`); });
  return alertSendChain;
}
async function fetchAllFeeds() {
  return new Map(await Promise.all(SYMBOLS.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol)]; }
    catch (error) { console.warn(`FEED ${symbol} FAILED: ${error.message}`); return [symbol, []]; }
  })));
}
function eventsForBucket(feeds, period) {
  const events = [];
  resetLiquidationDedupePeriod(liquidationDedupePeriodStart(period));
  for (const symbol of SYMBOLS) for (const event of feeds.get(symbol) || []) {
    const ts = normalizeTs(event?.ts);
    if (!ts || bucketStart(ts, TIMEFRAME) !== period) continue;
    const eventSide = side(event);
    if (!eventSide) continue;
    const dedupeKey = liquidationDedupeKey(symbol, ts, eventSide, event);
    if (liquidationDedupeKeys.has(dedupeKey)) continue;
    liquidationDedupeKeys.add(dedupeKey);
    events.push({ symbol, ts, side: eventSide, event });
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}
function classifyBucket(events) {
  const counts = new Map(SYMBOLS.map(symbol => [symbol, { long: 0, short: 0, longUsd: 0, shortUsd: 0 }]));
  for (const item of events) {
    const row = counts.get(item.symbol);
    const notional = Math.max(0, Number(item.event?.notional) || 0);
    if (item.side > 0) { row.long += 1; row.longUsd += notional; }
    else { row.short += 1; row.shortUsd += notional; }
  }
  return counts;
}
function updateStreak(symbol, bucketStartTs, counts) {
  const streak = getStreak(symbol);
  const longCount = counts.long;
  const shortCount = counts.short;
  if (longCount === 0 && shortCount === 0) {
    streak.side = 0; streak.length = 0; streak.lastBucket = bucketStartTs;
    return { side: 0, length: 0, longCount, shortCount, longUsd: counts.longUsd, shortUsd: counts.shortUsd, alert: false };
  }
  if (longCount === shortCount) {
    streak.side = 0; streak.length = 0; streak.lastBucket = bucketStartTs;
    return { side: 0, length: 0, longCount, shortCount, longUsd: counts.longUsd, shortUsd: counts.shortUsd, alert: false };
  }
  const bucketSide = longCount > shortCount ? 1 : -1;
  const expectedPreviousBucket = bucketStartTs - TIMEFRAMES[TIMEFRAME];
  if (streak.side === bucketSide && streak.lastBucket === expectedPreviousBucket) streak.length += 1;
  else streak.length = 1;
  streak.side = bucketSide;
  streak.lastBucket = bucketStartTs;
  return { side: bucketSide, length: streak.length, longCount, shortCount, longUsd: counts.longUsd, shortUsd: counts.shortUsd, alert: streak.length >= ALERT_THRESHOLD };
}
async function findNextMarkets(symbol, completedBucketStart) {
  const next = await findNextMarket(symbol, completedBucketStart + TIMEFRAMES[TIMEFRAME], TIMEFRAME);
  if (!next) return { next: null, nextPlusOne: null };
  const nextPlusOne = await findMarketByEpoch(symbol, completedBucketStart + 2 * TIMEFRAMES[TIMEFRAME], TIMEFRAME);
  return { next, nextPlusOne };
}
async function sendAlert(period, symbol, streak) {
  if (!streak.alert) return false;
  const key = `5m:STREAK:${period}:${symbol}:${streak.side === 1 ? 1 : 2}`;
  if (sentAlerts.has(key)) { console.log(`ALERT DUPLICATE SUPPRESSED ${key}`); return false; }
  sentAlerts.add(key);
  let markets = { next: null, nextPlusOne: null };
  try { markets = await findNextMarkets(symbol, period); }
  catch (error) { console.warn(`POLYMARKET LOOKUP FAILED 5m ${symbol}: ${error.message}`); }
  const isLong = streak.side === 1;
  const direction = isLong ? 'BUY UP' : 'BUY DOWN';
  const emoji = isLong ? '🟢' : '🔴';
  const sideName = isLong ? 'LONG' : 'SHORT';
  const links = [
    markets.next?.url ? `➡️ NEXT · Polymarket 5M\n${markets.next.url}` : '',
    markets.nextPlusOne?.url ? `➡️ NEXT+1 · Polymarket 5M\n${markets.nextPlusOne.url}` : ''
  ].filter(Boolean).join('\n\n');
  const message = [
    `${emoji} ${symbol} · ${direction} · 5M`,
    '',
    `Streak: ${streak.length} ${sideName} buckets`,
    `Current bucket: ${formatCount(streak.longCount)} LONG · ${formatCount(streak.shortCount)} SHORT`,
    links ? `\n${links}` : ''
  ].join('\n').trim();
  enqueueAlertSend(message, key, symbol, streak);
  return true;
}
async function processCompletedBucket(period, feeds) {
  const bucketKey = `5m:${period}`;
  if (processedBuckets.has(bucketKey)) return;
  processedBuckets.add(bucketKey);
  const events = eventsForBucket(feeds, period);
  const counts = classifyBucket(events);
  const results = [];
  for (const symbol of SYMBOLS) {
    const streak = updateStreak(symbol, period, counts.get(symbol));
    results.push({ symbol, streak });
    console.log(JSON.stringify({
      timeframe: '5m', symbol, period, boundaryTs: period,
      imbalanceUsd: streak.longUsd - streak.shortUsd,
      longUsd: streak.longUsd, shortUsd: streak.shortUsd,
      longEvents: streak.longCount, shortEvents: streak.shortCount,
      dominant: streak.side > 0 ? 'LONG' : streak.side < 0 ? 'SHORT' : 'NONE',
      streak: streak.length
    }));
  }
  const eligible = results.filter(item => item.streak.alert);
  const maxStreak = eligible.length ? Math.max(...eligible.map(item => item.streak.length)) : 0;
  for (const { symbol, streak } of results) {
    const isWinner = streak.alert && streak.length === maxStreak;
    console.log(`5M BUCKET ${new Date(period).toISOString()}-${new Date(period + TIMEFRAMES[TIMEFRAME]).toISOString()} ${symbol} LONG=${streak.longCount} SHORT=${streak.shortCount} DOMINANT=${streak.side > 0 ? 'LONG' : streak.side < 0 ? 'SHORT' : 'NONE'} STREAK=${streak.length}${isWinner ? ' ALERT=YES' : ' ALERT=NO'}`);
    if (isWinner) await sendAlert(period, symbol, streak);
  }
  if (maxStreak) console.log(`5M MAX STREAK ${maxStreak}; alerts=${eligible.filter(item => item.streak.length === maxStreak).map(item => item.symbol).join(',')}`);
  queueStateSave();
}
async function main() {
  await loadState();
  console.log(`LIQUIDATION STREAK MONITOR STARTED; all coins=${SYMBOLS.join(',')}; only 5m; threshold=${ALERT_THRESHOLD}+; largest streak only; ties all alert; no imbalance logic`);
  let lastCompleted = null;
  while (true) {
    const now = Date.now();
    const current = bucketStart(now, TIMEFRAME);
    const completed = current - TIMEFRAMES[TIMEFRAME];
    const feeds = await fetchAllFeeds();
    if (lastCompleted === null) lastCompleted = completed - TIMEFRAMES[TIMEFRAME];
    for (let period = lastCompleted + TIMEFRAMES[TIMEFRAME]; period <= completed; period += TIMEFRAMES[TIMEFRAME]) await processCompletedBucket(period, feeds);
    lastCompleted = completed;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
main().catch(error => { console.error(`FATAL: ${error.stack || error.message}`); process.exitCode = 1; });
