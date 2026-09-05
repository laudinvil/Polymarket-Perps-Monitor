const { fetchSymbolFeed, normalizeTs, normalizeSymbol, eventKey } = require('./liquidation-monitor');
const { sendTelegramMessage } = require('./telegram');
const { findCurrentMarket, findCurrentMarket15m } = require('./polymarket');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const FIVE_MS = 5 * 60 * 1000;
const FIFTEEN_MS = 15 * 60 * 1000;
const STATE_PATH = '.equal-liquidations-state.json';
const GITHUB_API = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;

function bucketStart(ts, size) { return Math.floor(Number(ts) / size) * size; }
function sideOf(event) {
  const side = String(event.side || '').toLowerCase();
  if (side.includes('long') || side === 'buy') return 'long';
  if (side.includes('short') || side === 'sell') return 'short';
  return null;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function githubRequest(method, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error('GITHUB_TOKEN is not available'));
    const data = body ? JSON.stringify(body) : null;
    const req = require('https').request(GITHUB_API, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'polymarket-equal-liquidations-monitor',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
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
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function loadState() {
  try {
    const data = await githubRequest('GET');
    const state = JSON.parse(Buffer.from(data.content || '', 'base64').toString('utf8'));
    return { sha: data.sha || null, sent: state.sent || {} };
  } catch (error) {
    if (!String(error.message).includes('404')) console.warn(`STATE LOAD FAILED: ${error.message}`);
    return { sha: null, sent: {} };
  }
}

async function saveState(sent, sha) {
  const content = Buffer.from(JSON.stringify({ sent }, null, 2)).toString('base64');
  const body = {
    message: 'Persist equal liquidation alerts state',
    content,
    branch: process.env.GITHUB_REF_NAME || 'main'
  };
  if (sha) body.sha = sha;
  const result = await githubRequest('PUT', body);
  return result?.content?.sha || sha || null;
}

async function fetchAllFeeds() {
  const results = await Promise.all(SYMBOLS.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad ${symbol}: ${error.message}`); return [symbol, []]; }
  }));
  return new Map(results);
}

function countEqual(feeds, closedBucket, windowMs) {
  const matches = [];
  for (const symbol of SYMBOLS) {
    const events = feeds.get(symbol) || [];
    const seen = new Set();
    let long = 0;
    let short = 0;
    for (const event of events) {
      const ts = normalizeTs(event.ts);
      if (!ts || normalizeSymbol(event.symbol) !== symbol || bucketStart(ts, windowMs) !== closedBucket) continue;
      const side = sideOf(event);
      if (!side) continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      if (side === 'long') long += 1;
      else short += 1;
    }
    if (long === short && long > 0) matches.push({ symbol, long, short, total: long + short });
  }
  return matches;
}

async function alertFor(matches, timeframe, currentBucket, closedBucket) {
  for (const item of matches) {
    const market = timeframe === '5M'
      ? await findCurrentMarket(item.symbol, currentBucket)
      : await findCurrentMarket15m(item.symbol, currentBucket);
    const message = [
      '⚖️ EQUAL LIQUIDATIONS',
      '',
      `${item.symbol} · ${timeframe} · ${new Date(closedBucket).toISOString().slice(11, 16)} UTC`,
      '',
      `Long: ${item.long} · Short: ${item.short}`,
      `Total: ${item.total}`,
      '',
      `➡️ CURRENT Polymarket ${timeframe}`,
      market?.url || 'Market not found yet'
    ].join('\n');
    await sendTelegramMessage(message);
    console.log(JSON.stringify({ type: 'equal_liquidations_alert', symbol: item.symbol, timeframe, closedBucket: new Date(closedBucket).toISOString(), long: item.long, short: item.short, market: market?.url || null }));
  }
}

async function main() {
  await sleep(5000);
  const now = Date.now();
  const current5 = bucketStart(now, FIVE_MS);
  const current15 = bucketStart(now, FIFTEEN_MS);
  const closed5 = current5 - FIVE_MS;
  const closed15 = current15 - FIFTEEN_MS;
  const state = await loadState();
  const sent = { ...state.sent };
  const feeds = await fetchAllFeeds();
  let changed = false;

  const key5 = `5m:${closed5}`;
  if (!sent[key5]) {
    const matches5 = countEqual(feeds, closed5, FIVE_MS);
    console.log(JSON.stringify({ type: 'equal_liquidations_5m', bucket: new Date(closed5).toISOString(), matches: matches5 }));
    if (matches5.length) { await alertFor(matches5, '5M', current5, closed5); sent[key5] = true; changed = true; }
  }

  const key15 = `15m:${closed15}`;
  if (!sent[key15]) {
    const matches15 = countEqual(feeds, closed15, FIFTEEN_MS);
    console.log(JSON.stringify({ type: 'equal_liquidations_15m', bucket: new Date(closed15).toISOString(), matches: matches15 }));
    if (matches15.length) { await alertFor(matches15, '15M', current15, closed15); sent[key15] = true; changed = true; }
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const key of Object.keys(sent)) {
    const ts = Number(key.split(':')[1]);
    if (Number.isFinite(ts) && ts < cutoff) delete sent[key];
  }
  if (changed || JSON.stringify(sent) !== JSON.stringify(state.sent)) await saveState(sent, state.sha);
}

main().catch(error => {
  console.error(`EQUAL LIQUIDATIONS MONITOR FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
