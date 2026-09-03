const https = require('https');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey, DEFAULT_SYMBOLS, WINDOW_MS } = require('./liquidation-monitor');
const { findCurrentMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = DEFAULT_SYMBOLS;
const POLL_MS = 15000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const processedBuckets = new Set();
const sentAlerts = new Set();
let stateSha = null;

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
    alerts: [...sentAlerts].slice(-200),
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
  const closedBucket = currentBucket - WINDOW_MS;
  const bucketKey = String(closedBucket);
  if (processedBuckets.has(bucketKey)) return;

  const results = await Promise.all(symbols.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad live ${symbol}: ${error.message}`); return [symbol, []]; }
  }));

  const allowed = new Set(symbols.map(normalizeSymbol));
  const rows = new Map();
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

      if (!rows.has(symbol)) rows.set(symbol, { events: 0, longEvents: 0, shortEvents: 0 });
      const row = rows.get(symbol);
      row.events += 1;
      if (side.includes('long') || side === 'buy') row.longEvents += 1;
      else row.shortEvents += 1;
    }
  }

  processedBuckets.add(bucketKey);

  // Leader is selected by ONE direction only: compare every Long count and
  // every Short count across all monitored coins. Total Long+Short is not used.
  const candidates = [...rows.entries()].flatMap(([symbol, row]) => [
    { symbol, side: 'long', count: row.longEvents, total: row.events },
    { symbol, side: 'short', count: row.shortEvents, total: row.events },
  ]).filter(candidate => candidate.count > 0);

  const winner = candidates.sort((a, b) => b.count - a.count || b.total - a.total)[0];

  if (!winner) {
    await saveState();
    return;
  }

  const alertKey = `15m:${bucketKey}`;
  if (sentAlerts.has(alertKey)) {
    await saveState();
    return;
  }

  // Alert at the beginning of the new 15-minute period, so this is the
  // current market link while the numbers describe the just-closed period.
  const currentMarket = await findCurrentMarket(winner.symbol, now);
  const winnerRow = rows.get(winner.symbol);
  const bucketLabel = new Date(closedBucket).toISOString().slice(11, 16);
  const directionEmoji = winner.side === 'long' ? '🔴' : '🟢';

  let message = [
    `${directionEmoji} LIQUIDATION LEADER`,
    `${normalizeSymbol(winner.symbol)} · 15M · ${bucketLabel} UTC`, '',
    `Leader: ${winner.side.toUpperCase()} · ${winner.count} liquidations`,
    `Long: ${winnerRow.longEvents} · Short: ${winnerRow.shortEvents}`,
    `Total: ${winnerRow.events}`,
    '',
    `➡️ Current Polymarket 15M`,
    currentMarket?.url || 'Market not found yet',
  ].join('\n');

  await sendTelegramMessage(message);
  sentAlerts.add(alertKey);

  console.log(JSON.stringify({
    type: 'liquidation_15m_direction_winner',
    closedBucket: new Date(closedBucket).toISOString(),
    symbol: normalizeSymbol(winner.symbol),
    leaderSide: winner.side,
    leaderCount: winner.count,
    liquidations: winnerRow.events,
    longCount: winnerRow.longEvents,
    shortCount: winnerRow.shortEvents,
    alertSent: true,
    currentMarket: currentMarket?.url || null,
  }));

  await saveState();
}

async function main() {
  await loadState();
  console.log(`15M liquidation direction-leader monitor started; symbols=${symbols.join(',')}; no threshold; alert at start of next period`);
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
