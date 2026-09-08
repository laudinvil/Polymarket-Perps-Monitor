const https = require('https');
const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { TIMEFRAMES, bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const MONITORED = ['5m', '15m', '1h', '4h', '1d'];
const POLL_MS = 4000;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}?ref=monitor-status`;
const REQUEST_TIMEOUT_MS = 15000;

const sentAlerts = new Set();
const processedBuckets = new Set();

function localBucketStart(ts, tf) { return bucketStart(ts, tf); }
function side(event) {
  const s = String(event?.side || event?.direction || '').toLowerCase();
  return s.includes('long') ? 1 : s.includes('short') ? -1 : 0;
}
function formatCount(v) { return Math.max(0, Number(v) || 0).toLocaleString('en-US'); }
function githubRequest(method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const u = new URL(STATE_API_URL);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, timeout: REQUEST_TIMEOUT_MS,
      headers: { 'User-Agent': 'Polymarket-Perps-Monitor', Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN || ''}`, 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => data += c); res.on('end', () => {
        let parsed = null; try { parsed = data ? JSON.parse(data) : null; } catch {}
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
        const error = new Error(`GitHub state request failed: ${res.statusCode}`); error.statusCode = res.statusCode; reject(error);
      });
    });
    req.on('timeout', () => req.destroy(new Error('GitHub state request timed out'))); req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
  });
}
function normalizeAlertKey(key) {
  if (typeof key !== 'string') return null;
  const m = key.match(/^(5m|15m|1h|4h|1d):([A-Z]+):(\d+)(?::(-?1))?$/);
  return m ? (m[4] ? `${m[1]}:${m[2]}:${m[3]}:${m[4]}` : `${m[1]}:${m[2]}:${m[3]}`) : null;
}
function loadPersistedState(state) {
  for (const key of [...(state?.sentAlerts || []), ...(state?.alerts || [])]) {
    const normalized = normalizeAlertKey(key); if (normalized) sentAlerts.add(normalized);
  }
}
async function loadState() {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const response = await githubRequest();
    if (!response?.content) return;
    loadPersistedState(JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8')));
    console.log(`STATE LOADED; global-largest-liquidation mode; timeframes=${MONITORED.join(',')}; symbols=${SYMBOLS.join(',')}`);
  } catch (error) { console.warn(`STATE LOAD FAILED: ${error.message}`); }
}
async function reserveAlertKey(key) {
  if (sentAlerts.has(key)) { console.log(`ALERT DUPLICATE SUPPRESSED ${key}`); return false; }
  if (!process.env.GITHUB_TOKEN) return true;
  try {
    const response = await githubRequest();
    if (response?.content) {
      const state = JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8'));
      const keys = new Set([...(state.sentAlerts || []), ...(state.alerts || [])].map(normalizeAlertKey).filter(Boolean));
      if (keys.has(key)) { sentAlerts.add(key); console.log(`ALERT DUPLICATE SUPPRESSED ${key}`); return false; }
    }
    return true;
  } catch (error) { console.warn(`ALERT DEDUP CHECK FAILED ${key}: ${error.message}`); return false; }
}
async function saveSentAlert(key) {
  sentAlerts.add(key); if (!process.env.GITHUB_TOKEN) return;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      let response = null; try { response = await githubRequest(); } catch (error) { if (error.statusCode !== 404) throw error; }
      const state = response?.content ? JSON.parse(Buffer.from(response.content.replace(/\s/g, ''), 'base64').toString('utf8')) : {};
      const keys = new Set([...(state.sentAlerts || []), ...(state.alerts || [])].map(normalizeAlertKey).filter(Boolean)); keys.add(key); state.sentAlerts = [...keys];
      await githubRequest('PUT', { message: 'Persist liquidation count alert state', content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'), branch: 'monitor-status', ...(response?.sha ? { sha: response.sha } : {}) });
      return;
    } catch (error) { if (error.statusCode !== 409 || attempt === 5) { console.warn(`STATE SAVE FAILED: ${error.message}`); return; } await new Promise(r => setTimeout(r, 250 * attempt)); }
  }
}
async function fetchAllFeeds() {
  return new Map(await Promise.all(SYMBOLS.map(async symbol => { try { return [symbol, await fetchSymbolFeed(symbol)]; } catch (error) { console.warn(`FEED ${symbol} FAILED: ${error.message}`); return [symbol, []]; } })));
}
function aggregate(events, period, tf, symbol) {
  let longEvents = 0, shortEvents = 0;
  for (const event of events || []) {
    const ts = normalizeTs(event?.ts); if (!ts || localBucketStart(ts, tf) !== period) continue;
    const s = side(event); if (!s) continue;
    if (s > 0) longEvents++; else shortEvents++;
  }
  const totalEvents = longEvents + shortEvents;
  const dominantSign = longEvents > shortEvents ? 1 : shortEvents > longEvents ? -1 : 0;
  return { symbol, tf, period, longEvents, shortEvents, events: totalEvents, dominantCount: Math.max(longEvents, shortEvents), sign: dominantSign };
}
async function findPlusOneMarket(symbol, completedBucketStart, tf) {
  const window = TIMEFRAMES[tf];
  const plusOne = completedBucketStart + window + window;
  return findMarketByEpoch(symbol, plusOne, tf);
}
function chooseGlobalWinner(rows) {
  const candidates = [];
  for (const row of rows) {
    if (row.longEvents > 0) candidates.push({ row, count: row.longEvents, sign: 1 });
    if (row.shortEvents > 0) candidates.push({ row, count: row.shortEvents, sign: -1 });
  }
  if (!candidates.length) return null;
  const maxCount = Math.max(...candidates.map(c => c.count));
  const winners = candidates.filter(c => c.count === maxCount);
  if (winners.length !== 1) return null;
  const winner = winners[0];
  return { ...winner.row, dominantCount: winner.count, sign: winner.sign };
}
async function sendAlert(row) {
  if (!row || !row.sign) return;
  const key = `${row.tf}:GLOBAL:${row.period}:${row.symbol}:${row.sign}`;
  if (!(await reserveAlertKey(key))) return;
  let market = null;
  try { market = await findPlusOneMarket(row.symbol, row.period, row.tf); }
  catch (error) { console.warn(`POLYMARKET LOOKUP FAILED ${row.tf} ${row.symbol}: ${error.message}`); }
  const direction = row.sign > 0 ? 'BUY UP' : 'BUY DOWN', color = row.sign > 0 ? '🟢' : '🔴';
  const timeframe = row.tf.toUpperCase();
  const link = market?.url ? `\n\n➡️ NEXT+1 Polymarket ${timeframe}\n${market.url}` : '';
  const msg = `${color} ${row.symbol} · ${direction} · ${timeframe}\n\nLiquidations: ${formatCount(row.dominantCount)} ${row.sign > 0 ? 'LONG' : 'SHORT'}\n\n${formatCount(row.longEvents)} LONG · ${formatCount(row.shortEvents)} SHORT${link}`;
  try { await sendTelegramMessage(msg); await saveSentAlert(key); console.log(`${row.tf} GLOBAL LARGEST LIQUIDATION ALERT SENT ${row.symbol} ${direction} ${timeframe} count=${formatCount(row.dominantCount)} bucket=${new Date(row.period).toISOString()}`); }
  catch (error) { console.warn(`${row.tf} LIQUIDATION COUNT ALERT SEND FAILED ${row.symbol}: ${error.message}`); }
}
async function main() {
  await loadState();
  console.log(`Liquidation monitor started; ONLY ONE GLOBAL LARGEST LIQUIDATION COUNT PER BUCKET; timeframes=${MONITORED.join(',')}; symbols=${SYMBOLS.join(',')}; Polymarket NEXT+1 links enabled`);
  const lastCompleted = new Map(MONITORED.map(tf => [tf, null]));
  while (true) {
    const now = Date.now(), feeds = await fetchAllFeeds();
    for (const tf of MONITORED) {
      const window = TIMEFRAMES[tf], current = bucketStart(now, tf), completed = current - window;
      let last = lastCompleted.get(tf); if (last === null) last = completed - window;
      if (completed <= last) continue;
      for (let period = last + window; period <= completed; period += window) {
        const rows = [];
        for (const symbol of SYMBOLS) {
          const bucketKey = `${tf}:${symbol}:${period}`; if (processedBuckets.has(bucketKey)) continue;
          processedBuckets.add(bucketKey); rows.push(aggregate(feeds.get(symbol), period, tf, symbol));
        }
        const winner = chooseGlobalWinner(rows);
        if (winner) await sendAlert(winner);
        else console.log(`GLOBAL LARGEST LIQUIDATION ${tf} ${new Date(period + window).toISOString()} NO UNIQUE WINNER`);
        for (const row of rows) {
          console.log(`TIMEFRAME BOUNDARY ${tf} ${row.symbol} ${new Date(period + window).toISOString()} dominant=${formatCount(row.dominantCount)} longEvents=${formatCount(row.longEvents)} shortEvents=${formatCount(row.shortEvents)} events=${formatCount(row.events)}`);
        }
      }
      lastCompleted.set(tf, completed);
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
main().catch(error => { console.error(`FATAL: ${error.stack || error.message}`); process.exitCode = 1; });
