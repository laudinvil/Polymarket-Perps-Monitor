const https = require('https');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol, eventKey } = require('./liquidation-monitor');
const { sendTelegramMessage } = require('./telegram');
const { findNextMarket15m } = require('./polymarket');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_MS_15M = 15 * 60 * 1000;
const POLL_MS = 10000;
const STATE_PATH = '.monitor-state-15m.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const sentAlerts15m = new Set();
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
  } catch (error) {
    console.warn(`15M STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveState15m() {
  if (!process.env.GITHUB_TOKEN) return;
  const content = Buffer.from(JSON.stringify({ alerts: [...sentAlerts15m].slice(-500) }, null, 2)).toString('base64');
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

function summarizeActivePeriod(eventsBySymbol, currentBucket) {
  return SYMBOLS.map(symbol => {
    const ordered = (eventsBySymbol.get(symbol) || []).slice().sort((a, b) => normalizeTs(a.ts) - normalizeTs(b.ts));
    let long = 0;
    let short = 0;
    let lastTs = null;
    for (const event of ordered) {
      const ts = normalizeTs(event.ts);
      if (!ts || bucketStart15m(ts) !== currentBucket) continue;
      const side = String(event.side || '').toLowerCase();
      if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
      if (side.includes('long') || side === 'buy') long++; else short++;
      lastTs = ts;
    }
    return { symbol, long, short, difference: long - short, events: long + short, lastEvent: lastTs ? new Date(lastTs).toISOString() : null };
  });
}

function findFirstZeroCrossing(eventsBySymbol, closedBucket) {
  let first = null;
  for (const [symbol, events] of eventsBySymbol.entries()) {
    const ordered = events.slice().sort((a, b) => normalizeTs(a.ts) - normalizeTs(b.ts));
    let longCount = 0;
    let shortCount = 0;
    let previousSign = 0;
    const seen = new Set();

    for (const event of ordered) {
      const ts = normalizeTs(event.ts);
      if (!ts || bucketStart15m(ts) !== closedBucket || normalizeSymbol(event.symbol) !== symbol) continue;
      const side = String(event.side || '').toLowerCase();
      if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      if (side.includes('long') || side === 'buy') longCount++;
      else shortCount++;

      const difference = longCount - shortCount;
      const sign = difference > 0 ? 1 : difference < 0 ? -1 : 0;
      if (previousSign !== 0 && sign !== 0 && sign !== previousSign) {
        const candidate = { symbol: normalizeSymbol(symbol), longCount, shortCount, difference, ts };
        if (!first || ts < first.ts) first = candidate;
        break;
      }
      if (sign !== 0) previousSign = sign;
    }
  }
  return first;
}

async function check15mOnce(currentBucket) {
  const results = await Promise.all(SYMBOLS.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad 15m ${symbol}: ${error.message}`); return [symbol, []]; }
  }));

  const eventsBySymbol = new Map(results.map(([symbol, events]) => [normalizeSymbol(symbol), Array.isArray(events) ? events : []]));
  const diagnostics = summarizeActivePeriod(eventsBySymbol, currentBucket);
  console.log(JSON.stringify({ type: 'liquidation_15m_diagnostics', period: new Date(currentBucket).toISOString(), coins: diagnostics }));
  const crossing = findFirstZeroCrossing(eventsBySymbol, currentBucket);

  console.log(JSON.stringify({
    type: 'liquidation_15m_zero_crossing_check',
    period: new Date(currentBucket).toISOString(),
    crossing: crossing ? { symbol: crossing.symbol, long: crossing.longCount, short: crossing.shortCount, difference: crossing.difference, ts: new Date(crossing.ts).toISOString() } : null,
  }));

  if (!crossing) return;

  const alertKey = `15m:${currentBucket}`;
  if (sentAlerts15m.has(alertKey)) return;

  const nextMarket = await findNextMarket15m(crossing.symbol, Date.now());
  const emoji = crossing.difference > 0 ? '🔴' : '🟢';
  const message = [
    `${emoji} LIQUIDATION IMBALANCE FLIP`,
    `${crossing.symbol} · 15M · ${formatUtcPlus3(crossing.ts)} UTC+3`, '',
    `Long: ${crossing.longCount} · Short: ${crossing.shortCount}`,
    `Difference: ${crossing.difference > 0 ? '+' : ''}${crossing.difference}`,
    '',
    '➡️ NEXT Polymarket 15M',
    nextMarket?.url || 'Market not found yet',
  ].join('\n');

  await sendTelegramMessage(message);
  sentAlerts15m.add(alertKey);
  await saveState15m();
  console.log(JSON.stringify({ type: 'liquidation_15m_zero_crossing_alert', symbol: crossing.symbol, longCount: crossing.longCount, shortCount: crossing.shortCount, difference: crossing.difference, crossingTs: new Date(crossing.ts).toISOString(), period: new Date(currentBucket).toISOString(), condition: 'LONG_MINUS_SHORT_SIGN_CROSS', alertSent: true, nextMarket: nextMarket?.url || null }));
}

async function main15m() {
  await loadState15m();
  console.log(`15M liquidation zero-crossing monitor started; symbols=${SYMBOLS.join(',')}; alert on LONG minus SHORT sign change; one alert per period; poll=${POLL_MS}ms`);
  while (true) {
    const now = Date.now();
    const currentBucket = bucketStart15m(now);
    try { await check15mOnce(currentBucket); }
    catch (error) { console.error(`15M liquidation monitor failed: ${error.stack || error.message}`); }
    await sleep(POLL_MS);
  }
}

main15m().catch(error => { console.error(`15M liquidation monitor fatal: ${error.stack || error.message}`); process.exitCode = 1; });
