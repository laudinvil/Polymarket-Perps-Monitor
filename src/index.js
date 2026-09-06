const https = require('https');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol } = require('./liquidation-monitor');
const { TIMEFRAMES, findMarketByEpoch } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const FRAMEWORKS = ['5m', '15m', '1h', '4h', '1d'];
const BOUNDARY_GRACE_MS = 1500;
const REQUEST_TIMEOUT_MS = 15000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const HISTORICAL_URL = 'https://marginpad.io/api/v1/liquidations/recent';
const sentAlerts = new Set();
const timeframeState = new Map();
let stateSha = null;

function emptySymbolState() {
  return { imbalanceUsd: 0, longUsd: 0, shortUsd: 0, longEvents: 0, shortEvents: 0, events: 0, establishedSign: 0, lastBucket: null, buckets: {} };
}
for (const timeframe of FRAMEWORKS) timeframeState.set(timeframe, new Map());
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function bucketStart(ts, timeframe) { const size = TIMEFRAMES[timeframe]; return Math.floor(ts / size) * size; }
function nextBoundary(ts) { let next = Infinity; for (const timeframe of FRAMEWORKS) next = Math.min(next, bucketStart(ts, timeframe) + TIMEFRAMES[timeframe]); return next; }
function formatUsd(value) { const sign = value > 0 ? '+' : value < 0 ? '-' : ''; return `${sign}$${Math.round(Math.abs(value)).toLocaleString('en-US')}`; }
function formatAbsoluteUsd(value) { return `$${Math.round(Math.abs(value)).toLocaleString('en-US')}`; }
function eventSideSign(event) { const side = String(event?.side || event?.direction || '').toLowerCase(); if (side.includes('long')) return 1; if (side.includes('short')) return -1; return 0; }
function eventNotionalUsd(event) { const value = event?.notional ?? event?.usd ?? event?.value ?? event?.amount; const n = Number(value); return Number.isFinite(n) ? Math.abs(n) : 0; }

function githubRequest(method = 'GET', body = undefined) {
  return new Promise((resolve, reject) => {
    const url = new URL(STATE_API_URL);
    const req = https.request({ hostname: url.hostname, path: `${url.pathname}${url.search}`, method, timeout: REQUEST_TIMEOUT_MS, headers: { 'User-Agent': 'Polymarket-Perps-Monitor', 'Accept': 'application/vnd.github+json', 'Authorization': `Bearer ${process.env.GITHUB_TOKEN || ''}`, 'X-GitHub-Api-Version': '2022-11-28' } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', chunk => { data += chunk; });
      res.on('end', () => { let parsed = null; try { parsed = data ? JSON.parse(data) : null; } catch {} if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed); const error = new Error(`GitHub state request failed: ${res.statusCode} ${data}`); error.statusCode = res.statusCode; reject(error); });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub state request timed out'))); req.on('error', reject); if (body !== undefined) req.write(JSON.stringify(body)); req.end();
  });
}

function buildStatePayload() {
  const liquidationTimeframes = {};
  for (const timeframe of FRAMEWORKS) {
    liquidationTimeframes[timeframe] = {};
    for (const symbol of symbols) liquidationTimeframes[timeframe][symbol] = timeframeState.get(timeframe).get(symbol) || emptySymbolState();
  }
  return { version: 3, updatedAt: new Date().toISOString(), sentAlerts: [...sentAlerts], liquidationTimeframes };
}

function migrateAlertKey(key) {
  if (typeof key !== 'string') return null;
  const current = key.match(/^(5m|15m|1h|4h|1d):([A-Z]+):(\d+):(-?1)$/);
  if (current) return key;
  const legacy = key.match(/^(5m|15m|1h|4h|1d):([A-Z]+):(\d+):(-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)$/i);
  if (!legacy) return null;
  const value = Number(legacy[4]);
  if (!Number.isFinite(value) || value === 0) return null;
  return `${legacy[1]}:${legacy[2]}:${legacy[3]}:${value > 0 ? 1 : -1}`;
}

function mergeStateAlerts(state) {
  for (const key of [...(state?.sentAlerts || []), ...(state?.alerts || [])]) {
    const migrated = migrateAlertKey(key);
    if (migrated) sentAlerts.add(migrated);
  }
}

async function loadState() {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const result = await githubRequest('GET'); stateSha = result?.sha || null; if (!result?.content) return;
    const decoded = Buffer.from(result.content.replace(/\s/g, ''), 'base64').toString('utf8'); const state = JSON.parse(decoded); mergeStateAlerts(state);
    for (const timeframe of FRAMEWORKS) { const map = timeframeState.get(timeframe); for (const symbol of symbols) { const saved = state.liquidationTimeframes?.[timeframe]?.[symbol]; if (saved) map.set(symbol, { ...emptySymbolState(), ...saved, buckets: saved.buckets && typeof saved.buckets === 'object' ? saved.buckets : {} }); } }
    console.log(`STATE LOADED ${state.updatedAt || 'unknown'}; dedup keys=${sentAlerts.size}`);
  } catch (error) { console.warn(`STATE LOAD FAILED: ${error.message}`); }
}

async function saveState() {
  if (!process.env.GITHUB_TOKEN) return false;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const latest = await githubRequest('GET'); stateSha = latest?.sha || null;
      if (latest?.content) {
        try { mergeStateAlerts(JSON.parse(Buffer.from(latest.content.replace(/\s/g, ''), 'base64').toString('utf8'))); } catch {}
      }
      const payload = buildStatePayload();
      const body = { message: 'Persist multi-timeframe liquidation state', content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'), branch: process.env.GITHUB_REF_NAME || 'main', ...(stateSha ? { sha: stateSha } : {}) };
      const result = await githubRequest('PUT', body); stateSha = result?.content?.sha || stateSha; console.log(`STATE SAVED ${payload.updatedAt}`); return true;
    } catch (error) {
      if (error.statusCode !== 409 || attempt === 5) { console.warn(`STATE SAVE FAILED: ${error.message}`); return false; }
      console.warn(`STATE SAVE CONFLICT; re-reading state and retrying (${attempt + 1}/5)`); await sleep(250 * attempt);
    }
  }
  return false;
}

async function reserveAlertKey(alertKey) {
  if (sentAlerts.has(alertKey)) { console.log(`ALERT DUPLICATE SUPPRESSED ${alertKey}`); return false; }
  if (!process.env.GITHUB_TOKEN) { sentAlerts.add(alertKey); return true; }
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const latest = await githubRequest('GET');
      const latestSha = latest?.sha || null;
      if (latest?.content) {
        try {
          const latestState = JSON.parse(Buffer.from(latest.content.replace(/\s/g, ''), 'base64').toString('utf8'));
          const latestKeys = new Set();
          for (const key of [...(latestState.sentAlerts || []), ...(latestState.alerts || [])]) { const migrated = migrateAlertKey(key); if (migrated) latestKeys.add(migrated); }
          if (latestKeys.has(alertKey)) { sentAlerts.add(alertKey); console.log(`ALERT DUPLICATE SUPPRESSED ${alertKey}`); return false; }
          for (const key of latestKeys) sentAlerts.add(key);
        } catch {}
      }
      sentAlerts.add(alertKey);
      const payload = buildStatePayload();
      await githubRequest('PUT', { message: `Reserve liquidation alert ${alertKey}`, content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'), branch: process.env.GITHUB_REF_NAME || 'main', ...(latestSha ? { sha: latestSha } : {}) });
      console.log(`ALERT RESERVED ${alertKey}`);
      return true;
    } catch (error) {
      sentAlerts.delete(alertKey);
      if (error.statusCode !== 409 || attempt === 5) { console.warn(`ALERT RESERVATION FAILED ${alertKey}: ${error.message}`); return false; }
      console.warn(`ALERT RESERVATION CONFLICT ${alertKey}; retrying (${attempt + 1}/5)`); await sleep(250 * attempt);
    }
  }
  return false;
}

function extractHistoricalBuckets(json) {
  const roots = [json?.data, json]; const candidates = ['buckets', 'histogram', 'rows', 'series', 'bars', 'points', 'items', 'data']; const seen = new Set(); const queue = roots.map(root => ({ value: root, depth: 0 }));
  while (queue.length) { const { value, depth } = queue.shift(); if (!value || depth > 3 || typeof value !== 'object' || seen.has(value)) continue; seen.add(value); if (Array.isArray(value)) { if (value.some(row => row && typeof row === 'object' && !Array.isArray(row))) return value; continue; } for (const key of candidates) if (Array.isArray(value[key]) && value[key].length) return value[key]; for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 }); }
  return [];
}
function numericValue(value) { if (value === null || value === undefined || value === '') return 0; if (typeof value === 'number') return Number.isFinite(value) ? value : 0; if (typeof value === 'object') { for (const key of ['usd', 'value', 'notional', 'amount', 'total', 'volume', 'vol']) { const n = numericValue(value[key]); if (n) return n; } return 0; } const n = Number(String(value).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; }
function bucketValue(row, names, direction) { for (const name of names) { const value = numericValue(row?.[name]); if (value !== 0) return Math.abs(value); } if (row && typeof row === 'object') for (const [key, raw] of Object.entries(row)) { const lower = key.toLowerCase(); if (!lower.includes(direction)) continue; if (!/(usd|notional|volume|value|amount|liquid)/i.test(lower) && lower !== direction) continue; const value = numericValue(raw); if (value !== 0) return Math.abs(value); } return 0; }
function historicalRowTs(row) { const aliases = ['ts', 'timestamp', 'time', 't', 'bucket', 'start', 'startTime', 'start_ts', 'startTimeMs', 'bucketStart', 'bucket_start', 'epoch', 'date']; for (const key of aliases) { const ts = normalizeTs(row?.[key]); if (ts) return ts; } if (row && typeof row === 'object') for (const [key, raw] of Object.entries(row)) { if (!/(time|timestamp|bucket|start|epoch|date|^ts$)/i.test(key)) continue; const ts = normalizeTs(raw); if (ts) return ts; } return null; }

async function fetchHistoricalEvents(symbol, timeframe) {
  const minutes = ({ '15m': 15, '1h': 60, '4h': 240, '1d': 1440 })[timeframe]; if (!minutes) return { events: [], buckets: new Set() };
  const url = `${HISTORICAL_URL}?symbol=${encodeURIComponent(symbol)}&minutes=${Math.max(minutes * 2, 60)}`;
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`MarginPad historical request failed: ${response.status}`);
    const json = await response.json();
    const rows = extractHistoricalBuckets(json); const events = []; const buckets = new Set(); let timestampedRows = 0; let valuedRows = 0;
    for (const row of rows) { const ts = historicalRowTs(row); if (!ts) continue; timestampedRows++; const period = bucketStart(ts, timeframe); buckets.add(period); const longUsd = bucketValue(row, ['long_liquidations', 'longLiquidations', 'long_usd', 'longUsd', 'long_volume', 'longVolume', 'longNotional', 'long_notional', 'long', 'buy'], 'long'); const shortUsd = bucketValue(row, ['short_liquidations', 'shortLiquidations', 'short_usd', 'shortUsd', 'short_volume', 'shortVolume', 'shortNotional', 'short_notional', 'short', 'sell'], 'short'); if (longUsd > 0) { events.push({ ts, side: 'long_liquidated', notional: longUsd }); valuedRows++; } if (shortUsd > 0) { events.push({ ts, side: 'short_liquidated', notional: shortUsd }); valuedRows++; } }
    console.log(`HISTORICAL ${timeframe} ${symbol}: rows=${rows.length} timestamped=${timestampedRows} buckets=${buckets.size} valued=${valuedRows} events=${events.length}`); return { events, buckets, available: true };
  } catch (error) { console.warn(`HISTORICAL ${timeframe} ${symbol} FAILED: ${error.message}`); return { events: [], buckets: new Set(), available: false }; }
}

async function fetchEventsForTimeframe(timeframe) {
  const result = new Map();
  if (timeframe === '5m') { for (const symbol of symbols) { if (symbol === 'HYPE') continue; const events = await fetchSymbolFeed(symbol); result.set(symbol, events || []); } return result; }
  for (const symbol of symbols) result.set(symbol, await fetchHistoricalEvents(symbol, timeframe));
  return result;
}
function eventsForBucket(source, timeframe, period) { const events = Array.isArray(source) ? source : source?.events || []; return events.filter(event => bucketStart(normalizeTs(event.ts), timeframe) === period); }
function bucketIsAvailable(source, timeframe, period) { if (Array.isArray(source)) return true; return source?.available === true; }

function applyCompletedBucket(timeframe, eventsBySymbol, completedBucket) {
  const map = timeframeState.get(timeframe); const crossings = [];
  for (const symbol of symbols) {
    if (timeframe === '5m' && symbol === 'HYPE') continue;
    const source = eventsBySymbol.get(symbol) || []; const state = map.get(symbol) || emptySymbolState(); state.buckets = state.buckets && typeof state.buckets === 'object' ? state.buckets : {}; const bucketKey = String(completedBucket); if (state.buckets[bucketKey]) { if (state.lastBucket === null || completedBucket > state.lastBucket) state.lastBucket = completedBucket; map.set(symbol, state); continue; } if (state.lastBucket !== null && completedBucket <= state.lastBucket) continue;
    if (!bucketIsAvailable(source, timeframe, completedBucket)) { console.log(`BUCKET NOT AVAILABLE ${timeframe} ${symbol} ${new Date(completedBucket).toISOString()}; keeping lastBucket=${state.lastBucket}`); continue; }
    let longUsd = 0, shortUsd = 0, longEvents = 0, shortEvents = 0, lastTs = null;
    for (const event of eventsForBucket(source, timeframe, completedBucket)) { const ts = normalizeTs(event.ts); const sign = eventSideSign(event); const usd = eventNotionalUsd(event); if (!sign || usd <= 0) continue; if (sign > 0) { longUsd += usd; longEvents++; } else { shortUsd += usd; shortEvents++; } if (!lastTs || ts > lastTs) lastTs = ts; }
    const before = state.imbalanceUsd; const oldSign = state.establishedSign || 0; state.imbalanceUsd += longUsd - shortUsd; state.longUsd += longUsd; state.shortUsd += shortUsd; state.longEvents += longEvents; state.shortEvents += shortEvents; state.events += longEvents + shortEvents; state.lastBucket = completedBucket; state.buckets[bucketKey] = { longUsd, shortUsd, longEvents, shortEvents, events: longEvents + shortEvents };
    const newSign = state.imbalanceUsd > 0 ? 1 : state.imbalanceUsd < 0 ? -1 : 0;
    if (oldSign !== 0 && newSign !== 0 && newSign !== oldSign) crossings.push({ timeframe, symbol, before, after: state.imbalanceUsd, updateLongUsd: longUsd, updateShortUsd: shortUsd, longUsd: state.longUsd, shortUsd: state.shortUsd, longEvents: state.longEvents, shortEvents: state.shortEvents, ts: lastTs || completedBucket + TIMEFRAMES[timeframe], period: completedBucket });
    if (newSign !== 0) state.establishedSign = newSign; map.set(symbol, state); console.log(JSON.stringify({ timeframe, symbol, period: completedBucket, longUsd, shortUsd, imbalanceUsd: state.imbalanceUsd, establishedSign: state.establishedSign, lastBucket: state.lastBucket }));
  }
  return crossings;
}

async function sendCrossingAlert(crossing) {
  const alertKey = `${crossing.timeframe}:${crossing.symbol}:${crossing.period}:${crossing.after > 0 ? 1 : -1}`;
  if (!(await reserveAlertKey(alertKey))) return;
  const nextMarket = await findMarketByEpoch(crossing.symbol, crossing.period + TIMEFRAMES[crossing.timeframe], crossing.timeframe);
  if (!nextMarket) throw new Error(`No next ${crossing.timeframe} Polymarket market for ${crossing.symbol}`);
  const isUp = crossing.after > 0;
  const message = [`${isUp ? '🟢' : '🔴'} ${crossing.symbol} · ${crossing.timeframe.toUpperCase()} · ${isUp ? 'BUY UP' : 'BUY DOWN'}`, '', `Previous imbalance: ${formatUsd(crossing.before)}`, `New imbalance: ${formatUsd(crossing.after)}`, `+${formatAbsoluteUsd(crossing.updateLongUsd)} LONG · -${formatAbsoluteUsd(crossing.updateShortUsd)} SHORT`, `Long total: ${formatAbsoluteUsd(crossing.longUsd)}`, `Short total: ${formatAbsoluteUsd(crossing.shortUsd)}`, `${crossing.longEvents} LONG events`, `${crossing.shortEvents} SHORT events`, '', `➡️ NEXT Polymarket ${crossing.timeframe.toUpperCase()}`, nextMarket.url].join('\n');
  await sendTelegramMessage(message); console.log(`ALERT SENT ${crossing.timeframe} ${crossing.symbol} ${isUp ? 'BUY UP' : 'BUY DOWN'}`);
}

async function processBoundary(now, previousBoundaryNow) {
  const dueTimeframes = FRAMEWORKS.filter(timeframe => bucketStart(now, timeframe) !== bucketStart(previousBoundaryNow, timeframe)); if (!dueTimeframes.length) return;
  console.log(`TIMEFRAME BOUNDARY REACHED; due=${dueTimeframes.join(',')}`); const allCrossings = [];
  for (const timeframe of dueTimeframes) { const eventsBySymbol = await fetchEventsForTimeframe(timeframe); const completedBucket = bucketStart(now, timeframe) - TIMEFRAMES[timeframe]; for (const symbol of symbols) { const state = timeframeState.get(timeframe).get(symbol) || emptySymbolState(); const start = state.lastBucket === null ? completedBucket : state.lastBucket + TIMEFRAMES[timeframe]; for (let period = start; period <= completedBucket; period += TIMEFRAMES[timeframe]) allCrossings.push(...applyCompletedBucket(timeframe, eventsBySymbol, period)); } }
  for (const crossing of allCrossings.sort((a, b) => a.ts - b.ts)) { try { await sendCrossingAlert(crossing); } catch (error) { console.warn(`POLYMARKET LINK/TELEGRAM FAILED ${crossing.timeframe} ${crossing.symbol}: ${error.message}`); } }
  await saveState();
}

async function backfillMissingLongerTimeframes(now) {
  for (const timeframe of ['15m', '1h', '4h', '1d']) {
    const map = timeframeState.get(timeframe); if (!symbols.some(symbol => map.get(symbol)?.events === 0)) continue; const eventsBySymbol = await fetchEventsForTimeframe(timeframe); const currentBucket = bucketStart(now, timeframe);
    for (const symbol of symbols) { const source = eventsBySymbol.get(symbol) || { events: [], buckets: new Set() }; const state = map.get(symbol) || emptySymbolState(); const periods = [...(source.buckets || new Set())].filter(bucket => bucket < currentBucket).sort((a, b) => a - b); if (periods.length) for (const period of periods) applyCompletedBucket(timeframe, new Map([[symbol, source]]), period); if (state.lastBucket !== null && periods.length) console.log(`BACKFILL ${timeframe} ${symbol}: ${periods.length} buckets`); }
  }
}
function ensureState() { for (const timeframe of FRAMEWORKS) { const map = timeframeState.get(timeframe); for (const symbol of symbols) if (!map.has(symbol)) map.set(symbol, emptySymbolState()); } }

async function main() {
  await loadState(); ensureState(); await backfillMissingLongerTimeframes(Date.now()); await saveState(); console.log(`Multi-timeframe liquidation monitor started; symbols=${symbols.join(',')}; timeframes=${FRAMEWORKS.join(',')}; historical API for 15m/1h/4h/1d`); let lastBoundaryNow = Date.now();
  while (true) { const now = Date.now(); const waitMs = Math.max(0, nextBoundary(now) - now + BOUNDARY_GRACE_MS); console.log(`Waiting for next timeframe boundary in ${Math.ceil(waitMs / 1000)}s`); await sleep(waitMs); const boundaryNow = Date.now(); try { await processBoundary(boundaryNow, lastBoundaryNow); lastBoundaryNow = boundaryNow; } catch (error) { console.error(`BOUNDARY PROCESS FAILED: ${error.stack || error.message}`); await sleep(5000); } }
}
main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });