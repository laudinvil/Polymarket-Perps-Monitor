const https = require('https');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey } = require('./liquidation-monitor');
const { findNextMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const POLL_MS = 30000;
const MIN_FLIP_IMBALANCE = 3;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const sentAlerts = new Set();
const seenEvents = new Set();
const runningImbalance = new Map();
let stateSha = null;
let activePeriod = null;

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
    for (const item of state.liquidationRunning || []) {
      if (!item?.symbol) continue;
      runningImbalance.set(normalizeSymbol(item.symbol), {
        imbalance: Number(item.imbalance) || 0,
        longStrength: Number(item.longStrength) || 0,
        shortStrength: Number(item.shortStrength) || 0,
        longEvents: Number(item.longEvents) || 0,
        shortEvents: Number(item.shortEvents) || 0,
        events: Number(item.events) || 0,
        lastTs: item.lastTs ? Number(item.lastTs) : null,
        previousSign: Number(item.previousSign) || 0,
      });
    }
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveState() {
  if (!process.env.GITHUB_TOKEN) return;
  const stats = activePeriod === null ? [] : diagnostics(activePeriod);
  const statePayload = {
    updatedAt: new Date().toISOString(),
    period: activePeriod === null ? null : new Date(activePeriod).toISOString(),
    alerts: [...sentAlerts].slice(-500),
    liquidation5m: stats,
    liquidationRunning: symbols.map(symbol => {
      const state = runningImbalance.get(normalizeSymbol(symbol)) || { imbalance: 0, longStrength: 0, shortStrength: 0, longEvents: 0, shortEvents: 0, events: 0, lastTs: null, previousSign: 0 };
      return { symbol: normalizeSymbol(symbol), imbalance: state.imbalance, longStrength: state.longStrength, shortStrength: state.shortStrength, longEvents: state.longEvents, shortEvents: state.shortEvents, events: state.events, lastTs: state.lastTs, previousSign: state.previousSign };
    }),
  };
  const content = Buffer.from(JSON.stringify(statePayload, null, 2)).toString('base64');
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
function formatSignedCount(value) { return `${value >= 0 ? '+' : ''}${value}`; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function eventSideSign(event) {
  const side = String(event.side || '').toLowerCase();
  if (side.includes('long') || side === 'buy') return 1;
  if (side.includes('short') || side === 'sell') return -1;
  return 0;
}

function resetPeriod(period) { activePeriod = period; }

function applyNewRawEvents(eventsBySymbol, activeBucket) {
  const changes = [];
  for (const symbol of symbols) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const events = (eventsBySymbol.get(normalizedSymbol) || []).slice().sort((a, b) => normalizeTs(a.ts) - normalizeTs(b.ts));
    let state = runningImbalance.get(normalizedSymbol) || { imbalance: 0, longStrength: 0, shortStrength: 0, longEvents: 0, shortEvents: 0, events: 0, lastTs: null, previousSign: 0 };
    let updateLong = 0;
    let updateShort = 0;
    let updateLastTs = null;

    for (const event of events) {
      const ts = normalizeTs(event.ts);
      if (!ts || bucketStart(ts) !== activeBucket) continue;
      const sign = eventSideSign(event);
      if (sign === 0) continue;
      const key = `${activeBucket}:${eventKey(event)}`;
      if (seenEvents.has(key)) continue;
      seenEvents.add(key);
      if (sign > 0) updateLong += 1;
      else updateShort += 1;
      if (!updateLastTs || ts > updateLastTs) updateLastTs = ts;
    }

    if (updateLong === 0 && updateShort === 0) {
      runningImbalance.set(normalizedSymbol, state);
      continue;
    }

    const before = state.imbalance;
    const oldEstablishedSign = state.previousSign;
    state.imbalance += updateLong - updateShort;
    state.longEvents += updateLong;
    state.shortEvents += updateShort;
    state.events += updateLong + updateShort;
    state.lastTs = updateLastTs;
    state.longStrength = Math.max(0, state.imbalance);
    state.shortStrength = Math.max(0, -state.imbalance);

    const newSign = state.imbalance > 0 ? 1 : state.imbalance < 0 ? -1 : 0;
    const reachedThreshold = Math.abs(state.imbalance) >= MIN_FLIP_IMBALANCE;
    const isRealFlip = oldEstablishedSign !== 0 && reachedThreshold && newSign !== oldEstablishedSign;

    if (isRealFlip) {
      changes.push({ symbol: normalizedSymbol, before, after: state.imbalance, longStrength: state.longStrength, shortStrength: state.shortStrength, longEvents: state.longEvents, shortEvents: state.shortEvents, updateLong, updateShort, ts: updateLastTs, period: activeBucket });
    }

    if (reachedThreshold) state.previousSign = newSign;
    runningImbalance.set(normalizedSymbol, state);

    console.log(JSON.stringify({ type: 'liquidation_running_update', symbol: normalizedSymbol, updateLong, updateShort, runningImbalance: state.imbalance, longStrength: state.longStrength, shortStrength: state.shortStrength, cumulativeLongEvents: state.longEvents, cumulativeShortEvents: state.shortEvents, previousEstablishedSign: state.previousSign, minFlipImbalance: MIN_FLIP_IMBALANCE, period: new Date(activeBucket).toISOString() }));
  }
  return changes;
}

function diagnostics(activeBucket) {
  return symbols.map(symbol => {
    const state = runningImbalance.get(normalizeSymbol(symbol)) || { imbalance: 0, longStrength: 0, shortStrength: 0, longEvents: 0, shortEvents: 0, events: 0, lastTs: null };
    return { symbol: normalizeSymbol(symbol), longLiquidations: state.longStrength, shortLiquidations: state.shortStrength, cumulativeLongEvents: state.longEvents, cumulativeShortEvents: state.shortEvents, imbalance: state.imbalance, totalLiquidations: state.events, lastEvent: state.lastTs ? new Date(state.lastTs).toISOString() : null, period: new Date(activeBucket).toISOString() };
  });
}

async function checkOnce(activeBucket) {
  resetPeriod(activeBucket);
  const results = await Promise.all(symbols.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad live ${symbol}: ${error.message}`); return [symbol, []]; }
  }));
  const eventsBySymbol = new Map(results.map(([symbol, events]) => [normalizeSymbol(symbol), Array.isArray(events) ? events : []]));
  const crossings = applyNewRawEvents(eventsBySymbol, activeBucket);
  console.log(JSON.stringify({ type: 'liquidation_running_imbalance', coins: diagnostics(activeBucket), minFlipImbalance: MIN_FLIP_IMBALANCE }));

  for (const crossing of crossings.sort((a, b) => a.ts - b.ts)) {
    const alertKey = `5m:${crossing.symbol}:${crossing.ts}:${crossing.after}`;
    if (sentAlerts.has(alertKey)) continue;
    let nextMarket;
    try { nextMarket = await findNextMarket(crossing.symbol, Date.now()); }
    catch (error) { console.warn(`POLYMARKET LINK RESOLVE FAILED: ${crossing.symbol}: ${error.message}`); continue; }
    const emoji = crossing.after < 0 ? '🔴' : '🟢';
    const message = [
      `${emoji} LIQUIDATION IMBALANCE FLIP`,
      `${crossing.symbol} · 5M · ${formatUtcPlus3(crossing.ts)} UTC+3`, '',
      `Previous imbalance: ${formatSignedCount(crossing.before)} liquidations`,
      `New imbalance: ${formatSignedCount(crossing.after)} liquidations`,
      `Update: +${crossing.updateLong} LONG · +${crossing.updateShort} SHORT`,
      `Long strength: ${crossing.longStrength}`,
      `Short strength: ${crossing.shortStrength}`,
      `Cumulative LONG events: ${crossing.longEvents}`,
      `Cumulative SHORT events: ${crossing.shortEvents}`,
      '', '➡️ NEXT Polymarket 5M', nextMarket?.url || 'Market not found yet',
    ].join('\n');
    await sendTelegramMessage(message);
    sentAlerts.add(alertKey);
    await saveState();
  }
  if (crossings.length === 0) await saveState();
}

async function main() {
  await loadState();
  console.log(`5M liquidation running monitor started; symbols=${symbols.join(',')}; cumulative balance preserved; minimum flip imbalance=${MIN_FLIP_IMBALANCE}; poll=${POLL_MS}ms`);
  while (true) {
    const activeBucket = bucketStart(Date.now());
    try { await checkOnce(activeBucket); }
    catch (error) { console.error(`MONITOR CYCLE FAILED: ${error.stack || error.message}`); }
    await sleep(POLL_MS);
  }
}

main().catch(error => { console.error(`MONITOR FAILED: ${error.stack || error.message}`); process.exitCode = 1; });
