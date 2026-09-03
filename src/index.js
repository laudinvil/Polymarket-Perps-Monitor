const https = require('https');
const { DEFAULT_SYMBOLS, fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey } = require('./liquidation-monitor');
const { findNextMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = (process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const POLL_MS = 15000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const processedBuckets = new Set();
const sentAlerts = new Set();
let stateSha = null;

function formatUsd(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
}

function githubRequest(method, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error('GITHUB_TOKEN is not configured'));

    const url = new URL(STATE_API_URL);
    const payload = body == null ? null : JSON.stringify(body);
    const req = https.request(url, {
      method,
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'Polymarket-Perps-Monitor',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = data ? JSON.parse(data) : null; } catch (_) {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        reject(new Error(`GitHub state API ${res.statusCode}: ${data.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function loadPersistentState() {
  try {
    const result = await githubRequest('GET');
    stateSha = result.sha;
    const raw = Buffer.from(result.content || '', 'base64').toString('utf8');
    const state = JSON.parse(raw);
    for (const bucket of state.processedBuckets || []) processedBuckets.add(bucket);
    for (const alert of state.alerts || []) sentAlerts.add(alert);
    console.log(JSON.stringify({ type: 'state_loaded', processedBuckets: processedBuckets.size, sentAlerts: sentAlerts.size }));
  } catch (error) {
    console.warn(`Persistent state load failed: ${error.message}`);
  }
}

async function savePersistentState() {
  if (!process.env.GITHUB_TOKEN) return;

  const processed = [...processedBuckets].sort().slice(-100);
  const alerts = [...sentAlerts].sort().slice(-100);
  const content = JSON.stringify({ processedBuckets: processed, alerts }, null, 2) + '\n';

  try {
    const result = await githubRequest('PUT', {
      message: 'Update monitor deduplication state',
      content: Buffer.from(content, 'utf8').toString('base64'),
      sha: stateSha,
      branch: 'main',
    });
    stateSha = result.content?.sha || stateSha;
  } catch (error) {
    console.warn(`Persistent state save failed: ${error.message}`);
  }
}

function bucketKey(symbol, bucket) {
  return `${normalizeSymbol(symbol)}|${new Date(bucket).toISOString()}`;
}

async function checkOnce() {
  const now = Date.now();
  const currentBucket = bucketStart(now);
  const closedBucket = currentBucket - 5 * 60 * 1000;
  const closedBucketIso = new Date(closedBucket).toISOString();

  if (processedBuckets.has(closedBucketIso)) return;

  const results = await Promise.all(
    symbols.map(async symbol => {
      try {
        return [symbol, await fetchSymbolFeed(symbol, fetch)];
      } catch (error) {
        console.warn(`MarginPad live ${symbol}: ${error.message}`);
        return [symbol, []];
      }
    }),
  );

  const allowed = new Set(symbols.map(normalizeSymbol));
  const counts = new Map(symbols.map(symbol => [normalizeSymbol(symbol), 0]));
  const seen = new Set();
  const eventsBySymbol = new Map(symbols.map(symbol => [normalizeSymbol(symbol), []]));

  for (const [, events] of results) {
    for (const event of events) {
      const ts = normalizeTs(event.ts);
      const symbol = normalizeSymbol(event.symbol);
      const side = String(event.side || '').toLowerCase();
      if (!ts || bucketStart(ts) !== closedBucket || !allowed.has(symbol)) continue;
      if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;

      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(symbol, (counts.get(symbol) || 0) + 1);
      eventsBySymbol.get(symbol).push({ key, event, ts });
    }
  }

  const ranking = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [winnerSymbol, winnerCount] = ranking[0] || [null, 0];
  const alertKey = winnerSymbol ? bucketKey(winnerSymbol, closedBucket) : null;

  // A previously sent alert remains suppressed even if the workflow restarted.
  if (alertKey && sentAlerts.has(alertKey)) {
    processedBuckets.add(closedBucketIso);
    await savePersistentState();
    console.log(JSON.stringify({
      type: 'liquidation_max_count_5m',
      bucketStart: closedBucketIso,
      counts: Object.fromEntries(ranking),
      alertSent: false,
      reason: 'already_alerted',
    }));
    return;
  }

  // Mark every closed bucket as processed, including buckets with no alert.
  processedBuckets.add(closedBucketIso);

  if (!winnerSymbol || winnerCount <= 1 || ranking[1]?.[1] === winnerCount) {
    await savePersistentState();
    console.log(JSON.stringify({
      type: 'liquidation_max_count_5m',
      bucketStart: closedBucketIso,
      counts: Object.fromEntries(ranking),
      alertSent: false,
      reason: winnerCount <= 1 ? 'winner_count_le_1' : 'no_unique_winner',
    }));
    return;
  }

  const winnerEvents = eventsBySymbol.get(winnerSymbol) || [];
  const longCount = winnerEvents.filter(({ event }) => {
    const side = String(event.side || '').toLowerCase();
    return side.includes('long') || side === 'buy';
  }).length;
  const shortCount = winnerCount - longCount;
  const totalVolume = winnerEvents.reduce((sum, { event }) => sum + (Number(event.notional) || 0), 0);

  const nextMarket = await findNextMarket(winnerSymbol, now);
  const bucketLabel = new Date(closedBucket).toISOString().slice(11, 16);

  let message = [
    '🔥 LIQUIDATION SPIKE',
    `${winnerSymbol} · 5M · ${bucketLabel} UTC`, '',
    `Liquidations: ${winnerCount}`,
    `Long: ${longCount} · Short: ${shortCount}`,
    `Volume: ${formatUsd(totalVolume)}`,
  ].join('\n');

  message += nextMarket
    ? `\n\n➡️ Next Polymarket 5M\n${nextMarket.url}`
    : '\n\n➡️ Next Polymarket 5M\nMarket not found yet';

  await sendTelegramMessage(message);

  if (alertKey) sentAlerts.add(alertKey);
  await savePersistentState();

  console.log(JSON.stringify({
    type: 'liquidation_max_count_5m',
    bucketStart: closedBucketIso,
    winner: {
      symbol: winnerSymbol,
      liquidations: winnerCount,
      longCount,
      shortCount,
      notionalUsd: totalVolume,
    },
    counts: Object.fromEntries(ranking),
    alertSent: true,
  }));
}

async function main() {
  console.log(`5M liquidation count monitor started; polling every ${POLL_MS}ms`);
  await loadPersistentState();

  while (true) {
    try {
      await checkOnce();
    } catch (error) {
      console.error(`MONITOR CYCLE FAILED: ${error.stack || error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(`MONITOR FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
