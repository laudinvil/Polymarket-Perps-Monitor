const https = require('https');
const { fetchFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey, DEFAULT_SYMBOLS, LIQUIDATION_THRESHOLD_USD } = require('./liquidation-monitor');
const { findCurrentMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = DEFAULT_SYMBOLS;
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
  const body = { message: 'Persist monitor state', content, branch: process.env.GITHUB_REF_NAME || 'main' };
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

  const events = await fetchFeed(symbols, fetch, now);
  const allowed = new Set(symbols.map(normalizeSymbol));
  const unique = new Map();

  for (const event of events) {
    const ts = normalizeTs(event.ts);
    const symbol = normalizeSymbol(event.symbol);
    const side = String(event.side || '').toLowerCase();
    if (!ts || bucketStart(ts) !== closedBucket || !allowed.has(symbol)) continue;
    if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
    unique.set(eventKey(event), event);
  }

  const totals = new Map(symbols.map(symbol => [normalizeSymbol(symbol), {
    symbol: normalizeSymbol(symbol),
    events: 0,
    longEvents: 0,
    shortEvents: 0,
    totalVolume: 0,
    longVolume: 0,
    shortVolume: 0,
  }]));

  for (const event of unique.values()) {
    const symbol = normalizeSymbol(event.symbol);
    const row = totals.get(symbol);
    if (!row) continue;
    const notional = Number(event.notional) || 0;
    const side = String(event.side || '').toLowerCase();
    row.events += 1;
    row.totalVolume += notional;
    if (side.includes('long') || side === 'buy') {
      row.longEvents += 1;
      row.longVolume += notional;
    } else if (side.includes('short') || side === 'sell') {
      row.shortEvents += 1;
      row.shortVolume += notional;
    }
  }

  processedBuckets.add(bucketKey);
  const qualifying = [...totals.values()]
    .filter(row => row.totalVolume >= LIQUIDATION_THRESHOLD_USD)
    .sort((a, b) => b.totalVolume - a.totalVolume);

  if (qualifying.length === 0) {
    await saveState();
    console.log(JSON.stringify({
      type: 'liquidation_volume_5m',
      bucketStart: new Date(closedBucket).toISOString(),
      thresholdUsd: LIQUIDATION_THRESHOLD_USD,
      totals: Object.fromEntries([...totals.values()].map(row => [row.symbol, row.totalVolume])),
      alertSent: false,
    }));
    return;
  }

  for (const row of qualifying) {
    const alertKey = `${bucketKey}:${row.symbol}`;
    if (sentAlerts.has(alertKey)) continue;

    const currentMarket = await findCurrentMarket(row.symbol, now);
    const bucketLabel = new Date(closedBucket).toISOString().slice(11, 16);
    let message = [
      '🔥 LIQUIDATION SPIKE',
      `${row.symbol} · 5M · ${bucketLabel} UTC`, '',
      `Liquidations: ${row.events}`,
      `Long: ${row.longEvents} · Short: ${row.shortEvents}`,
      `Volume: ${formatUsd(row.totalVolume)}`,
      `Long volume: ${formatUsd(row.longVolume)}`,
      `Short volume: ${formatUsd(row.shortVolume)}`,
    ].join('\n');

    message += currentMarket
      ? `\n\n➡️ Current Polymarket 5M\n${currentMarket.url}`
      : '\n\n➡️ Current Polymarket 5M\nMarket not found yet';

    await sendTelegramMessage(message);
    sentAlerts.add(alertKey);

    console.log(JSON.stringify({
      type: 'liquidation_volume_5m',
      bucketStart: new Date(closedBucket).toISOString(),
      winner: row,
      thresholdUsd: LIQUIDATION_THRESHOLD_USD,
      alertSent: true,
      market: currentMarket?.url || null,
    }));
  }

  await saveState();
}

async function main() {
  await loadState();
  console.log(`5M liquidation volume monitor started; symbols=${symbols.join(',')}; threshold=$${LIQUIDATION_THRESHOLD_USD.toLocaleString('en-US')}; polling every ${POLL_MS}ms`);
  while (true) {
    try { await checkOnce(); }
    catch (error) { console.error(`MONITOR CYCLE FAILED: ${error.stack || error.message}`); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(`MONITOR FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
