const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { TIMEFRAMES, bucketStart, findMarketByEpoch, findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME_LIST = ['5m', '15m', '1h', '4h'];
const ALERT_MIN_GAP_MS = 5000;
const POLL_MS = 4000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}?ref=monitor-status`;
const REQUEST_TIMEOUT_MS = 15000;
const LIQUIDATION_DEDUPE_WINDOW_MS = 15 * 60 * 1000;

const sentAlerts = new Set();
const processedBuckets = new Set();
const liquidationDedupeKeys = new Set();
let liquidationDedupePeriod = null;
let stateSaveChain = Promise.resolve();
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

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
    const req = require('https').request({ hostname: u.hostname, path: u.pathname + u.search, method, timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': 'Polymarket-Perps-Monitor', Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN || ''}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }
    }, response => {
      let data = ''; response.setEncoding('utf8'); response.on('data', chunk => { data += chunk; });
      response.on('end', () => { let parsed = null; try { parsed = data ? JSON.parse(data) : null; } catch {}
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(parsed);
        const error = new Error(`GitHub state request failed: ${response.statusCode}`); error.statusCode = response.statusCode; reject(error); });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub state request timed out'))); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
function normalizeAlertKey(key) { if (typeof key !== 'string') return null; return /^(5m|15m|1h|4h):IMBALANCE:(\d+):([A-Z]+):(UP|DOWN)$/.test(key) ? key : null; }
function loadPersistedState(state) {
  for (const key of [...(state?.sentAlerts || []), ...(state?.alerts || [])]) { const normalized = normalizeAlertKey(key); if (normalized) sentAlerts.add(normalized); }
}
async function loadState() {
  if (!process.env.GITHUB_TOKEN) return;
  try { const response = await githubRequest(); if (!response?.content) return; const state = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8')); loadPersistedState(state); console.log('STATE LOADED; imbalance alerts restored; 5m/15m/1h/4h'); }
  catch (error) { console.warn(`STATE LOAD FAILED: ${error.message}`); }
}
async function saveGlobalState() {
  if (!process.env.GITHUB_TOKEN) return;
  for (let attempt = 1; attempt <= 5; attempt += 1) try {
    let response = null; try { response = await githubRequest(); } catch (error) { if (error.statusCode !== 404) throw error; }
    const state = response?.content ? JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8')) : {};
    const keys = new Set([...(state.sentAlerts || []), ...(state.alerts || [])].map(normalizeAlertKey).filter(Boolean)); for (const key of sentAlerts) keys.add(key);
    state.version = 27; state.sentAlerts = [...keys].slice(-5000);
    await githubRequest('PUT', { message: 'Replace streak alerts with imbalance alerts', content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'), branch: 'monitor-status', ...(response?.sha ? { sha: response.sha } : {}) }); return;
  } catch (error) { if (error.statusCode !== 409 || attempt === 5) { console.warn(`STATE SAVE FAILED: ${error.message}`); return; } await new Promise(resolve => setTimeout(resolve, 250 * attempt)); }
}
function queueStateSave() { stateSaveChain = stateSaveChain.then(() => saveGlobalState()).catch(error => console.warn(`STATE SAVE QUEUE FAILED: ${error.message}`)); return stateSaveChain; }
function enqueueAlertSend(message, key, timeframe, symbol, direction) {
  const task = alertSendChain.then(async () => { const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt)); if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
    try { await sendTelegramMessage(message); lastAlertSentAt = Date.now(); console.log(`IMBALANCE ${timeframe.toUpperCase()} ALERT SENT ${symbol} ${direction}`); }
    catch (error) { sentAlerts.delete(key); console.warn(`IMBALANCE ${timeframe.toUpperCase()} ALERT SEND FAILED ${symbol}: ${error.message}`); }
  });
  alertSendChain = task.catch(error => { sentAlerts.delete(key); console.warn(`ALERT QUEUE FAILED ${timeframe} ${symbol}: ${error.message}`); }); return alertSendChain;
}
async function fetchAllFeeds() { return new Map(await Promise.all(SYMBOLS.map(async symbol => { try { return [symbol, await fetchSymbolFeed(symbol)]; } catch (error) { console.warn(`FEED ${symbol} FAILED: ${error.message}`); return [symbol, []]; } }))); }
function eventsForBucket(feeds, timeframe, period) {
  const events = [];
  if (timeframe === '5m') resetLiquidationDedupePeriod(liquidationDedupePeriodStart(period));
  for (const symbol of SYMBOLS) for (const event of feeds.get(symbol) || []) {
    const ts = normalizeTs(event?.ts); if (!ts || bucketStart(ts, timeframe) !== period) continue;
    const eventSide = side(event); if (!eventSide) continue;
    if (timeframe === '5m') {
      const dedupeKey = liquidationDedupeKey(symbol, ts, eventSide, event);
      if (liquidationDedupeKeys.has(dedupeKey)) continue;
      liquidationDedupeKeys.add(dedupeKey);
    }
    events.push({ symbol, ts, side: eventSide, event });
  }
  events.sort((a, b) => a.ts - b.ts); return events;
}
function classifyBucket(events) { const counts = new Map(); for (const symbol of SYMBOLS) counts.set(symbol, { long: 0, short: 0 }); for (const item of events) { const count = counts.get(item.symbol); if (item.side > 0) count.long += 1; else if (item.side < 0) count.short += 1; } return counts; }
async function findNextMarkets(symbol, completedBucketStart, timeframe) { const next = await findNextMarket(symbol, completedBucketStart + TIMEFRAMES[timeframe], timeframe); if (!next) return { next: null, nextPlusOne: null }; if (timeframe === '15m') return { next, nextPlusOne: null }; const nextEpoch = completedBucketStart + TIMEFRAMES[timeframe]; return { next, nextPlusOne: await findMarketByEpoch(symbol, nextEpoch + TIMEFRAMES[timeframe], timeframe) }; }
async function sendAlert(timeframe, period, symbol, imbalance, counts) {
  if (imbalance === 0) return false;
  const direction = imbalance > 0 ? 'UP' : 'DOWN';
  const key = `${timeframe}:IMBALANCE:${period}:${symbol}:${direction}`;
  if (sentAlerts.has(key)) { console.log(`ALERT DUPLICATE SUPPRESSED ${key}`); return false; }
  sentAlerts.add(key);
  let markets = { next: null, nextPlusOne: null }; try { markets = await findNextMarkets(symbol, period, timeframe); } catch (error) { console.warn(`POLYMARKET LOOKUP FAILED ${timeframe} ${symbol}: ${error.message}`); }
  const emoji = direction === 'UP' ? '🟢' : '🔴';
  const links = timeframe === '5m' || timeframe === '15m'
    ? (markets.next?.url ? `➡️ NEXT · Polymarket ${timeframe.toUpperCase()}\n${markets.next.url}` : '')
    : [markets.next?.url ? `➡️ NEXT · Polymarket ${timeframe.toUpperCase()}\n${markets.next.url}` : '', markets.nextPlusOne?.url ? `➡️ NEXT+1 · Polymarket ${timeframe.toUpperCase()}\n${markets.nextPlusOne.url}` : ''].filter(Boolean).join('\n\n');
  const message = [
    `${emoji} ${symbol} · BUY ${direction} · ${timeframe.toUpperCase()}`,
    '',
    `Imbalance: ${imbalance > 0 ? '+' : ''}${formatCount(imbalance)} (LONG − SHORT)`,
    `Current bucket: ${formatCount(counts.long)} LONG · ${formatCount(counts.short)} SHORT`,
    links ? `\n${links}` : ''
  ].join('\n').trim();
  enqueueAlertSend(message, key, timeframe, symbol, direction); return true;
}
async function processCompletedBucket(timeframe, period, feeds) {
  const bucketKey = `${timeframe}:${period}`; if (processedBuckets.has(bucketKey)) return; processedBuckets.add(bucketKey);
  const events = eventsForBucket(feeds, timeframe, period), counts = classifyBucket(events);
  for (const symbol of SYMBOLS) {
    const c = counts.get(symbol);
    const imbalance = c.long - c.short;
    if (imbalance !== 0) console.log(`${timeframe.toUpperCase()} BUCKET ${new Date(period).toISOString()} ${symbol} LONG=${c.long} SHORT=${c.short} IMBALANCE=${imbalance > 0 ? '+' : ''}${imbalance}`);
    if (imbalance !== 0) await sendAlert(timeframe, period, symbol, imbalance, c);
  }
  queueStateSave();
}
async function main() {
  await loadState();
  console.log('LIQUIDATION IMBALANCE MONITOR STARTED; Global imbalance = LONG − SHORT; positive=BUY UP, negative=BUY DOWN; no streaks; no thresholds; 5m/15m/1h/4h; 5m dedupe resets every 15m');
  const lastCompleted = new Map(); while (true) { const now = Date.now(), feeds = await fetchAllFeeds(), bucketTasks = [];
    for (const timeframe of TIMEFRAME_LIST) { const windowMs = TIMEFRAMES[timeframe], current = bucketStart(now, timeframe), completed = current - windowMs; if (!lastCompleted.has(timeframe)) lastCompleted.set(timeframe, completed - windowMs); const previous = lastCompleted.get(timeframe); for (let period = previous + windowMs; period <= completed; period += windowMs) bucketTasks.push(processCompletedBucket(timeframe, period, feeds)); lastCompleted.set(timeframe, completed); }
    if (bucketTasks.length) await Promise.all(bucketTasks); await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
main().catch(error => { console.error(`FATAL: ${error.stack || error.message}`); process.exitCode = 1; });
