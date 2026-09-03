const https = require('https');
const { DEFAULT_SYMBOLS, fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey } = require('./liquidation-monitor');
const { findCurrentMarket } = require('./polymarket');
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
    if (!token) return reject(new Error('GITHUB_TOKEN is not available'));
    const data = body ? JSON.stringify(body) : null;
    const request = https.request(STATE_API_URL, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'marginpad-monitor',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(json);
        reject(new Error(`GitHub state request failed: ${response.statusCode} ${text}`));
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

async function loadState() {
  try {
    const data = await githubRequest('GET');
    if (!data || !data.content) return;
    stateSha = data.sha || null;
    const decoded = Buffer.from(data.content, 'base64').toString('utf8');
    const state = JSON.parse(decoded);
    for (const key of state.processedBuckets || []) processedBuckets.add(key);
    for (const key of state.alerts || []) sentAlerts.add(key);
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveState() {
  if (!process.env.GITHUB_TOKEN) return;
  const content = Buffer.from(JSON.stringify({
    processedBuckets: [...processedBuckets].slice(-100),
    alerts: [...sentAlerts].slice(-100),
  }, null, 2)).toString('base64');

  const body = {
    message: 'Persist monitor state',
    content,
    branch: process.env.GITHUB_REF_NAME || 'main',
  };
  if (stateSha) body.sha = stateSha;

  try {
    const result = await githubRequest('PUT', body);
    stateSha = result?.content?.sha || stateSha;
  } catch (error) {
    console.warn(`STATE SAVE FAILED: ${error.message}`);
  }
}

async function checkOnce() {
  const now = Date.now();
  const currentBucket = bucketStart(now);
  const closedBucket = currentBucket - 5 * 60 * 1000;
  const bucketKey = String(closedBucket);

  if (processedBuckets.has(bucketKey)) return;

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
    }
  }

  processedBuckets.add(bucketKey);

  const ranking = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [winnerSymbol, winnerCount] = ranking[0] || [null, 0];

  if (!winnerSymbol || winnerCount <= 1 || ranking[1]?.[1] === winnerCount) {
    await saveState();
    console.log(JSON.stringify({
      type: 'liquidation_max_count_5m',
      bucketStart: new Date(closedBucket).toISOString(),
      counts: Object.fromEntries(ranking),
      alertSent: false,
      reason: winnerCount <= 1 ? 'winner_count_le_1' : 'no_unique_winner',
    }));
    return;
  }

  const alertKey = `${bucketKey}:${winnerSymbol}`;
  if (sentAlerts.has(alertKey)) {
    await saveState();
    console.log(JSON.stringify({ type: 'duplicate_alert_blocked', bucketStart: new Date(closedBucket).toISOString(), symbol: winnerSymbol }));
    return;
  }

  const winnerEvents = [];
  const winnerSeen = new Set();
  for (const [, events] of results) {
    for (const event of events) {
      const ts = normalizeTs(event.ts);
      const symbol = normalizeSymbol(event.symbol);
      if (symbol !== winnerSymbol || !ts || bucketStart(ts) !== closedBucket) continue;
      const side = String(event.side || '').toLowerCase();
      if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
      const key = eventKey(event);
      if (winnerSeen.has(key)) continue;
      winnerSeen.add(key);
      winnerEvents.push({ key, event, ts });
    }
  }

  const longCount = winnerEvents.filter(({ event }) => {
    const side = String(event.side || '').toLowerCase();
    return side.includes('long') || side === 'buy';
  }).length;
  const shortCount = winnerCount - longCount;
  const totalVolume = winnerEvents.reduce((sum, { event }) => sum + (Number(event.notional) || 0), 0);

  // The alert is sent at the start of the new 5-minute bucket, so the link
  // must point to the market that is live NOW, not the following market.
  const currentMarket = await findCurrentMarket(winnerSymbol, now);
  const bucketLabel = new Date(closedBucket).toISOString().slice(11, 16);

  let message = [
    '🔥 LIQUIDATION SPIKE',
    `${winnerSymbol} · 5M · ${bucketLabel} UTC`, '',
    `Liquidations: ${winnerCount}`,
    `Long: ${longCount} · Short: ${shortCount}`,
    `Volume: ${formatUsd(totalVolume)}`,
  ].join('\n');

  message += currentMarket
    ? `\n\n➡️ Current Polymarket 5M\n${currentMarket.url}`
    : '\n\n➡️ Current Polymarket 5M\nMarket not found yet';

  await sendTelegramMessage(message);
  sentAlerts.add(alertKey);
  await saveState();

  console.log(JSON.stringify({
    type: 'liquidation_max_count_5m',
    bucketStart: new Date(closedBucket).toISOString(),
    winner: {
      symbol: winnerSymbol,
      liquidations: winnerCount,
      longCount,
      shortCount,
      notionalUsd: totalVolume,
    },
    counts: Object.fromEntries(ranking),
    alertSent: true,
    market: currentMarket?.url || null,
  }));
}

async function main() {
  await loadState();
  console.log(`5M liquidation count monitor started; polling every ${POLL_MS}ms`);

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
