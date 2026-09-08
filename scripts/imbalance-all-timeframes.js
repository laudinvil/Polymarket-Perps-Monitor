const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { TIMEFRAMES, bucketStart, findMarketByEpoch, findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME_LIST = ['5m', '15m', '1h', '4h'];
const ALERT_THRESHOLD = { '5m': 3, '15m': 2, '1h': 2, '4h': 2 };
const POLL_MS = 4000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}?ref=monitor-status`;
const REQUEST_TIMEOUT_MS = 15000;

const sentAlerts = new Set();
const processedBuckets = new Set();
const streakState = new Map();
let stateSaveChain = Promise.resolve();

for (const timeframe of TIMEFRAME_LIST) {
  for (const symbol of SYMBOLS) {
    streakState.set(`${timeframe}:${symbol}`, { side: 0, length: 0, lastBucket: 0 });
  }
}

function getStreak(timeframe, symbol) {
  return streakState.get(`${timeframe}:${symbol}`);
}

function side(event) {
  const value = String(event?.side || event?.direction || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 1;
  if (value.includes('short') || value === 'sell') return -1;
  return 0;
}

function formatCount(value) {
  return Math.max(0, Number(value) || 0).toLocaleString('en-US');
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
  const match = key.match(/^(5m|15m|1h|4h):STREAK:(\d+):([A-Z]+):([12]+)$/);
  return match ? key : null;
}

function loadPersistedState(state) {
  for (const key of [...(state?.sentAlerts || []), ...(state?.alerts || [])]) {
    const normalized = normalizeAlertKey(key);
    if (normalized) sentAlerts.add(normalized);
  }

  for (const timeframe of TIMEFRAME_LIST) {
    for (const symbol of SYMBOLS) {
      const saved = state?.streaks?.[timeframe]?.[symbol];
      if (!saved) continue;
      const streak = getStreak(timeframe, symbol);
      streak.side = Number(saved.side) === 1 || Number(saved.side) === -1 ? Number(saved.side) : 0;
      streak.length = Math.max(0, Number(saved.length) || 0);
      streak.lastBucket = Math.max(0, Number(saved.lastBucket) || 0);
    }
  }
}

async function loadState() {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const response = await githubRequest();
    if (!response?.content) return;
    const state = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    loadPersistedState(state);
    console.log('STATE LOADED; per-coin streaks persist across buckets and restarts; thresholds=5m:3+,15m:2+,1h:2+,4h:2+; no periodic reset');
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveGlobalState() {
  if (!process.env.GITHUB_TOKEN) return;
  for (let attempt = 1; attempt <= 5; attempt += 1) try {
    let response = null;
    try { response = await githubRequest(); } catch (error) { if (error.statusCode !== 404) throw error; }
    const state = response?.content ? JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8')) : {};
    const keys = new Set([...(state.sentAlerts || []), ...(state.alerts || [])].map(normalizeAlertKey).filter(Boolean));
    for (const key of sentAlerts) keys.add(key);
    state.version = 20;
    state.sentAlerts = [...keys].slice(-5000);
    state.streaks = {};
    for (const timeframe of TIMEFRAME_LIST) {
      state.streaks[timeframe] = {};
      for (const symbol of SYMBOLS) {
        const streak = getStreak(timeframe, symbol);
        state.streaks[timeframe][symbol] = {
          side: streak.side,
          length: streak.length,
          lastBucket: streak.lastBucket
        };
      }
    }
    await githubRequest('PUT', {
      message: 'Persist per-coin liquidation streaks',
      content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'),
      branch: 'monitor-status',
      ...(response?.sha ? { sha: response.sha } : {})
    });
    return;
  } catch (error) {
    if (error.statusCode !== 409 || attempt === 5) {
      console.warn(`STATE SAVE FAILED: ${error.message}`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 250 * attempt));
  }
}

function queueStateSave() {
  stateSaveChain = stateSaveChain
    .then(() => saveGlobalState())
    .catch(error => console.warn(`STATE SAVE QUEUE FAILED: ${error.message}`));
  return stateSaveChain;
}

async function fetchAllFeeds() {
  return new Map(await Promise.all(SYMBOLS.map(async symbol => {
    try {
      return [symbol, await fetchSymbolFeed(symbol)];
    } catch (error) {
      console.warn(`FEED ${symbol} FAILED: ${error.message}`);
      return [symbol, []];
    }
  })));
}

function eventsForBucket(feeds, timeframe, period) {
  const events = [];
  for (const symbol of SYMBOLS) {
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || bucketStart(ts, timeframe) !== period) continue;
      const eventSide = side(event);
      if (!eventSide) continue;
      events.push({ symbol, ts, side: eventSide, event });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

function classifyBucket(events) {
  const counts = new Map();
  for (const symbol of SYMBOLS) counts.set(symbol, { long: 0, short: 0 });
  for (const item of events) {
    const count = counts.get(item.symbol);
    if (item.side > 0) count.long += 1;
    else if (item.side < 0) count.short += 1;
  }
  return counts;
}

function updateStreak(timeframe, symbol, bucketStartTs, counts) {
  const streak = getStreak(timeframe, symbol);
  const longCount = counts.long;
  const shortCount = counts.short;

  if (longCount === 0 && shortCount === 0) {
    streak.side = 0;
    streak.length = 0;
    streak.lastBucket = bucketStartTs;
    return { side: 0, length: 0, longCount, shortCount, alert: false };
  }

  if (longCount === shortCount) {
    streak.side = 0;
    streak.length = 0;
    streak.lastBucket = bucketStartTs;
    return { side: 0, length: 0, longCount, shortCount, alert: false };
  }

  const bucketSide = longCount > shortCount ? 1 : -1;
  if (streak.side === bucketSide) streak.length += 1;
  else {
    streak.side = bucketSide;
    streak.length = 1;
  }
  streak.lastBucket = bucketStartTs;

  return {
    side: bucketSide,
    length: streak.length,
    longCount,
    shortCount,
    alert: streak.length >= ALERT_THRESHOLD[timeframe]
  };
}

async function findNextMarkets(symbol, completedBucketStart, timeframe) {
  const next = await findNextMarket(symbol, completedBucketStart + TIMEFRAMES[timeframe], timeframe);
  if (!next) return { next: null, nextPlusOne: null };
  if (timeframe === '15m') return { next, nextPlusOne: null };
  const nextEpoch = completedBucketStart + TIMEFRAMES[timeframe];
  return {
    next,
    nextPlusOne: await findMarketByEpoch(symbol, nextEpoch + TIMEFRAMES[timeframe], timeframe)
  };
}

async function sendAlert(timeframe, period, symbol, streak) {
  if (!streak.alert) return false;
  const key = `${timeframe}:STREAK:${period}:${symbol}:${streak.side === 1 ? 1 : 2}`;
  if (sentAlerts.has(key)) {
    console.log(`ALERT DUPLICATE SUPPRESSED ${key}`);
    return false;
  }

  sentAlerts.add(key);
  let markets = { next: null, nextPlusOne: null };
  try {
    markets = await findNextMarkets(symbol, period, timeframe);
  } catch (error) {
    console.warn(`POLYMARKET LOOKUP FAILED ${timeframe} ${symbol}: ${error.message}`);
  }

  const isLong = streak.side === 1;
  const direction = isLong ? 'BUY UP' : 'BUY DOWN';
  const emoji = isLong ? '🟢' : '🔴';
  const sideName = isLong ? 'LONG' : 'SHORT';
  const links = timeframe === '5m'
    ? (markets.nextPlusOne?.url ? `➡️ NEXT+1 · Polymarket 5M\n${markets.nextPlusOne.url}` : '')
    : timeframe === '15m'
      ? (markets.next?.url ? `➡️ NEXT · Polymarket 15M\n${markets.next.url}` : '')
      : [
          markets.next?.url ? `➡️ NEXT · Polymarket ${timeframe.toUpperCase()}\n${markets.next.url}` : '',
          markets.nextPlusOne?.url ? `➡️ NEXT+1 · Polymarket ${timeframe.toUpperCase()}\n${markets.nextPlusOne.url}` : ''
        ].filter(Boolean).join('\n\n');

  const message = [
    `${emoji} ${symbol} · ${direction} · ${timeframe.toUpperCase()}`,
    '',
    `Streak: ${streak.length} ${sideName} buckets`,
    `Current bucket: ${formatCount(streak.longCount)} LONG · ${formatCount(streak.shortCount)} SHORT`,
    links ? `\n${links}` : ''
  ].join('\n').trim();

  try {
    await sendTelegramMessage(message);
    console.log(`STREAK ${timeframe.toUpperCase()} ALERT SENT ${symbol} ${sideName} streak=${streak.length} long=${streak.longCount} short=${streak.shortCount}`);
    return true;
  } catch (error) {
    sentAlerts.delete(key);
    console.warn(`STREAK ${timeframe.toUpperCase()} ALERT SEND FAILED ${symbol}: ${error.message}`);
    return false;
  }
}

async function processCompletedBucket(timeframe, period, feeds) {
  const bucketKey = `${timeframe}:${period}`;
  if (processedBuckets.has(bucketKey)) return;
  processedBuckets.add(bucketKey);

  const events = eventsForBucket(feeds, timeframe, period);
  const counts = classifyBucket(events);
  const bucketEnd = period + TIMEFRAMES[timeframe];
  const alertTasks = [];

  for (const symbol of SYMBOLS) {
    const streak = updateStreak(timeframe, symbol, period, counts.get(symbol));
    if (streak.side !== 0 || streak.longCount !== 0 || streak.shortCount !== 0) {
      console.log(`${timeframe.toUpperCase()} BUCKET ${new Date(period).toISOString()}-${new Date(bucketEnd).toISOString()} ${symbol} LONG=${streak.longCount} SHORT=${streak.shortCount} DOMINANT=${streak.side > 0 ? 'LONG' : streak.side < 0 ? 'SHORT' : 'NONE'} STREAK=${streak.length}${streak.alert ? ' ALERT=YES' : ' ALERT=NO'}`);
    } else {
      console.log(`${timeframe.toUpperCase()} BUCKET ${new Date(period).toISOString()}-${new Date(bucketEnd).toISOString()} ${symbol} LONG=0 SHORT=0 STREAK=RESET`);
    }
    if (streak.alert) alertTasks.push(sendAlert(timeframe, period, symbol, streak));
  }

  if (alertTasks.length) {
    await Promise.all(alertTasks);
  }
  queueStateSave();
}

async function main() {
  await loadState();
  console.log('LIQUIDATION STREAK MONITOR STARTED; per-coin dominant LONG/SHORT buckets; thresholds=5m:3+,15m:2+,1h:2+,4h:2+; streaks persist without periodic reset; zero LONG and zero SHORT resets; 5m/15m/1h/4h');

  const lastCompleted = new Map();
  while (true) {
    const now = Date.now();
    const feeds = await fetchAllFeeds();
    const bucketTasks = [];

    for (const timeframe of TIMEFRAME_LIST) {
      const windowMs = TIMEFRAMES[timeframe];
      const current = bucketStart(now, timeframe);
      const completed = current - windowMs;
      if (!lastCompleted.has(timeframe)) lastCompleted.set(timeframe, completed - windowMs);
      const previous = lastCompleted.get(timeframe);
      for (let period = previous + windowMs; period <= completed; period += windowMs) {
        bucketTasks.push(processCompletedBucket(timeframe, period, feeds));
      }
      lastCompleted.set(timeframe, completed);
    }

    if (bucketTasks.length) await Promise.all(bucketTasks);
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(`FATAL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
