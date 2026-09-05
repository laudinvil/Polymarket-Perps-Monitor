const https = require('https');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol, eventKey } = require('./liquidation-monitor');
const { sendTelegramMessage } = require('./telegram');
const { findCurrentMarket15m } = require('./polymarket');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_MS_15M = 15 * 60 * 1000;
const REQUIRED_LONG_LIQUIDATIONS = 1;
const MIN_SHORT_LIQUIDATIONS = 1;
const MAX_OPPOSITE_LIQUIDATIONS = 0;
const STATE_PATH = '.monitor-state-15m.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const processedBuckets15m = new Set();
const sentAlerts15m = new Set();
const lastAlertPeriodBySymbol15m = new Map();
let stateSha15m = null;

function githubRequest(method, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error('GITHUB_TOKEN is not available'));
    const data = body ? JSON.stringify(body) : null;
    const request = https.request(STATE_API_URL, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'liquidation-15m-monitor', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, response => {
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

async function loadState15m() {
  try {
    const data = await githubRequest('GET');
    if (!data?.content) return;
    stateSha15m = data.sha || null;
    const state = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    for (const key of state.alerts || []) sentAlerts15m.add(key);
    for (const entry of state.lastAlertPeriodBySymbol || []) {
      if (entry?.symbol && Number.isFinite(entry.period)) lastAlertPeriodBySymbol15m.set(normalizeSymbol(entry.symbol), Number(entry.period));
    }
  } catch (error) {
    console.warn(`15M STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveState15m() {
  if (!process.env.GITHUB_TOKEN) return;
  const content = Buffer.from(JSON.stringify({
    alerts: [...sentAlerts15m].slice(-500),
    lastAlertPeriodBySymbol: [...lastAlertPeriodBySymbol15m.entries()].map(([symbol, period]) => ({ symbol, period })).slice(-100),
  }, null, 2)).toString('base64');
  const body = { message: 'Persist 15M monitor state', content, branch: process.env.GITHUB_REF_NAME || 'main' };
  if (stateSha15m) body.sha = stateSha15m;
  try {
    const result = await githubRequest('PUT', body);
    stateSha15m = result?.content?.sha || stateSha15m;
  } catch (error) {
    console.warn(`15M STATE SAVE FAILED: ${error.message}`);
  }
}

function bucketStart15m(ts) { return Math.floor(Number(ts) / WINDOW_MS_15M) * WINDOW_MS_15M; }
function formatUtcPlus3(ms) { return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function check15mOnce(boundary) {
  const currentBucket = boundary;
  const closedBucket = currentBucket - WINDOW_MS_15M;
  const bucketKey = `15m:${closedBucket}`;
  if (processedBuckets15m.has(bucketKey)) return;

  const results = await Promise.all(SYMBOLS.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad 15m ${symbol}: ${error.message}`); return [symbol, []]; }
  }));

  const rows = new Map();
  const diagnostics = [];
  for (const [requestedSymbol, events] of results) {
    let longCount = 0;
    let shortCount = 0;
    let bucketEvents = 0;
    const seen = new Set();
    for (const event of events) {
      const ts = normalizeTs(event.ts);
      if (!ts || bucketStart15m(ts) !== closedBucket || normalizeSymbol(event.symbol) !== requestedSymbol) continue;
      const side = String(event.side || '').toLowerCase();
      if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      bucketEvents++;
      if (side.includes('long') || side === 'buy') longCount++;
      else shortCount++;
    }
    rows.set(requestedSymbol, { longCount, shortCount, total: bucketEvents });
    diagnostics.push({ symbol: requestedSymbol, received: Array.isArray(events) ? events.length : 0, closed15m: bucketEvents, long: longCount, short: shortCount });
  }

  processedBuckets15m.add(bucketKey);
  console.log(JSON.stringify({ type: 'liquidation_15m_feed_diagnostics', boundary: new Date(currentBucket).toISOString(), closedBucket: new Date(closedBucket).toISOString(), symbols: diagnostics }));

  const candidates = SYMBOLS.map(symbol => {
    const row = rows.get(symbol) || { longCount: 0, shortCount: 0, total: 0 };
    return { symbol, ...row };
  }).filter(row =>
    (row.longCount === REQUIRED_LONG_LIQUIDATIONS && row.shortCount === MAX_OPPOSITE_LIQUIDATIONS) ||
    (row.shortCount >= MIN_SHORT_LIQUIDATIONS && row.longCount === MAX_OPPOSITE_LIQUIDATIONS)
  );

  if (!candidates.length) {
    console.log(JSON.stringify({ type: 'liquidation_15m_no_alert', closedBucket: new Date(closedBucket).toISOString(), condition: 'LONG_exactly_1_or_SHORT_1_plus_with_opposite_0', alertSent: false }));
    return;
  }

  const winner = candidates.sort((a, b) => b.total - a.total)[0];
  const winnerSide = winner.longCount === REQUIRED_LONG_LIQUIDATIONS ? 'long' : 'short';
  const winnerCount = winnerSide === 'long' ? winner.longCount : winner.shortCount;
  const alertKey = `15m:${closedBucket}`;
  const lastPeriod = lastAlertPeriodBySymbol15m.get(winner.symbol);

  // Block the same coin only in the immediately following 15M period.
  // It becomes eligible again after one skipped period.
  if (lastPeriod != null && closedBucket - lastPeriod === WINDOW_MS_15M) {
    console.log(JSON.stringify({ type: 'liquidation_15m_duplicate_coin_blocked', symbol: winner.symbol, previousAlertPeriod: new Date(lastPeriod).toISOString(), closedBucket: new Date(closedBucket).toISOString() }));
    return;
  }
  if (sentAlerts15m.has(alertKey)) return;

  const market = await findCurrentMarket15m(winner.symbol, currentBucket);
  const emoji = winnerSide === 'long' ? '🔴' : '🟢';
  const message = [
    `${emoji} LIQUIDATION LEADER`,
    `${winner.symbol} · 15M · ${formatUtcPlus3(closedBucket)} UTC+3`, '',
    `Leader: ${winnerSide.toUpperCase()} · ${winnerCount} liquidation${winnerCount === 1 ? '' : 's'}`,
    `Long: ${winner.longCount} · Short: ${winner.shortCount}`,
    `Total: ${winner.total}`,
    '',
    '➡️ NEXT Polymarket 15M',
    market?.url || 'Market not found yet',
  ].join('\n');

  await sendTelegramMessage(message);
  sentAlerts15m.add(alertKey);
  lastAlertPeriodBySymbol15m.set(winner.symbol, closedBucket);
  await saveState15m();
  console.log(JSON.stringify({ type: 'liquidation_15m_direction_winner', closedBucket: new Date(closedBucket).toISOString(), symbol: winner.symbol, leaderSide: winnerSide, leaderCount: winnerCount, longCount: winner.longCount, shortCount: winner.shortCount, condition: 'LONG_exactly_1_or_SHORT_1_plus_with_opposite_0; no_same_coin_in_previous_period', alertSent: true, nextMarket: market?.url || null, delayMs: Date.now() - currentBucket }));
}

async function main15m() {
  await loadState15m();
  console.log(`15M liquidation direction-leader monitor started; symbols=${SYMBOLS.join(',')}; LONG=1; SHORT>=1; opposite=0; no same coin in previous period`);
  while (true) {
    const now = Date.now();
    const nextBoundary = bucketStart15m(now) + WINDOW_MS_15M;
    await sleep(Math.max(0, nextBoundary - Date.now()));
    try { await check15mOnce(nextBoundary); }
    catch (error) { console.error(`15M liquidation monitor failed: ${error.stack || error.message}`); }
  }
}

main15m().catch(error => { console.error(`15M liquidation monitor fatal: ${error.stack || error.message}`); process.exitCode = 1; });
