const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { TIMEFRAMES, bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Authoritative monitor: 5m only, all supported coins including HYPE.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const WINDOW_MS = TIMEFRAMES[TIMEFRAME];
const POLL_MS = 4000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}?ref=monitor-status`;
const REQUEST_TIMEOUT_MS = 15000;

const sentAlerts = new Set();
const processedBuckets = new Set();

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
  const match = key.match(/^5m:GLOBAL:(\d+):([A-Z]+):(-?1)$/);
  return match ? `5m:GLOBAL:${match[1]}:${match[2]}:${match[3]}` : null;
}

function loadPersistedState(state) {
  for (const key of [...(state?.sentAlerts || []), ...(state?.alerts || [])]) {
    const normalized = normalizeAlertKey(key);
    if (normalized) sentAlerts.add(normalized);
  }
}

async function loadState() {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const response = await githubRequest();
    if (!response?.content) return;
    const state = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    loadPersistedState(state);
    console.log(`STATE LOADED; global 5m liquidation imbalance; symbols=${SYMBOLS.join(',')}`);
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveSentAlert(key) {
  sentAlerts.add(key);
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
          .map(normalizeAlertKey)
          .filter(Boolean)
      );
      keys.add(key);
      state.sentAlerts = [...keys];

      await githubRequest('PUT', {
        message: 'Persist global 5m liquidation imbalance alert state',
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
          .map(normalizeAlertKey)
          .filter(Boolean)
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
      try {
        return [symbol, await fetchSymbolFeed(symbol)];
      } catch (error) {
        console.warn(`FEED ${symbol} FAILED: ${error.message}`);
        return [symbol, []];
      }
    })
  ));
}

function eventsForBucket(feeds, period) {
  const events = [];
  for (const symbol of SYMBOLS) {
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || bucketStart(ts, TIMEFRAME) !== period) continue;
      const eventSide = side(event);
      if (!eventSide) continue;
      events.push({
        symbol,
        ts,
        side: eventSide,
        event
      });
    }
  }
  events.sort((a, b) => a.ts - b.ts);
  return events;
}

function calculateGlobalImbalance(events) {
  let longCount = 0;
  let shortCount = 0;
  let runningImbalance = 0;
  let crossing = null;

  for (const item of events) {
    const previousImbalance = runningImbalance;
    if (item.side > 0) {
      longCount += 1;
      runningImbalance += 1;
    } else {
      shortCount += 1;
      runningImbalance -= 1;
    }

    // Alert only when the GLOBAL imbalance actually crosses zero.
    // The event that performs the crossing identifies the coin responsible.
    if (!crossing && previousImbalance !== 0 &&
        ((previousImbalance < 0 && runningImbalance > 0) ||
         (previousImbalance > 0 && runningImbalance < 0))) {
      crossing = {
        symbol: item.symbol,
        from: previousImbalance,
        to: runningImbalance,
        sign: runningImbalance > 0 ? 1 : -1,
        ts: item.ts
      };
    }
  }

  return {
    longCount,
    shortCount,
    imbalance: longCount - shortCount,
    crossing
  };
}

async function findNextPlusOneMarket(symbol, completedBucketStart) {
  // Next market = period + 1 window; requested link is +1 beyond that.
  const nextMarketStart = completedBucketStart + WINDOW_MS;
  const plusOneStart = nextMarketStart + WINDOW_MS;
  return findMarketByEpoch(symbol, plusOneStart, TIMEFRAME);
}

async function sendAlert(period, stats) {
  const crossing = stats.crossing;
  if (!crossing) return;

  const key = `5m:GLOBAL:${period}:${crossing.symbol}:${crossing.sign}`;
  if (!(await reserveAlertKey(key))) {
    console.log(`ALERT DUPLICATE SUPPRESSED ${key}`);
    return;
  }

  let market = null;
  try {
    market = await findNextPlusOneMarket(crossing.symbol, period);
  } catch (error) {
    console.warn(`POLYMARKET LOOKUP FAILED 5m ${crossing.symbol}: ${error.message}`);
  }

  const direction = crossing.sign > 0 ? 'BUY UP' : 'BUY DOWN';
  const emoji = crossing.sign > 0 ? '🟢' : '🔴';
  const link = market?.url
    ? `\n\n➡️ NEXT+1 Polymarket 5M\n${market.url}`
    : '';

  const message = [
    `${emoji} ${crossing.symbol} · ${direction} · 5M`,
    '',
    `Global imbalance: ${crossing.sign > 0 ? '+' : ''}${stats.imbalance}`,
    `${formatCount(stats.longCount)} LONG · ${formatCount(stats.shortCount)} SHORT`,
    '',
    `0 crossed: ${crossing.from > 0 ? '+' : ''}${crossing.from} → ${crossing.to > 0 ? '+' : ''}${crossing.to}`,
    link
  ].join('\n').trim();

  try {
    await sendTelegramMessage(message);
    await saveSentAlert(key);
    console.log(`GLOBAL 5M IMBALANCE ZERO CROSS ALERT SENT ${crossing.symbol} ${direction} imbalance=${stats.imbalance} long=${stats.longCount} short=${stats.shortCount}`);
  } catch (error) {
    console.warn(`GLOBAL 5M ALERT SEND FAILED ${crossing.symbol}: ${error.message}`);
  }
}

async function processCompletedBucket(period, feeds) {
  const bucketKey = `5m:${period}`;
  if (processedBuckets.has(bucketKey)) return;
  processedBuckets.add(bucketKey);

  const events = eventsForBucket(feeds, period);
  const stats = calculateGlobalImbalance(events);

  console.log(
    `5M GLOBAL BOUNDARY ${new Date(period + WINDOW_MS).toISOString()} ` +
    `LONG=${formatCount(stats.longCount)} SHORT=${formatCount(stats.shortCount)} ` +
    `IMBALANCE=${stats.imbalance > 0 ? '+' : ''}${stats.imbalance} ` +
    `CROSS=${stats.crossing ? `${stats.crossing.symbol}:${stats.crossing.from}->${stats.crossing.to}` : 'NONE'}`
  );

  await sendAlert(period, stats);
}

async function main() {
  await loadState();
  console.log(`GLOBAL 5M LIQUIDATION IMBALANCE MONITOR STARTED; all coins=${SYMBOLS.join(',')}; HYPE INCLUDED; only 5m`);

  let lastCompleted = null;

  while (true) {
    const now = Date.now();
    const current = bucketStart(now, TIMEFRAME);
    const completed = current - WINDOW_MS;
    const feeds = await fetchAllFeeds();

    if (lastCompleted === null) lastCompleted = completed - WINDOW_MS;

    for (let period = lastCompleted + WINDOW_MS; period <= completed; period += WINDOW_MS) {
      await processCompletedBucket(period, feeds);
    }

    lastCompleted = completed;
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(`FATAL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
