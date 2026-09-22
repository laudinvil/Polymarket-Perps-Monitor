const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';
const DEFAULT_SYMBOLS = ['ALL'];
const POLL_MS = 1000;
const FALLBACK_REFRESH_MS = 30000;
const WINDOW_MS = 5 * 60 * 1000;
const FEED_RETENTION_MS = 26 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 5000;

let fallbackCache = { eventsBySymbol: new Map() };
let liveFeedCache = { fetchedAt: 0, events: new Map() };
let liveFeedPromise = null;

function bucketStart(ts) { return Math.floor(Number(ts) / WINDOW_MS) * WINDOW_MS; }
function normalizeTs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) {
    if (n < 1e11) return n * 1000;
    if (n < 1e14) return n;
    if (n < 1e17) return n / 1000;
    return n / 1000000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function normalizeSymbol(symbol) { return String(symbol || '').toUpperCase().replace(/USDT$|USD$/i, ''); }
function eventKey(event) { return [event.ts, event.exchange, event.symbol, event.side, event.price, event.qty, event.notional].join('|'); }
function extractEvents(json) {
  if (Array.isArray(json)) return json;
  if (json && Array.isArray(json.events)) return json.events;
  if (json && Array.isArray(json.liquidations)) return json.liquidations;
  if (json && Array.isArray(json.results)) return json.results;
  if (json && json.data && Array.isArray(json.data.events)) return json.data.events;
  if (json && json.data && Array.isArray(json.data.liquidations)) return json.data.liquidations;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}
async function fetchJson(url, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'Polymarket-Perps-Monitor/1.0',
        'cache-control': 'no-cache'
      },
      signal: controller.signal
    });
    console.log(`MarginPad request ${url} -> HTTP ${response.status}`);
    if (!response.ok) throw new Error(`MarginPad HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    throw error?.name === 'AbortError'
      ? new Error(`MarginPad request timeout after ${timeoutMs}ms: ${url}`)
      : error;
  } finally {
    clearTimeout(timeout);
  }
}
async function fetchLiveFeed(fetchImpl = fetch) {
  const now = Date.now();
  if (liveFeedPromise) return liveFeedPromise;
  if (now - liveFeedCache.fetchedAt < POLL_MS) return [...liveFeedCache.events.values()];
  liveFeedPromise = (async () => {
    const events = extractEvents(await fetchJson(FEED_URL, fetchImpl));
    const merged = new Map(liveFeedCache.events);
    for (const event of events) merged.set(eventKey(event), event);
    const cutoff = Date.now() - FEED_RETENTION_MS;
    for (const [key, event] of merged) {
      const ts = normalizeTs(event.ts);
      if (!ts || ts < cutoff) merged.delete(key);
    }
    liveFeedCache = { fetchedAt: Date.now(), events: merged };
    return [...merged.values()];
  })();
  try { return await liveFeedPromise; } finally { liveFeedPromise = null; }
}
async function fetchLiveSymbolFallback(symbol, fetchImpl = fetch) {
  const normalized = normalizeSymbol(symbol);
  const json = await fetchJson(`${LIVE_URL}?symbol=${encodeURIComponent(normalized)}&limit=400`, fetchImpl, 5000);
  return extractEvents(json).filter(event => normalizeSymbol(event.symbol) === normalized);
}
function mergeUniqueEvents(primary, secondary) {
  const merged = new Map();
  for (const event of [...(primary || []), ...(secondary || [])]) merged.set(eventKey(event), event);
  return [...merged.values()];
}
async function fetchSymbolFeed(symbol, fetchImpl = fetch) {
  const normalized = normalizeSymbol(symbol);

  // MarginPad /feed has repeatedly timed out on the GitHub runner. Treat the
  // symbol-scoped live endpoint as a first-class source instead of a fallback.
  // Query both sources concurrently so a broken /feed cannot delay liquidation
  // detection or prevent the live endpoint from being used.
  const [liveResult, feedResult] = await Promise.allSettled([
    fetchLiveSymbolFallback(normalized, fetchImpl),
    fetchLiveFeed(fetchImpl)
  ]);

  let liveEvents = [];
  let feedEvents = [];

  if (liveResult.status === 'fulfilled') {
    liveEvents = liveResult.value || [];
    fallbackCache.eventsBySymbol.set(normalized, { fetchedAt: Date.now(), events: liveEvents });
    console.log(`MarginPad LIVE PRIMARY ${normalized}: events=${liveEvents.length}`);
  } else {
    console.warn(`MarginPad live primary ${normalized} failed: ${liveResult.reason?.message || liveResult.reason}`);
    const cached = fallbackCache.eventsBySymbol.get(normalized);
    liveEvents = cached?.events || [];
  }

  if (feedResult.status === 'fulfilled') {
    feedEvents = (feedResult.value || []).filter(event => {
      const eventSymbol = normalizeSymbol(event?.symbol);
      return !eventSymbol || eventSymbol === normalized;
    });
    console.log(`MarginPad FEED SECONDARY ${normalized}: events=${feedEvents.length}`);
  } else {
    console.warn(`MarginPad feed secondary ${normalized} failed: ${feedResult.reason?.message || feedResult.reason}`);
  }

  const merged = mergeUniqueEvents(feedEvents, liveEvents);
  if (!merged.length) {
    console.warn(`MarginPad ${normalized}: live + feed returned no events`);
  }
  return merged;
}
async function fetchFeed(symbols = DEFAULT_SYMBOLS, fetchImpl = fetch) {
  const requested = Array.isArray(symbols) ? symbols.map(normalizeSymbol) : [];
  if (requested.includes('ALL') || requested.length === 0) return fetchLiveFeed(fetchImpl);
  const results = await Promise.all(symbols.map(async symbol => [normalizeSymbol(symbol), await fetchSymbolFeed(symbol, fetchImpl)]));
  return results.flatMap(([, events]) => events);
}
function liquidationDirection(event) {
  const side = String(event?.side || event?.direction || '').toLowerCase();
  if (side.includes('long') || side === 'buy') return 'LONG';
  if (side.includes('short') || side === 'sell') return 'SHORT';
  return null;
}
function isLong(event) { return liquidationDirection(event) === 'LONG'; }
function aggregateEvents(events, symbols = DEFAULT_SYMBOLS, now = Date.now()) {
  const requested = Array.isArray(symbols) ? symbols.map(normalizeSymbol) : [];
  const global = requested.includes('ALL') || requested.length === 0;
  const allowed = new Set(requested);
  const current = bucketStart(now);
  const rows = new Map();
  for (const event of events || []) {
    const ts = normalizeTs(event.ts);
    const symbol = normalizeSymbol(event.symbol);
    const direction = liquidationDirection(event);
    if (!ts || (!global && !allowed.has(symbol)) || !direction) continue;
    const bucket = bucketStart(ts);
    if (bucket >= current) continue;
    const key = `${bucket}:${symbol}`;
    if (!rows.has(key)) rows.set(key, { bucket, symbol, longEvents: 0, shortEvents: 0, events: 0 });
    const row = rows.get(key);
    row.events += 1;
    if (direction === 'LONG') row.longEvents += 1;
    else row.shortEvents += 1;
  }
  return [...rows.values()].sort((a, b) => b.bucket - a.bucket || b.events - a.events || a.symbol.localeCompare(b.symbol));
}
function selectWinner(rows, bucket) {
  const candidates = rows.filter(row => row.bucket === bucket);
  if (!candidates.length) return null;
  const max = Math.max(...candidates.map(row => row.events));
  const winners = candidates.filter(row => row.events === max);
  if (winners.length !== 1) return null;
  return winners[0];
}
module.exports = { FEED_URL, fetchLiveFeed, LIVE_URL, DEFAULT_SYMBOLS, POLL_MS, REQUEST_TIMEOUT_MS, FALLBACK_REFRESH_MS, WINDOW_MS, FEED_RETENTION_MS, bucketStart, normalizeTs, normalizeSymbol, eventKey, extractEvents, fetchFeed, fetchSymbolFeed, fetchLiveSymbolFallback, aggregateEvents, selectWinner, liquidationDirection, isLong };
