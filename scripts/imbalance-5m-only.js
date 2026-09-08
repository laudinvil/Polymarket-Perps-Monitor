const https = require('https');
const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const WINDOW_MS = 5 * 60 * 1000;
const POLL_MS = 4000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}?ref=monitor-status`;
const REQUEST_TIMEOUT_MS = 15000;

const sentAlerts = new Set();
const establishedSigns = new Map();
const processedBuckets = new Set();

function bucketStart(ts) { return Math.floor(ts / WINDOW_MS) * WINDOW_MS; }
function side(event) {
  const s = String(event?.side || event?.direction || '').toLowerCase();
  return s.includes('long') ? 1 : s.includes('short') ? -1 : 0;
}
function notional(event) {
  const n = Number(event?.notional ?? event?.usd ?? event?.value ?? event?.amount);
  return Number.isFinite(n) ? Math.abs(n) : 0;
}
function formatUsd(v) {
  const n = Number(v) || 0;
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}$${Math.round(Math.abs(n)).toLocaleString('en-US')}`;
}
function githubRequest(method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const u = new URL(STATE_API_URL);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method,
      timeout: REQUEST_TIMEOUT_MS,
      headers: {
        'User-Agent': 'Polymarket-Perps-Monitor',
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${process.env.GITHUB_TOKEN || ''}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const error = new Error(`GitHub state request failed: ${res.statusCode}`);
        error.statusCode = res.statusCode;
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
  const match = key.match(/^5m:([A-Z]+):(\d+)(?::(-?1))?$/);
  if (!match) return null;
  return match[3] ? `5m:${match[1]}:${match[2]}:${match[3]}` : `5m:${match[1]}:${match[2]}`;
}
function loadPersistedState(state) {
  for (const key of [...(state?.sentAlerts || []), ...(state?.alerts || [])]) {
    const normalized = normalizeAlertKey(key);
    if (normalized) sentAlerts.add(normalized);
  }
  for (const symbol of SYMBOLS) {
    const saved = state?.liquidationTimeframes?.[TIMEFRAME]?.[symbol];
    const sign = Number(saved?.establishedSign) || 0;
    if (sign) establishedSigns.set(symbol, sign);
  }
}
async function loadState() {
  if (!process.env.GITHUB_TOKEN) return null;
  try {
    const response = await githubRequest();
    if (!response?.content) return null;
    const state = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    loadPersistedState(state);
    console.log(`STATE LOADED; 5m imbalance only; symbols=${SYMBOLS.join(',')}`);
    return response.sha || null;
  } catch (error) {
    if (error.statusCode === 404) console.log('STATE LOAD: no persisted state found; starting clean');
    else console.warn(`STATE LOAD FAILED: ${error.message}`);
    return null;
  }
}
async function reserveAlertKey(key) {
  if (sentAlerts.has(key)) {
    console.log(`ALERT DUPLICATE SUPPRESSED ${key}`);
    return false;
  }
  if (!process.env.GITHUB_TOKEN) return true;
  try {
    const response = await githubRequest();
    if (response?.content) {
      const state = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
      const keys = new Set([...(state.sentAlerts || []), ...(state.alerts || [])].map(normalizeAlertKey).filter(Boolean));
      if (keys.has(key)) {
        sentAlerts.add(key);
        console.log(`ALERT DUPLICATE SUPPRESSED ${key}`);
        return false;
      }
    }
    return true;
  } catch (error) {
    console.warn(`ALERT DEDUP CHECK FAILED ${key}: ${error.message}`);
    return false;
  }
}
async function saveSentAlert(key) {
  sentAlerts.add(key);
  if (!process.env.GITHUB_TOKEN) return;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      let response = null;
      try { response = await githubRequest(); } catch (error) { if (error.statusCode !== 404) throw error; }
      let state = {};
      if (response?.content) state = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
      const keys = new Set([...(state.sentAlerts || []), ...(state.alerts || [])].map(normalizeAlertKey).filter(Boolean));
      keys.add(key);
      state.sentAlerts = [...keys];
      const content = Buffer.from(JSON.stringify(state, null, 2)).toString('base64');
      const body = { message: 'Persist 5m imbalance alert state', content, branch: 'monitor-status', ...(response?.sha ? { sha: response.sha } : {}) };
      await githubRequest('PUT', body);
      return;
    } catch (error) {
      if (error.statusCode !== 409 || attempt === 5) {
        console.warn(`STATE SAVE FAILED: ${error.message}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250 * attempt));
    }
  }
}
async function fetchAllFeeds() {
  const results = await Promise.all(SYMBOLS.map(async symbol => {
    try {
      return [symbol, await fetchSymbolFeed(symbol)];
    } catch (error) {
      console.warn(`FEED ${symbol} FAILED: ${error.message}`);
      return [symbol, []];
    }
  }));
  return new Map(results);
}
function aggregate(events, period, symbol) {
  let longUsd = 0;
  let shortUsd = 0;
  let longEvents = 0;
  let shortEvents = 0;
  for (const event of events || []) {
    const ts = normalizeTs(event?.ts);
    if (!ts || bucketStart(ts) !== period) continue;
    const value = notional(event);
    const s = side(event);
    if (!value || !s) continue;
    if (s > 0) { longUsd += value; longEvents++; }
    else { shortUsd += value; shortEvents++; }
  }
  const imbalanceUsd = shortUsd - longUsd;
  return { symbol, period, longUsd, shortUsd, longEvents, shortEvents, events: longEvents + shortEvents, imbalanceUsd, sign: imbalanceUsd > 0 ? 1 : imbalanceUsd < 0 ? -1 : 0 };
}
async function sendAlert(row) {
  if (!row.sign) return;
  const previousSign = establishedSigns.get(row.symbol) || 0;
  establishedSigns.set(row.symbol, row.sign);
  if (!previousSign || previousSign === row.sign) {
    console.log(`5M IMBALANCE ${row.symbol} ${formatUsd(row.imbalanceUsd)} sign=${row.sign} (no flip)`);
    return;
  }
  const key = `5m:${row.symbol}:${row.period}:${row.sign}`;
  if (!(await reserveAlertKey(key))) return;
  let market = null;
  try { market = await findNextMarket(row.symbol, Date.now(), TIMEFRAME); }
  catch (error) { console.warn(`POLYMARKET LOOKUP FAILED 5m ${row.symbol}: ${error.message}`); }
  const direction = row.sign > 0 ? 'BUY UP' : 'BUY DOWN';
  const color = row.sign > 0 ? '🟢' : '🔴';
  const link = market?.url ? `\n\n➡️ NEXT Polymarket 5M\n${market.url}` : '';
  const msg = `${color} ${row.symbol} · ${direction}\n\nImbalance: ${formatUsd(row.imbalanceUsd)}\n\n${formatUsd(row.longUsd)} LONG · ${formatUsd(row.shortUsd)} SHORT${link}`;
  try {
    await sendTelegramMessage(msg);
    await saveSentAlert(key);
    console.log(`5M IMBALANCE ALERT SENT ${row.symbol} ${direction} ${formatUsd(row.imbalanceUsd)}`);
  } catch (error) {
    console.warn(`5M IMBALANCE ALERT SEND FAILED ${row.symbol}: ${error.message}`);
  }
}
async function main() {
  await loadState();
  console.log(`Liquidation monitor started; ONLY 5m imbalance; all symbols; Polymarket 5M links enabled`);
  let lastCompletedPeriod = null;
  while (true) {
    const now = Date.now();
    const currentPeriod = bucketStart(now);
    const completedPeriod = currentPeriod - WINDOW_MS;
    if (lastCompletedPeriod === null) lastCompletedPeriod = completedPeriod - WINDOW_MS;
    if (completedPeriod > lastCompletedPeriod) {
      const feeds = await fetchAllFeeds();
      for (let period = lastCompletedPeriod + WINDOW_MS; period <= completedPeriod; period += WINDOW_MS) {
        for (const symbol of SYMBOLS) {
          const row = aggregate(feeds.get(symbol), period, symbol);
          const bucketKey = `${symbol}:${period}`;
          if (processedBuckets.has(bucketKey)) continue;
          processedBuckets.add(bucketKey);
          await sendAlert(row);
          console.log(`TIMEFRAME BOUNDARY 5m ${symbol} ${new Date(period + WINDOW_MS).toISOString()} imbalance=${formatUsd(row.imbalanceUsd)} long=${formatUsd(row.longUsd)} short=${formatUsd(row.shortUsd)} events=${row.events}`);
        }
      }
      lastCompletedPeriod = completedPeriod;
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(`FATAL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
