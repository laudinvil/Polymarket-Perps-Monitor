const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { TIMEFRAMES, bucketStart, findMarketByEpoch, findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Authoritative liquidation imbalance monitor: all requested timeframes, same global logic.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME_LIST = ['5m', '15m', '1h', '4h', '1d'];
const POLL_MS = 4000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}?ref=monitor-status`;
const REQUEST_TIMEOUT_MS = 15000;

const sentAlerts = new Set();
const processedBuckets = new Set();
const stateByTimeframe = new Map();

for (const timeframe of TIMEFRAME_LIST) {
  stateByTimeframe.set(timeframe, {
    globalLongCount: 0,
    globalShortCount: 0,
    globalImbalance: 0,
    establishedSign: 0,
    lastEventTs: 0,
  });
}

function getTfState(timeframe) {
  return stateByTimeframe.get(timeframe);
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

function signed(value) {
  return value > 0 ? `+${value}` : String(value);
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
  const match = key.match(/^(5m|15m|1h|4h|1d):GLOBAL:(\d+):([A-Z]+):(-?1)$/);
  return match ? `${match[1]}:GLOBAL:${match[2]}:${match[3]}:${match[4]}` : null;
}

function loadPersistedState(state) {
  for (const key of [...(state?.sentAlerts || []), ...(state?.alerts || [])]) {
    const normalized = normalizeAlertKey(key);
    if (normalized) sentAlerts.add(normalized);
  }

  if (state?.timeframes && typeof state.timeframes === 'object') {
    for (const timeframe of TIMEFRAME_LIST) {
      const persisted = state.timeframes[timeframe];
      if (!persisted) continue;
      const current = getTfState(timeframe);
      if (Number.isFinite(persisted.globalLongCount)) current.globalLongCount = Math.max(0, persisted.globalLongCount);
      if (Number.isFinite(persisted.globalShortCount)) current.globalShortCount = Math.max(0, persisted.globalShortCount);
      current.globalImbalance = current.globalLongCount - current.globalShortCount;
      current.establishedSign = current.globalImbalance > 0 ? 1 : current.globalImbalance < 0 ? -1 : 0;
      if (Number.isFinite(persisted.lastEventTs)) current.lastEventTs = Math.max(0, persisted.lastEventTs);
    }
  } else if (Number.isFinite(state?.globalLongCount) || Number.isFinite(state?.globalShortCount)) {
    // Preserve existing 5m statistics when migrating from the previous 5m-only state.
    const current = getTfState('5m');
    current.globalLongCount = Math.max(0, Number(state.globalLongCount) || 0);
    current.globalShortCount = Math.max(0, Number(state.globalShortCount) || 0);
    current.globalImbalance = current.globalLongCount - current.globalShortCount;
    current.establishedSign = current.globalImbalance > 0 ? 1 : current.globalImbalance < 0 ? -1 : 0;
    if (Number.isFinite(state.lastGlobalEventTs)) current.lastEventTs = Math.max(0, state.lastGlobalEventTs);
  }
}

async function loadState() {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const response = await githubRequest();
    if (!response?.content) return;
    const state = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    loadPersistedState(state);
    console.log(`STATE LOADED; timeframes=${TIMEFRAME_LIST.join(',')}; symbols=${SYMBOLS.join(',')}`);
    for (const timeframe of TIMEFRAME_LIST) {
      const s = getTfState(timeframe);
      console.log(`STATE ${timeframe} LONG=${s.globalLongCount} SHORT=${s.globalShortCount} IMBALANCE=${signed(s.globalImbalance)}`);
    }
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveGlobalState() {
  if (!process.env.GITHUB_TOKEN) return;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      let response = null;
      try { response = await githubRequest(); }
      catch (error) { if (error.statusCode !== 404) throw error; }
      const state = response?.content
        ? JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'))
        : {};
      const keys = new Set(
        [...(state.sentAlerts || []), ...(state.alerts || [])]
          .map(normalizeAlertKey).filter(Boolean)
      );
      for (const key of sentAlerts) keys.add(key);
      state.version = 11;
      state.sentAlerts = [...keys].slice(-5000);
      state.timeframes = state.timeframes || {};
      for (const timeframe of TIMEFRAME_LIST) {
        const s = getTfState(timeframe);
        state.timeframes[timeframe] = {
          globalLongCount: s.globalLongCount,
          globalShortCount: s.globalShortCount,
          globalImbalance: s.globalImbalance,
          lastEventTs: s.lastEventTs,
        };
      }
      // Keep legacy 5m fields for compatibility with existing status tooling.
      const five = getTfState('5m');
      state.globalLongCount = five.globalLongCount;
      state.globalShortCount = five.globalShortCount;
      state.lastGlobalEventTs = five.lastEventTs;
      await githubRequest('PUT', {
        message: 'Persist all timeframe liquidation imbalance state',
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
}

async function reserveAlertKey(key) {
  if (sentAlerts.has(key)) return false;
  if (!process.env.GITHUB_TOKEN) return true;
  try {
    const response = await githubRequest();
    if (response?.content) {
      const state = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
      const keys = new Set(
        [...(state.sentAlerts || []), ...(state.alerts || [])]
          .map(normalizeAlertKey).filter(Boolean)
      );
      if (keys.has(key)) {
        sentAlerts.add(key);
        return false;
      }
    }
    return true;
  } catch (error) {
    console.warn(`ALERT DEDUP CHECK FAILED ${key}: ${error.message}`);
    return false;
  }
}

async function fetchAllFeeds() {
  return new Map(await Promise.all(
    SYMBOLS.map(async symbol => {
      try { return [symbol, await fetchSymbolFeed(symbol)]; }
      catch (error) {
        console.warn(`FEED ${symbol} FAILED: ${error.message}`);
        return [symbol, []];
      }
    })
  ));
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

function applyEvents(timeframe, events) {
  const state = getTfState(timeframe);
  let crossing = null;
  for (const item of events) {
    if (item.ts <= state.lastEventTs) continue;
    const previousImbalance = state.globalImbalance;
    if (item.side > 0) {
      state.globalLongCount += 1;
      state.globalImbalance += 1;
    } else {
      state.globalShortCount += 1;
      state.globalImbalance -= 1;
    }
    state.lastEventTs = item.ts;
    const newSign = state.globalImbalance > 0 ? 1 : state.globalImbalance < 0 ? -1 : 0;
    if (!crossing && state.establishedSign !== 0 && newSign !== 0 && newSign !== state.establishedSign) {
      crossing = { symbol: item.symbol, from: previousImbalance, to: state.globalImbalance, sign: newSign, ts: item.ts };
    }
    if (newSign !== 0) state.establishedSign = newSign;
  }
  return crossing;
}

async function findNextMarkets(symbol, completedBucketStart, timeframe) {
  // NEXT is the first actual market after the completed bucket.
  // NEXT+1 is the market immediately after NEXT.
  const next = await findNextMarket(symbol, completedBucketStart + TIMEFRAMES[timeframe], timeframe);
  if (!next) return { next: null, nextPlusOne: null };

  const nextEpoch = completedBucketStart + TIMEFRAMES[timeframe];
  const nextPlusOne = await findMarketByEpoch(symbol, nextEpoch + TIMEFRAMES[timeframe], timeframe);
  return { next, nextPlusOne };
}

async function sendAlert(timeframe, period, crossing) {
  if (!crossing) return;
  const state = getTfState(timeframe);
  const key = `${timeframe}:GLOBAL:${period}:${crossing.symbol}:${crossing.sign}`;
  if (!(await reserveAlertKey(key))) {
    console.log(`ALERT DUPLICATE SUPPRESSED ${key}`);
    return;
  }

  let markets = { next: null, nextPlusOne: null };
  try {
    markets = await findNextMarkets(crossing.symbol, period, timeframe);
  } catch (error) {
    console.warn(`POLYMARKET LOOKUP FAILED ${timeframe} ${crossing.symbol}: ${error.message}`);
  }

  // Existing mapping, applied identically to every timeframe:
  // positive imbalance -> BUY DOWN; negative imbalance -> BUY UP.
  const direction = crossing.sign > 0 ? 'BUY DOWN' : 'BUY UP';
  const emoji = crossing.sign > 0 ? '🔴' : '🟢';
  const links = [
    markets.next?.url ? `➡️ NEXT · Polymarket ${timeframe.toUpperCase()}\n${markets.next.url}` : '',
    markets.nextPlusOne?.url ? `➡️ NEXT+1 · Polymarket ${timeframe.toUpperCase()}\n${markets.nextPlusOne.url}` : ''
  ].filter(Boolean).join('\n\n');

  const message = [
    `${emoji} ${crossing.symbol} · ${direction} · ${timeframe.toUpperCase()}`,
    '',
    `Global imbalance: ${signed(state.globalImbalance)}`,
    `${formatCount(state.globalLongCount)} LONG · ${formatCount(state.globalShortCount)} SHORT`,
    '',
    `0 crossed: ${signed(crossing.from)} → ${signed(crossing.to)}`,
    links ? `\n${links}` : ''
  ].join('\n').trim();

  try {
    await sendTelegramMessage(message);
    sentAlerts.add(key);
    await saveGlobalState();
    console.log(`GLOBAL ${timeframe.toUpperCase()} ZERO CROSS ALERT SENT ${crossing.symbol} ${direction} imbalance=${state.globalImbalance} long=${state.globalLongCount} short=${state.globalShortCount}`);
  } catch (error) {
    console.warn(`GLOBAL ${timeframe.toUpperCase()} ALERT SEND FAILED ${crossing.symbol}: ${error.message}`);
  }
}

async function processCompletedBucket(timeframe, period, feeds) {
  const bucketKey = `${timeframe}:${period}`;
  if (processedBuckets.has(bucketKey)) return;
  processedBuckets.add(bucketKey);

  const events = eventsForBucket(feeds, timeframe, period);
  const crossing = applyEvents(timeframe, events);
  const state = getTfState(timeframe);
  console.log(
    `${timeframe.toUpperCase()} GLOBAL BOUNDARY ${new Date(period + TIMEFRAMES[timeframe]).toISOString()} ` +
    `LONG=${formatCount(state.globalLongCount)} SHORT=${formatCount(state.globalShortCount)} ` +
    `IMBALANCE=${signed(state.globalImbalance)} ` +
    `CROSS=${crossing ? `${crossing.symbol}:${crossing.from}->${crossing.to}` : 'NONE'}`
  );

  await saveGlobalState();
  await sendAlert(timeframe, period, crossing);
}

async function main() {
  await loadState();
  console.log(`GLOBAL LIQUIDATION IMBALANCE MONITOR STARTED; timeframes=${TIMEFRAME_LIST.join(',')}; all coins=${SYMBOLS.join(',')}; HYPE INCLUDED`);

  const lastCompleted = new Map();
  while (true) {
    const now = Date.now();
    const feeds = await fetchAllFeeds();

    for (const timeframe of TIMEFRAME_LIST) {
      const windowMs = TIMEFRAMES[timeframe];
      const current = bucketStart(now, timeframe);
      const completed = current - windowMs;
      if (!lastCompleted.has(timeframe)) lastCompleted.set(timeframe, completed - windowMs);
      const previous = lastCompleted.get(timeframe);
      for (let period = previous + windowMs; period <= completed; period += windowMs) {
        await processCompletedBucket(timeframe, period, feeds);
      }
      lastCompleted.set(timeframe, completed);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(`FATAL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
