const { findNextMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const SYMBOLS = ['BTC/USD', 'ETH/USD', 'SOL/USD', 'XRP/USD', 'DOGE/USD', 'BNB/USD', 'HYPE/USD'];
const LABELS = new Map(SYMBOLS.map(symbol => [symbol, symbol.split('/')[0]]));
const INTERVAL = '5min';
const ATR_PERIOD = 14;
const OUTPUT_SIZE = ATR_PERIOD + 1;
const STATE_PATH = '.volatility-state.json';
const GITHUB_API = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;

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
        'User-Agent': 'polymarket-volatility-monitor',
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
    if (!data?.content) return { sha: null, lastBucket: null };
    return {
      sha: data.sha || null,
      lastBucket: JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')).lastBucket || null
    };
  } catch (error) {
    if (!String(error.message).includes('404')) console.warn(`STATE LOAD FAILED: ${error.message}`);
    return { sha: null, lastBucket: null };
  }
}

async function saveState(lastBucket, sha) {
  const content = Buffer.from(JSON.stringify({ lastBucket }, null, 2)).toString('base64');
  const body = {
    message: 'Persist volatility monitor state',
    content,
    branch: process.env.GITHUB_REF_NAME || 'main'
  };
  if (sha) body.sha = sha;
  const result = await githubRequest('PUT', body);
  return result?.content?.sha || sha || null;
}

async function fetchBatch() {
  const apiKey = process.env.TWELVE_DATA_API_KEY;
  if (!apiKey) throw new Error('TWELVE_DATA_API_KEY secret is not configured');
  const url = new URL('https://api.twelvedata.com/time_series');
  url.searchParams.set('symbol', SYMBOLS.join(','));
  url.searchParams.set('interval', INTERVAL);
  url.searchParams.set('outputsize', String(OUTPUT_SIZE));
  url.searchParams.set('apikey', apiKey);
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const json = await response.json();
  if (!response.ok) throw new Error(`Twelve Data HTTP ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

function calculateNatr(values) {
  const rows = [...values].reverse().map(row => ({
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    datetime: row.datetime
  })).filter(row => Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close) && row.close > 0);
  if (rows.length < ATR_PERIOD + 1) return null;
  const trs = rows.map((row, i) => {
    if (i === 0) return row.high - row.low;
    const prevClose = rows[i - 1].close;
    return Math.max(row.high - row.low, Math.abs(row.high - prevClose), Math.abs(row.low - prevClose));
  });
  const last = rows.length - 1;
  const start = last - ATR_PERIOD + 1;
  const atr = trs.slice(start, last + 1).reduce((sum, value) => sum + value, 0) / ATR_PERIOD;
  const natr = (atr / rows[last].close) * 100;
  return { natr, close: rows[last].close, datetime: rows[last].datetime };
}

async function getMetrics() {
  const batch = await fetchBatch();
  return SYMBOLS.map(symbol => {
    const payload = batch[symbol];
    if (!payload || !Array.isArray(payload.values)) return { symbol, error: payload?.message || 'No data' };
    const metric = calculateNatr(payload.values);
    return metric ? { symbol, ...metric } : { symbol, error: 'Not enough OHLC data' };
  });
}

async function main() {
  const state = await loadState();
  const now = Date.now();
  const currentBucket = Math.floor(now / 300000) * 300000;
  const closedBucket = currentBucket - 300000;
  const bucketKey = new Date(closedBucket).toISOString();

  if (state.lastBucket === bucketKey) {
    console.log(`Already alerted for ${bucketKey}; exiting.`);
    return;
  }

  // Give Twelve Data a few seconds after the 5-minute boundary so the latest bar is finalized.
  await sleep(8000);
  const metrics = await getMetrics();
  const valid = metrics.filter(item => Number.isFinite(item.natr)).sort((a, b) => b.natr - a.natr);
  if (!valid.length) throw new Error(`No valid NATR values: ${JSON.stringify(metrics)}`);

  const winner = valid[0];
  const nextMarket = await findNextMarket(winner.symbol.split('/')[0], currentBucket);
  const time = new Date(closedBucket).toISOString().slice(11, 16);
  const message = [
    '🔥 VOLATILITY LEADER',
    '',
    `${LABELS.get(winner.symbol)} · 5M · ${time} UTC`,
    '',
    `NATR(14): ${winner.natr.toFixed(2)}%`,
    `Price: ${winner.close}`,
    '',
    '📊 7 COINS',
    ...valid.map(item => `${LABELS.get(item.symbol)}: ${item.natr.toFixed(2)}%`),
    '',
    '➡️ NEXT Polymarket 5M',
    nextMarket?.url || 'Market not found yet'
  ].join('\n');

  await sendTelegramMessage(message);
  const newSha = await saveState(bucketKey, state.sha);
  console.log(JSON.stringify({ type: 'volatility_5m_alert', bucket: bucketKey, winner: LABELS.get(winner.symbol), natr: winner.natr, nextMarket: nextMarket?.url || null, stateSha: newSha }));
}

main().catch(error => {
  console.error(`VOLATILITY MONITOR FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
