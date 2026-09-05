const https = require('https');
const { sendTelegramMessage } = require('./telegram');

const LONG_SHORT_URL = 'https://marginpad.io/api/v1/long-short';
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const STATE_PATH = '.long-short-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
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
        'User-Agent': 'long-short-monitor',
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
  const body = {
    message: 'Persist long short monitor state',
    content,
    branch: process.env.GITHUB_REF_NAME || 'main'
  };
  if (stateSha) body.sha = stateSha;
  try {
    const result = await githubRequest('PUT', body);
    stateSha = result?.content?.sha || stateSha;
  } catch (error) {
    console.warn(`STATE SAVE FAILED: ${error.message}`);
  }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function getBoundary(now, windowMs) { return Math.floor(now / windowMs) * windowMs; }
function formatUtcPlus3(ms) { return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16); }

async function fetchLongShort() {
  const response = await fetch(LONG_SHORT_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`MarginPad long-short HTTP ${response.status}`);
  const json = await response.json();
  if (json?.ok === false) throw new Error(json?.error?.message || 'MarginPad long-short returned an error');
  return json?.data ?? json;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.data)) return data.data;
  if (data && typeof data === 'object') {
    return Object.entries(data).map(([symbol, value]) => ({ symbol, ...(value && typeof value === 'object' ? value : { ratio: value }) }));
  }
  return [];
}

function normalizeRow(raw) {
  const symbol = String(raw?.symbol || raw?.coin || raw?.asset || '').toUpperCase().replace(/USDT$|USD$/i, '');
  if (!SYMBOLS.includes(symbol)) return null;

  let ratio = toNumber(raw?.ratio ?? raw?.longShortRatio ?? raw?.long_short_ratio);
  let longPct = toNumber(raw?.longPct ?? raw?.long_pct ?? raw?.longPercent ?? raw?.long_percentage);
  let shortPct = toNumber(raw?.shortPct ?? raw?.short_pct ?? raw?.shortPercent ?? raw?.short_percentage);

  if (longPct == null && shortPct == null && ratio != null) {
    longPct = 100 * ratio / (1 + ratio);
    shortPct = 100 - longPct;
  }

  if (ratio == null && longPct != null && shortPct != null && shortPct > 0) {
    ratio = longPct / shortPct;
  }

  if (longPct == null || shortPct == null || ratio == null) return null;
  if (longPct < 0 || shortPct < 0) return null;

  const side = longPct > shortPct ? 'long' : longPct < shortPct ? 'short' : 'tie';
  if (side === 'tie') return null;

  const imbalance = Math.max(longPct, shortPct) / Math.max(Math.min(longPct, shortPct), 0.000001);
  return { symbol, longPct, shortPct, ratio, side, imbalance };
}

async function checkPeriod(boundary, timeframe) {
  const bucketKey = `${timeframe}:${boundary}`;
  if (sentAlerts.has(`processed:${bucketKey}`)) return;

  const data = await fetchLongShort();
  const rows = extractRows(data).map(normalizeRow).filter(Boolean);
  const available = new Set(rows.map(row => row.symbol));
  const missing = SYMBOLS.filter(symbol => !available.has(symbol));

  // This strategy is positioning data, not liquidation data. It never reads the liquidation feed.
  rows.sort((a, b) => b.imbalance - a.imbalance);
  const winner = rows[0] || null;
  sentAlerts.add(`processed:${bucketKey}`);

  if (!winner) {
    console.log(JSON.stringify({ type: 'long_short_no_alert', timeframe, boundary: new Date(boundary).toISOString(), reason: 'no_non_tied_positioning_data', missing }));
    await saveState();
    return;
  }

  const alertKey = `alert:${bucketKey}`;
  if (sentAlerts.has(alertKey)) {
    await saveState();
    return;
  }

  const epoch = Math.floor(boundary / 1000);
  const asset = winner.symbol.toLowerCase();
  const slug = `${asset}-updown-${timeframe}-${epoch}`;
  const marketUrl = `https://polymarket.com/event/${slug}`;
  const emoji = winner.side === 'long' ? '🟢' : '🔴';
  const label = formatUtcPlus3(boundary);

  const message = [
    `${emoji} ${winner.side.toUpperCase()} POSITIONING`,
    `${winner.symbol} · ${timeframe.toUpperCase()} · ${label} UTC+3`,
    '',
    `Long: ${winner.longPct.toFixed(1)}%`,
    `Short: ${winner.shortPct.toFixed(1)}%`,
    `Ratio: ${winner.ratio.toFixed(2)}x`,
    '',
    `➡️ NEXT Polymarket ${timeframe.toUpperCase()}`,
    marketUrl
  ].join('\n');

  await sendTelegramMessage(message);
  sentAlerts.add(alertKey);
  console.log(JSON.stringify({
    type: 'long_short_positioning_winner',
    timeframe,
    boundary: new Date(boundary).toISOString(),
    symbol: winner.symbol,
    leaderSide: winner.side,
    longPct: winner.longPct,
    shortPct: winner.shortPct,
    ratio: winner.ratio,
    alertSent: true,
    missing
  }));
  await saveState();
}

async function main() {
  await loadState();
  console.log(`LONG/SHORT monitor started; source=${LONG_SHORT_URL}; symbols=${SYMBOLS.join(',')}; positioning only; NO liquidations; strongest Long/Short imbalance; exact 5m/15m boundaries`);

  while (true) {
    const now = Date.now();
    const next5 = getBoundary(now, WINDOW_5M) + WINDOW_5M;
    const next15 = getBoundary(now, WINDOW_15M) + WINDOW_15M;
    const next = Math.min(next5, next15);
    await sleep(Math.max(0, next - Date.now()));
    const boundary = next;

    try {
      if (boundary % WINDOW_5M === 0) await checkPeriod(boundary, '5m');
      if (boundary % WINDOW_15M === 0) await checkPeriod(boundary, '15m');
    } catch (error) {
      console.error(`LONG/SHORT CYCLE FAILED: ${error.stack || error.message}`);
    }
  }
}

main().catch(error => {
  console.error(`LONG/SHORT FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
