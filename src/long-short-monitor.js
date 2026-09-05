const https = require('https');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey } = require('./liquidation-monitor');
const { findMarketByEpoch } = (() => {
  const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
  const MARKET_BASE_URL = 'https://polymarket.com/event';
  return {
    async findMarketByEpoch(symbol, epoch, timeframe) {
      const asset = String(symbol || '').trim().toLowerCase();
      const slug = `${asset}-updown-${timeframe}-${epoch}`;
      const response = await fetch(`${GAMMA_BASE_URL}/markets/slug/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' } });
      if (!response.ok) return null;
      const market = await response.json();
      if (!market || market.slug !== slug) return null;
      return { url: `${MARKET_BASE_URL}/${slug}` };
    }
  };
})();
const { sendTelegramMessage } = require('./telegram');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const MIN_LEADER_COUNT = 10;
const MIN_DOMINANCE_RATIO = 3;
const STATE_PATH = '.long-short-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const sentAlerts = new Set();
let stateSha = null;

function githubRequest(method, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error('GITHUB_TOKEN is not available'));
    const data = body ? JSON.stringify(body) : null;
    const request = https.request(STATE_API_URL, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'long-short-monitor', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => { let json = null; try { json = text ? JSON.parse(text) : null; } catch {} if (response.statusCode >= 200 && response.statusCode < 300) return resolve(json); reject(new Error(`GitHub state request failed: ${response.statusCode} ${text}`)); });
    });
    request.on('error', reject); if (data) request.write(data); request.end();
  });
}

async function loadState() {
  try {
    const data = await githubRequest('GET');
    if (!data || !data.content) return;
    stateSha = data.sha || null;
    const state = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    for (const key of state.alerts || []) sentAlerts.add(key);
  } catch (error) { console.warn(`STATE LOAD FAILED: ${error.message}`); }
}

async function saveState() {
  if (!process.env.GITHUB_TOKEN) return;
  const content = Buffer.from(JSON.stringify({ alerts: [...sentAlerts].slice(-500) }, null, 2)).toString('base64');
  const body = { message: 'Persist long short monitor state', content, branch: process.env.GITHUB_REF_NAME || 'main' };
  if (stateSha) body.sha = stateSha;
  try { const result = await githubRequest('PUT', body); stateSha = result?.content?.sha || stateSha; } catch (error) { console.warn(`STATE SAVE FAILED: ${error.message}`); }
}

function formatUtcPlus3(ms) { return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getBoundary(now, windowMs) { return Math.floor(now / windowMs) * windowMs; }

async function checkPeriod(boundary, windowMs, timeframe) {
  const closedBucket = boundary - windowMs;
  const bucketKey = `${timeframe}:${closedBucket}`;
  if (sentAlerts.has(`processed:${bucketKey}`)) return;

  const results = await Promise.all(SYMBOLS.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad ${timeframe} ${symbol}: ${error.message}`); return [symbol, []]; }
  }));

  const allowed = new Set(SYMBOLS.map(normalizeSymbol));
  const rows = new Map();
  const seen = new Set();

  for (const [, events] of results) {
    for (const event of events) {
      const ts = normalizeTs(event.ts);
      const symbol = normalizeSymbol(event.symbol);
      const side = String(event.side || '').toLowerCase();
      if (!ts || !allowed.has(symbol) || bucketStart(ts) !== closedBucket) continue;
      if (!(side.includes('long') || side.includes('short'))) continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!rows.has(symbol)) rows.set(symbol, { long: 0, short: 0 });
      if (side.includes('long')) rows.get(symbol).long += 1;
      else rows.get(symbol).short += 1;
    }
  }

  const candidates = [];
  for (const [symbol, row] of rows) {
    const side = row.long >= row.short ? 'long' : 'short';
    const leader = side === 'long' ? row.long : row.short;
    const opposite = side === 'long' ? row.short : row.long;
    const ratio = leader / Math.max(opposite, 1);
    if (leader >= MIN_LEADER_COUNT && ratio >= MIN_DOMINANCE_RATIO) candidates.push({ symbol, side, leader, opposite, ratio, long: row.long, short: row.short });
  }
  candidates.sort((a, b) => b.leader - a.leader || b.ratio - a.ratio);
  const winner = candidates[0] || null;
  sentAlerts.add(`processed:${bucketKey}`);

  if (!winner) {
    console.log(JSON.stringify({ type: 'long_short_no_alert', timeframe, closedBucket: new Date(closedBucket).toISOString(), minLeaderCount: MIN_LEADER_COUNT, minDominanceRatio: MIN_DOMINANCE_RATIO, candidates: [] }));
    await saveState();
    return;
  }

  const alertKey = `alert:${bucketKey}`;
  if (sentAlerts.has(alertKey)) { await saveState(); return; }
  const epoch = Math.floor((closedBucket + windowMs) / 1000);
  const market = await findMarketByEpoch(winner.symbol, epoch, timeframe);
  const emoji = winner.side === 'long' ? '🟢' : '🔴';
  const label = formatUtcPlus3(closedBucket);
  const message = [
    `${emoji} ${winner.side.toUpperCase()} LEADER`,
    `${normalizeSymbol(winner.symbol)} · ${timeframe.toUpperCase()} · ${label} UTC+3`,
    '',
    `Long: ${winner.long}`,
    `Short: ${winner.short}`,
    `Ratio: ${winner.ratio.toFixed(1)}x`,
    '',
    `➡️ NEXT Polymarket ${timeframe.toUpperCase()}`,
    market?.url || 'Market not found yet'
  ].join('\n');

  await sendTelegramMessage(message);
  sentAlerts.add(alertKey);
  console.log(JSON.stringify({ type: 'long_short_direction_winner', timeframe, closedBucket: new Date(closedBucket).toISOString(), symbol: winner.symbol, leaderSide: winner.side, leaderCount: winner.leader, oppositeCount: winner.opposite, ratio: winner.ratio, alertSent: true, currentMarket: market?.url || null }));
  await saveState();
}

async function main() {
  await loadState();
  console.log(`LONG/SHORT monitor started; symbols=${SYMBOLS.join(',')}; minLeader=${MIN_LEADER_COUNT}; minRatio=${MIN_DOMINANCE_RATIO}; exact 5m/15m boundaries`);
  while (true) {
    const now = Date.now();
    const next5 = getBoundary(now, WINDOW_5M) + WINDOW_5M;
    const next15 = getBoundary(now, WINDOW_15M) + WINDOW_15M;
    const next = Math.min(next5, next15);
    await sleep(Math.max(0, next - Date.now()));
    const boundary = next;
    try {
      if (boundary % WINDOW_5M === 0) await checkPeriod(boundary, WINDOW_5M, '5m');
      if (boundary % WINDOW_15M === 0) await checkPeriod(boundary, WINDOW_15M, '15m');
    } catch (error) { console.error(`LONG/SHORT CYCLE FAILED: ${error.stack || error.message}`); }
  }
}

main().catch(error => { console.error(`LONG/SHORT FAILED: ${error.stack || error.message}`); process.exitCode = 1; });
