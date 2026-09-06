const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';
const HISTORICAL_URL = 'https://marginpad.io/api/v1/liquidations/recent';

const DEFAULT_SYMBOLS = ['BTC'];
const POLL_MS = 4000;
const FALLBACK_REFRESH_MS = 15000;
const WINDOW_MS = 5 * 60 * 1000;
const FEED_RETENTION_MS = 26 * 60 * 60 * 1000;

let fallbackCache = { fetchedAt: 0, eventsBySymbol: new Map() };
let liveFeedCache = { fetchedAt: 0, events: new Map() };
let liveFeedPromise = null;

function bucketStart(ts) { const ms = Number(ts); return Math.floor(ms / WINDOW_MS) * WINDOW_MS; }
function normalizeTs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    const ts = value.getTime();
    return Number.isFinite(ts) && ts > 0 ? ts : null;
  }
  if (Array.isArray(value)) return normalizeTs(value[0]);
  if (typeof value === 'object') {
    for (const key of ['$date', 'date', 'timestamp', 'ts', 'time', 'value', 'start', 'startTime', 'epoch']) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        const ts = normalizeTs(value[key]);
        if (ts) return ts;
      }
    }
    return null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) return normalizeTs(numeric);
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) return n * 1000;
  if (n < 1e14) return n;
  if (n < 1e17) return n / 1000;
  return n / 1000000;
}
function normalizeSymbol(symbol) { return String(symbol || '').toUpperCase().replace(/USDT$|USD$/i, ''); }
function eventKey(event) { return [event.ts, event.exchange, event.symbol, event.side, event.price, event.qty, event.notional].join('|'); }
function extractEvents(json) { if (json && Array.isArray(json.events)) return json.events; if (json && json.data && Array.isArray(json.data.events)) return json.data.events; if (json && Array.isArray(json.data)) return json.data; return null; }
async function fetchJson(url, fetchImpl = fetch) { const response = await fetchImpl(url, { headers: { accept: 'application/json' } }); if (!response.ok) throw new Error(`MarginPad feed HTTP ${response.status}`); return response.json(); }

// MarginPad /liquidations/recent is a histogram, not a raw event feed.
// Prefer the documented bucket containers in a deterministic order; do not
// choose an unrelated array merely because it happens to be longer.
function historicalRows(json) {
  const roots = [json?.data, json];
  const keys = ['buckets', 'histogram', 'rows', 'series', 'bars', 'points', 'items'];
  for (const root of roots) {
    if (!root) continue;
    if (Array.isArray(root)) return root;
    for (const key of keys) if (Array.isArray(root?.[key])) return root[key];
    if (Array.isArray(root?.data)) return root.data;
  }
  return [];
}
function numericField(row, names) {
  for (const name of names) {
    const raw = row?.[name];
    if (raw === null || raw === undefined || raw === '') continue;
    if (typeof raw === 'object') {
      for (const nested of ['usd', 'value', 'notional', 'amount', 'total']) {
        const value = Number(raw?.[nested]);
        if (Number.isFinite(value)) return value;
      }
      continue;
    }
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}
function normalizeHistoricalRow(row) {
  if (Array.isArray(row)) {
    return { ts: row[0], longUsd: numericField(row, [1]), shortUsd: numericField(row, [2]), ...row };
  }
  return {
    ...row,
    ts: row?.ts ?? row?.timestamp ?? row?.time ?? row?.t ?? row?.bucket ?? row?.start ?? row?.startTime,
    longUsd: numericField(row, ['longUsd', 'long_usd', 'long_liq_usd', 'longLiqUsd', 'longLiquidationUsd', 'longLiquidations', 'longs', 'long', 'long_liquidations', 'long_liquidated', 'long_liq']),
    shortUsd: numericField(row, ['shortUsd', 'short_usd', 'short_liq_usd', 'shortLiqUsd', 'shortLiquidationUsd', 'shortLiquidations', 'shorts', 'short', 'short_liquidations', 'short_liquidated', 'short_liq'])
  };
}
function normalizeHistoricalJson(json) {
  const rows = historicalRows(json);
  if (!rows.length) return json;
  const normalized = rows.map(normalizeHistoricalRow);
  return { ...json, data: { ...(json?.data && !Array.isArray(json.data) ? json.data : {}), buckets: normalized } };
}

function installHistoricalFetchNormalizer() {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function' || originalFetch.__marginpadHistoricalNormalizer) return;
  const wrappedFetch = async (...args) => {
    const response = await originalFetch(...args);
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (!requestUrl || !requestUrl.includes(HISTORICAL_URL) || !response.ok) return response;
    try {
      const json = await response.clone().json();
      const normalized = normalizeHistoricalJson(json);
      return new Response(JSON.stringify(normalized), { status: response.status, statusText: response.statusText, headers: { 'content-type': 'application/json' } });
    } catch { return response; }
  };
  wrappedFetch.__marginpadHistoricalNormalizer = true;
  globalThis.fetch = wrappedFetch;
}
installHistoricalFetchNormalizer();

async function fetchLiveFeed(fetchImpl = fetch) {
  const now = Date.now();
  if (liveFeedPromise) return liveFeedPromise;
  if (now - liveFeedCache.fetchedAt < 3000) return [...liveFeedCache.events.values()];
  liveFeedPromise = (async () => {
    const json = await fetchJson(FEED_URL, fetchImpl);
    const events = extractEvents(json);
    if (!events) throw new Error('MarginPad live feed: invalid response shape');
    const merged = new Map(liveFeedCache.events);
    for (const event of events) merged.set(eventKey(event), event);
    const cutoff = Date.now() - FEED_RETENTION_MS;
    for (const [key, event] of merged) { const ts = normalizeTs(event.ts); if (!ts || ts < cutoff) merged.delete(key); }
    liveFeedCache = { fetchedAt: Date.now(), events: merged };
    return [...merged.values()];
  })();
  try { return await liveFeedPromise; } finally { liveFeedPromise = null; }
}
async function fetchSymbolFeed(symbol, fetchImpl = fetch) { const normalized = normalizeSymbol(symbol); const events = await fetchLiveFeed(fetchImpl); return events.filter(event => normalizeSymbol(event.symbol) === normalized); }
async function fetchFeed(symbols = DEFAULT_SYMBOLS, fetchImpl = fetch, now = Date.now()) {
  const feedEvents = await fetchLiveFeed(fetchImpl);
  const allowed = new Set(symbols.map(normalizeSymbol));
  const closedBucket = bucketStart(now) - WINDOW_MS;
  const covered = new Set(feedEvents.map(e => { const s = normalizeSymbol(e.symbol), t = normalizeTs(e.ts); return t && allowed.has(s) && bucketStart(t) === closedBucket ? s : null; }).filter(Boolean));
  const missing = symbols.filter(s => !covered.has(normalizeSymbol(s)));
  if (missing.length) {
    const fresh = Date.now();
    if (fresh - fallbackCache.fetchedAt >= FALLBACK_REFRESH_MS) {
      const results = await Promise.all(missing.map(async s => { try { return [s, await fetchSymbolFeed(s, fetchImpl)]; } catch (error) { console.warn(`MarginPad live fallback ${s}: ${error.message}`); return [s, []]; } }));
      const map = new Map(fallbackCache.eventsBySymbol); for (const [s, e] of results) map.set(normalizeSymbol(s), e); fallbackCache = { fetchedAt: fresh, eventsBySymbol: map };
    }
  }
  const fallback = missing.flatMap(s => fallbackCache.eventsBySymbol.get(normalizeSymbol(s)) || []);
  const unique = new Map(); for (const e of [...feedEvents, ...fallback]) unique.set(eventKey(e), e); return [...unique.values()];
}
function aggregateEvents(events, symbols=DEFAULT_SYMBOLS, now=Date.now()) { const allowed=new Set(symbols.map(normalizeSymbol)); const current=bucketStart(now); const rows=new Map(); for(const event of events||[]){const ts=normalizeTs(event.ts),symbol=normalizeSymbol(event.symbol);if(!ts||!allowed.has(symbol))continue;const bucket=bucketStart(ts);if(bucket>=current)continue;const key=`${bucket}:${symbol}`;if(!rows.has(key))rows.set(key,{bucket,symbol,events:0,longEvents:0,shortEvents:0});const row=rows.get(key);const side=String(event.side||'').toLowerCase();if(!(side.includes('long')||side.includes('short')||side==='buy'||side==='sell'))continue;row.events+=1;if(side.includes('long')||side==='buy')row.longEvents+=1;else row.shortEvents+=1;}return [...rows.values()].sort((a,b)=>b.events-a.events); }
function selectWinner(rows,bucket){return rows.filter(row=>row.bucket===bucket).sort((a,b)=>b.events-a.events)[0]||null;}
module.exports={FEED_URL,LIVE_URL,HISTORICAL_URL,DEFAULT_SYMBOLS,POLL_MS,FALLBACK_REFRESH_MS,WINDOW_MS,FEED_RETENTION_MS,bucketStart,normalizeTs,normalizeSymbol,eventKey,extractEvents,fetchFeed,fetchSymbolFeed,aggregateEvents,selectWinner};