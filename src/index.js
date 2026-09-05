const https = require('https');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey, WINDOW_MS } = require('./liquidation-monitor');
const { findNextMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

// 5M LIQUIDATION IMBALANCE: per coin, monitor cumulative LONG liquidation volume minus SHORT liquidation volume.
// Alert immediately when the notional-volume sign crosses zero during the active period. Maximum one alert per period.
const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_MS_5M = WINDOW_MS;
const POLL_MS = 10000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const sentAlerts = new Set();
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
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveState() {
  if (!process.env.GITHUB_TOKEN) return;
  const content = Buffer.from(JSON.stringify({ alerts: [...sentAlerts].slice(-500) }, null, 2)).toString('base64');
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
function formatUsd(value) { return `$${Math.round(value).toLocaleString('en-US')}`; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function eventNotional(event) {
  const value = Number(event.notional);
  if (Number.isFinite(value) && value >= 0) return value;
  const price = Number(event.price);
  const qty = Number(event.qty);
  return Number.isFinite(price) && Number.isFinite(qty) ? Math.abs(price * qty) : 0;
}

function summarizeActivePeriod(eventsBySymbol, activeBucket) {
  return symbols.map(symbol => {
    const ordered = (eventsBySymbol.get(symbol) || []).slice().sort((a, b) => normalizeTs(a.ts) - normalizeTs(b.ts));
    let longVolume = 0;
    let shortVolume = 0;
    let events = 0;
    let lastTs = null;
    for (const event of ordered) {
      const ts = normalizeTs(event.ts);
      if (!ts || bucketStart(ts) !== activeBucket) continue;
      const side = String(event.side || '').toLowerCase();
      if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
      const notional = eventNotional(event);
      if (side.includes('long') || side === 'buy') longVolume += notional; else shortVolume += notional;
      events++;
      lastTs = ts;
    }
    return { symbol, longVolume, shortVolume, difference: longVolume - shortVolume, events, lastEvent: lastTs ? new Date(lastTs).toISOString() : null };
  });
}

function findFirstZeroCrossing(eventsBySymbol, activeBucket) {
  let first = null;
  for (const [symbol, events] of eventsBySymbol.entries()) {
    const ordered = events.slice().sort((a, b) => normalizeTs(a.ts) - normalizeTs(b.ts));
    let longVolume = 0;
    let shortVolume = 0;
    let previousSign = 0;
    const seen = new Set();

    for (const event of ordered) {
      const ts = normalizeTs(event.ts);
      if (!ts || bucketStart(ts) !== activeBucket) continue;
      const side = String(event.side || '').toLowerCase();
      if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      const notional = eventNotional(event);
      if (side.includes('long') || side === 'buy') longVolume += notional;
      else shortVolume += notional;

      const difference = longVolume - shortVolume;
      const sign = difference > 0 ? 1 : difference < 0 ? -1 : 0;
      if (previousSign !== 0 && sign !== 0 && sign !== previousSign) {
        const candidate = { symbol: normalizeSymbol(symbol), longVolume, shortVolume, difference, ts };
        if (!first || ts < first.ts) first = candidate;
        break;
      }
      if (sign !== 0) previousSign = sign;
    }
  }
  return first;
}

async function checkOnce(activeBucket) {
  const results = await Promise.all(symbols.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad live ${symbol}: ${error.message}`); return [symbol, []]; }
  }));

  const eventsBySymbol = new Map(results.map(([symbol, events]) => [normalizeSymbol(symbol), Array.isArray(events) ? events : []]));
  const diagnostics = summarizeActivePeriod(eventsBySymbol, activeBucket);
  console.log(JSON.stringify({ type: 'liquidation_5m_diagnostics', period: new Date(activeBucket).toISOString(), coins: diagnostics }));
  const crossing = findFirstZeroCrossing(eventsBySymbol, activeBucket);

  console.log(JSON.stringify({
    type: 'liquidation_5m_zero_crossing_check',
    period: new Date(activeBucket).toISOString(),
    crossing: crossing ? { symbol: crossing.symbol, longVolume: crossing.longVolume, shortVolume: crossing.shortVolume, difference: crossing.difference, ts: new Date(crossing.ts).toISOString() } : null,
  }));

  if (!crossing) return;

  const alertKey = `5m:${activeBucket}`;
  if (sentAlerts.has(alertKey)) return;

  const nextMarket = await findNextMarket(crossing.symbol, Date.now());
  const emoji = crossing.difference > 0 ? '🔴' : '🟢';
  const message = [
    `${emoji} LIQUIDATION IMBALANCE FLIP`,
    `${crossing.symbol} · 5M · ${formatUtcPlus3(crossing.ts)} UTC+3`, '',
    `Long: ${formatUsd(crossing.longVolume)} · Short: ${formatUsd(crossing.shortVolume)}`,
    `Difference: ${crossing.difference >= 0 ? '+' : '-'}${formatUsd(Math.abs(crossing.difference))}`,
    '',
    '➡️ NEXT Polymarket 5M',
    nextMarket?.url || 'Market not found yet',
  ].join('\n');

  await sendTelegramMessage(message);
  sentAlerts.add(alertKey);
  await saveState();
  console.log(JSON.stringify({ type: 'liquidation_5m_zero_crossing_alert', symbol: crossing.symbol, longVolume: crossing.longVolume, shortVolume: crossing.shortVolume, difference: crossing.difference, crossingTs: new Date(crossing.ts).toISOString(), period: new Date(activeBucket).toISOString(), condition: 'LONG_NOTIONAL_MINUS_SHORT_NOTIONAL_SIGN_CROSS', alertSent: true, nextMarket: nextMarket?.url || null }));
}

async function main() {
  await loadState();
  console.log(`5M liquidation zero-crossing monitor started; symbols=${symbols.join(',')}; active-period LONG notional minus SHORT notional sign change; one alert per period; poll=${POLL_MS}ms`);

  while (true) {
    const activeBucket = bucketStart(Date.now());
    try { await checkOnce(activeBucket); }
    catch (error) { console.error(`MONITOR CYCLE FAILED: ${error.stack || error.message}`); }
    await sleep(POLL_MS);
  }
}

main().catch(error => { console.error(`MONITOR FAILED: ${error.stack || error.message}`); process.exitCode = 1; });
