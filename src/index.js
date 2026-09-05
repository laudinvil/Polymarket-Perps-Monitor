const https = require('https');
const { spawn } = require('child_process');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey, WINDOW_MS } = require('./liquidation-monitor');
const { findCurrentMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

// 5M LIQUIDATION LEADER: all supported coins.
// LONG must be exactly 1 with SHORT 0; SHORT may be 1 or more with LONG 0.
const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const MAX_OPPOSITE_LIQUIDATIONS = 0;
const REQUIRED_LONG_LIQUIDATIONS = 1;
const MIN_SHORT_LIQUIDATIONS = 1;
const WINDOW_MS_5M = WINDOW_MS;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const sentAlerts = new Set();
const lastAlertPeriodBySymbol = new Map();
let stateSha = null;

function githubRequest(method, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error('GITHUB_TOKEN is not available'));
    const data = body ? JSON.stringify(body) : null;
    const request = https.request(STATE_API_URL, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'marginpad-monitor', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, response => {
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
    const state = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    for (const key of state.alerts || []) sentAlerts.add(key);
    for (const entry of state.lastAlertPeriodBySymbol || []) {
      if (entry && entry.symbol && Number.isFinite(entry.period)) lastAlertPeriodBySymbol.set(normalizeSymbol(entry.symbol), Number(entry.period));
    }
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveState() {
  if (!process.env.GITHUB_TOKEN) return;
  const content = Buffer.from(JSON.stringify({
    alerts: [...sentAlerts].slice(-500),
    lastAlertPeriodBySymbol: [...lastAlertPeriodBySymbol.entries()].map(([symbol, period]) => ({ symbol, period })).slice(-100),
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

function formatUtcPlus3(ms) { return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function checkOnce(boundary) {
  const currentBucket = boundary;
  const closedBucket = currentBucket - WINDOW_MS_5M;
  const results = await Promise.all(symbols.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad live ${symbol}: ${error.message}`); return [symbol, []]; }
  }));

  const allowed = new Set(symbols.map(normalizeSymbol));
  const rows = new Map();
  const diagnostics = [];

  for (const [requestedSymbol, events] of results) {
    const normalizedRequested = normalizeSymbol(requestedSymbol);
    const seen = new Set();
    let bucketValid = 0;
    let longBucket = 0;
    let shortBucket = 0;

    for (const event of events) {
      const ts = normalizeTs(event.ts);
      const symbol = normalizeSymbol(event.symbol);
      const side = String(event.side || '').toLowerCase();
      if (!ts || !allowed.has(symbol) || !(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
      if (bucketStart(ts) !== closedBucket) continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      bucketValid++;
      if (side.includes('long') || side === 'buy') longBucket++;
      else shortBucket++;
    }

    rows.set(normalizedRequested, { long: longBucket, short: shortBucket, total: bucketValid });
    diagnostics.push({ symbol: normalizedRequested, received: Array.isArray(events) ? events.length : 0, closed5m: bucketValid, long: longBucket, short: shortBucket });
  }

  console.log(JSON.stringify({ type: 'liquidation_5m_feed_diagnostics', boundary: new Date(currentBucket).toISOString(), closedBucket: new Date(closedBucket).toISOString(), symbols: diagnostics }));

  const candidates = symbols.map(normalizeSymbol).map(symbol => {
    const row = rows.get(symbol) || { long: 0, short: 0, total: 0 };
    return { symbol, ...row };
  }).filter(row =>
    (row.long === REQUIRED_LONG_LIQUIDATIONS && row.short === MAX_OPPOSITE_LIQUIDATIONS) ||
    (row.short >= MIN_SHORT_LIQUIDATIONS && row.long === MAX_OPPOSITE_LIQUIDATIONS)
  );

  if (!candidates.length) {
    console.log(JSON.stringify({ type: 'liquidation_5m_no_alert', closedBucket: new Date(closedBucket).toISOString(), condition: 'LONG_exactly_1_or_SHORT_1_plus_with_opposite_0', alertSent: false }));
    return;
  }

  let sentAny = false;
  for (const candidate of candidates) {
    const winnerSide = candidate.long === REQUIRED_LONG_LIQUIDATIONS ? 'long' : 'short';
    const winnerCount = winnerSide === 'long' ? candidate.long : candidate.short;
    const alertKey = `5m:${closedBucket}:${candidate.symbol}:${winnerSide}`;
    const lastPeriod = lastAlertPeriodBySymbol.get(candidate.symbol);

    // Do not repeat the same coin in the immediately following 5M period.
    // After one skipped period, the coin is eligible again.
    if (lastPeriod != null && closedBucket - lastPeriod === WINDOW_MS_5M) {
      console.log(JSON.stringify({ type: 'liquidation_5m_duplicate_coin_blocked', symbol: candidate.symbol, previousAlertPeriod: new Date(lastPeriod).toISOString(), closedBucket: new Date(closedBucket).toISOString() }));
      continue;
    }
    if (sentAlerts.has(alertKey)) continue;

    const currentMarket = await findCurrentMarket(candidate.symbol, currentBucket);
    const directionEmoji = winnerSide === 'long' ? '🔴' : '🟢';
    const message = [
      `${directionEmoji} LIQUIDATION LEADER`,
      `${candidate.symbol} · 5M · ${formatUtcPlus3(closedBucket)} UTC+3`, '',
      `Leader: ${winnerSide.toUpperCase()} · ${winnerCount} liquidation${winnerCount === 1 ? '' : 's'}`,
      `Long: ${candidate.long} · Short: ${candidate.short}`,
      `Total: ${candidate.total}`,
      '',
      '➡️ NEXT Polymarket 5M',
      currentMarket?.url || 'Market not found yet',
    ].join('\n');

    await sendTelegramMessage(message);
    sentAlerts.add(alertKey);
    lastAlertPeriodBySymbol.set(candidate.symbol, closedBucket);
    sentAny = true;
    console.log(JSON.stringify({ type: 'liquidation_5m_direction_winner', boundary: new Date(currentBucket).toISOString(), closedBucket: new Date(closedBucket).toISOString(), symbol: candidate.symbol, leaderSide: winnerSide, leaderCount: winnerCount, liquidations: candidate.total, longCount: candidate.long, shortCount: candidate.short, condition: 'LONG_exactly_1_or_SHORT_1_plus_with_opposite_0; no_same_coin_in_previous_period', alertSent: true, nextMarket: currentMarket?.url || null, delayMs: Date.now() - currentBucket }));
  }

  if (sentAny) await saveState();
}

function start15m() {
  const child = spawn(process.execPath, ['src/btc-15m-monitor.js'], { env: process.env, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    console.error(`15M monitor exited code=${code} signal=${signal}; restarting`);
    setTimeout(start15m, 5000);
  });
}

async function main() {
  await loadState();
  start15m();
  console.log(`5M liquidation direction-leader monitor started; symbols=${symbols.join(',')}; LONG=1; SHORT>=1; opposite=0; no same coin in previous period; boundary-only alerts; exact closed-bucket evaluation; 15M all symbols enabled`);

  while (true) {
    const now = Date.now();
    const nextBoundary = bucketStart(now) + WINDOW_MS_5M;
    await sleep(Math.max(0, nextBoundary - Date.now()));
    try { await checkOnce(nextBoundary); }
    catch (error) { console.error(`MONITOR CYCLE FAILED: ${error.stack || error.message}`); }
  }
}

main().catch(error => { console.error(`MONITOR FAILED: ${error.stack || error.message}`); process.exitCode = 1; });
