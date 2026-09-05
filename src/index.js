const https = require('https');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol } = require('./liquidation-monitor');
const { TIMEFRAMES, findMarketByEpoch } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const FRAMEWORKS = ['5m', '15m', '1h', '4h', '1d'];
const BOUNDARY_GRACE_MS = 1500;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const sentAlerts = new Set();
const timeframeState = new Map();
let stateSha = null;

function emptySymbolState() {
  return { imbalanceUsd: 0, longUsd: 0, shortUsd: 0, longEvents: 0, shortEvents: 0, events: 0, establishedSign: 0, lastBucket: null };
}

function ensureState() {
  for (const timeframe of FRAMEWORKS) {
    if (!timeframeState.has(timeframe)) timeframeState.set(timeframe, new Map());
    const map = timeframeState.get(timeframe);
    for (const symbol of symbols) if (!map.has(symbol)) map.set(symbol, emptySymbolState());
  }
}

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
        'User-Agent': 'marginpad-multi-timeframe-monitor',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
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
  ensureState();
  try {
    const data = await githubRequest('GET');
    if (!data || !data.content) return;
    stateSha = data.sha || null;
    const state = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    for (const key of state.alerts || []) sentAlerts.add(key);

    if (state.liquidationTimeframes) {
      for (const timeframe of FRAMEWORKS) {
        const items = state.liquidationTimeframes[timeframe] || [];
        const map = timeframeState.get(timeframe);
        for (const item of items) {
          const symbol = normalizeSymbol(item.symbol);
          if (!map.has(symbol)) continue;
          map.set(symbol, {
            imbalanceUsd: Number.isFinite(Number(item.imbalanceUsd)) ? Number(item.imbalanceUsd) : 0,
            longUsd: Number.isFinite(Number(item.longUsd)) ? Number(item.longUsd) : 0,
            shortUsd: Number.isFinite(Number(item.shortUsd)) ? Number(item.shortUsd) : 0,
            longEvents: Number(item.longEvents) || 0,
            shortEvents: Number(item.shortEvents) || 0,
            events: Number(item.events) || 0,
            establishedSign: Number(item.establishedSign) || 0,
            lastBucket: item.lastBucket ? Number(item.lastBucket) : null,
          });
        }
      }
    } else {
      const old = state.liquidationRunning || [];
      const map = timeframeState.get('5m');
      for (const item of old) {
        const symbol = normalizeSymbol(item.symbol);
        if (!map.has(symbol)) continue;
        map.set(symbol, {
          ...emptySymbolState(),
          imbalanceUsd: Number(item.imbalanceUsd) || 0,
          longUsd: Number(item.longUsd) || 0,
          shortUsd: Number(item.shortUsd) || 0,
          longEvents: Number(item.longEvents) || 0,
          shortEvents: Number(item.shortEvents) || 0,
          events: Number(item.events) || 0,
          establishedSign: Number(item.establishedSign) || 0,
          lastBucket: null,
        });
      }
    }
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveState() {
  if (!process.env.GITHUB_TOKEN) return;
  const liquidationTimeframes = {};
  for (const timeframe of FRAMEWORKS) {
    liquidationTimeframes[timeframe] = symbols.map(symbol => {
      const state = timeframeState.get(timeframe).get(symbol) || emptySymbolState();
      return { symbol, ...state };
    });
  }
  const payload = {
    updatedAt: new Date().toISOString(),
    alerts: [...sentAlerts].slice(-1000),
    liquidationTimeframes,
  };
  const body = {
    message: 'Persist multi-timeframe liquidation state',
    content: Buffer.from(JSON.stringify(payload, null, 2)).toString('base64'),
    branch: process.env.GITHUB_REF_NAME || 'main',
  };
  if (stateSha) body.sha = stateSha;
  try {
    const result = await githubRequest('PUT', body);
    stateSha = result?.content?.sha || stateSha;
  } catch (error) {
    console.warn(`STATE SAVE FAILED: ${error.message}`);
  }
}

function utcBucketStart(now, timeframe) {
  const size = TIMEFRAMES[timeframe];
  return Math.floor(now / size) * size;
}

function dailyBucketStart(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date(now));
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const localNoonUtcGuess = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), 12, 0, 0);
  const offsetPart = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
    .formatToParts(new Date(localNoonUtcGuess)).find(x => x.type === 'timeZoneName')?.value || 'GMT-4';
  const match = offsetPart.match(/GMT([+-])(\d+)(?::(\d+))?/);
  const offsetMinutes = match ? (Number(match[2]) * 60 + Number(match[3] || 0)) * (match[1] === '+' ? 1 : -1) : -240;
  let start = localNoonUtcGuess - offsetMinutes * 60 * 1000;
  if (now < start) start -= TIMEFRAMES['1d'];
  return start;
}

function bucketStart(now, timeframe) {
  return timeframe === '1d' ? dailyBucketStart(now) : utcBucketStart(now, timeframe);
}

function nextBoundary(now) {
  return Math.min(...FRAMEWORKS.map(timeframe => {
    const current = bucketStart(now, timeframe);
    return current + TIMEFRAMES[timeframe];
  }));
}

function formatUtcPlus3(ms) {
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function formatUsd(value) {
  return `${value < 0 ? '-' : '+'}$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatAbsoluteUsd(value) {
  return `$${Math.abs(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function eventSideSign(event) {
  const side = String(event.side || '').toLowerCase();
  if (side.includes('long') || side === 'buy') return 1;
  if (side.includes('short') || side === 'sell') return -1;
  return 0;
}

function eventNotionalUsd(event) {
  const direct = Number(event.notional ?? event.notionalUsd ?? event.usd ?? event.volumeUsd ?? event.valueUsd);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const price = Number(event.price);
  const qty = Number(event.qty ?? event.quantity ?? event.amount ?? event.size);
  return Number.isFinite(price) && Number.isFinite(qty) && price > 0 && qty > 0 ? price * qty : 0;
}

function applyCompletedBucket(timeframe, eventsBySymbol, completedBucket) {
  const map = timeframeState.get(timeframe);
  const crossings = [];
  for (const symbol of symbols) {
    const state = map.get(symbol) || emptySymbolState();
    if (state.lastBucket !== null && completedBucket <= state.lastBucket) continue;

    let longUsd = 0;
    let shortUsd = 0;
    let longEvents = 0;
    let shortEvents = 0;
    let lastTs = null;

    for (const event of eventsBySymbol.get(symbol) || []) {
      const ts = normalizeTs(event.ts);
      if (!ts || bucketStart(ts, timeframe) !== completedBucket) continue;
      const sign = eventSideSign(event);
      const usd = eventNotionalUsd(event);
      if (!sign || usd <= 0) continue;
      if (sign > 0) { longUsd += usd; longEvents += 1; }
      else { shortUsd += usd; shortEvents += 1; }
      if (!lastTs || ts > lastTs) lastTs = ts;
    }

    const before = state.imbalanceUsd;
    const oldSign = state.establishedSign || 0;
    state.imbalanceUsd += longUsd - shortUsd;
    state.longUsd += longUsd;
    state.shortUsd += shortUsd;
    state.longEvents += longEvents;
    state.shortEvents += shortEvents;
    state.events += longEvents + shortEvents;
    state.lastBucket = completedBucket;

    const newSign = state.imbalanceUsd > 0 ? 1 : state.imbalanceUsd < 0 ? -1 : 0;
    if (oldSign !== 0 && newSign !== 0 && newSign !== oldSign) {
      crossings.push({
        timeframe,
        symbol,
        before,
        after: state.imbalanceUsd,
        updateLongUsd: longUsd,
        updateShortUsd: shortUsd,
        updateLongEvents: longEvents,
        updateShortEvents: shortEvents,
        longUsd: state.longUsd,
        shortUsd: state.shortUsd,
        longEvents: state.longEvents,
        shortEvents: state.shortEvents,
        ts: lastTs || completedBucket + TIMEFRAMES[timeframe],
        period: completedBucket,
      });
    }
    if (newSign !== 0) state.establishedSign = newSign;
    map.set(symbol, state);

    console.log(JSON.stringify({
      type: 'liquidation_timeframe_bucket',
      timeframe,
      symbol,
      bucket: new Date(completedBucket).toISOString(),
      updateLongUsd: longUsd,
      updateShortUsd: shortUsd,
      imbalanceUsd: state.imbalanceUsd,
      longUsd: state.longUsd,
      shortUsd: state.shortUsd,
      establishedSign: state.establishedSign,
    }));
  }
  return crossings;
}

async function sendCrossingAlert(crossing) {
  const alertKey = `${crossing.timeframe}:${crossing.symbol}:${crossing.period}:${crossing.after}`;
  if (sentAlerts.has(alertKey)) return;
  const nextMarket = await findMarketByEpoch(crossing.symbol, crossing.period + TIMEFRAMES[crossing.timeframe], crossing.timeframe);
  if (!nextMarket) throw new Error(`No next ${crossing.timeframe} Polymarket market for ${crossing.symbol}`);

  const emoji = crossing.after < 0 ? '🔴' : '🟢';
  const message = [
    `${emoji} LIQUIDATION IMBALANCE FLIP`,
    `${crossing.symbol} · ${crossing.timeframe.toUpperCase()} · ${formatUtcPlus3(crossing.ts)} UTC+3`, '',
    `Previous imbalance: ${formatUsd(crossing.before)}`,
    `New imbalance: ${formatUsd(crossing.after)}`,
    `Update: +${formatAbsoluteUsd(crossing.updateLongUsd)} LONG · -${formatAbsoluteUsd(crossing.updateShortUsd)} SHORT`,
    `Long total: ${formatAbsoluteUsd(crossing.longUsd)}`,
    `Short total: ${formatAbsoluteUsd(crossing.shortUsd)}`,
    `Cumulative LONG events: ${crossing.longEvents}`,
    `Cumulative SHORT events: ${crossing.shortEvents}`,
    '', `➡️ NEXT Polymarket ${crossing.timeframe.toUpperCase()}`, nextMarket.url,
  ].join('\n');
  await sendTelegramMessage(message);
  sentAlerts.add(alertKey);
}

async function fetchAllEvents() {
  const results = await Promise.all(symbols.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad live ${symbol}: ${error.message}`); return [symbol, []]; }
  }));
  return new Map(results.map(([symbol, events]) => [normalizeSymbol(symbol), events]));
}

async function processBoundary(now, previousBoundaryNow) {
  const dueTimeframes = FRAMEWORKS.filter(timeframe => bucketStart(now, timeframe) !== bucketStart(previousBoundaryNow, timeframe));
  if (!dueTimeframes.length) return;

  console.log(`TIMEFRAME BOUNDARY REACHED; MarginPad fetch once; due=${dueTimeframes.join(',')}`);
  const eventsBySymbol = await fetchAllEvents();
  const allCrossings = [];

  for (const timeframe of dueTimeframes) {
    const current = bucketStart(now, timeframe);
    const completed = current - TIMEFRAMES[timeframe];
    allCrossings.push(...applyCompletedBucket(timeframe, eventsBySymbol, completed));
  }

  for (const crossing of allCrossings.sort((a, b) => a.ts - b.ts)) {
    try { await sendCrossingAlert(crossing); }
    catch (error) { console.warn(`POLYMARKET LINK/TELEGRAM FAILED ${crossing.timeframe} ${crossing.symbol}: ${error.message}`); }
  }
  await saveState();
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

async function main() {
  await loadState();
  ensureState();
  console.log(`Multi-timeframe liquidation monitor started; symbols=${symbols.join(',')}; timeframes=${FRAMEWORKS.join(',')}; MarginPad queried only at timeframe boundaries; no periodic polling`);

  let lastBoundaryNow = Date.now();
  while (true) {
    const now = Date.now();
    const next = nextBoundary(now);
    const waitMs = Math.max(0, next - now + BOUNDARY_GRACE_MS);
    console.log(`Waiting for next timeframe boundary in ${Math.ceil(waitMs / 1000)}s`);
    await sleep(waitMs);

    const boundaryNow = Date.now();
    try {
      await processBoundary(boundaryNow, lastBoundaryNow);
      lastBoundaryNow = boundaryNow;
    } catch (error) {
      console.error(`BOUNDARY PROCESS FAILED: ${error.stack || error.message}`);
      await sleep(5000);
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
