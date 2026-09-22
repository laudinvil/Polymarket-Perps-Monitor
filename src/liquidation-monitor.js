const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';
const DEFAULT_SYMBOLS = ['ALL'];
const POLL_MS = 4000;
const FALLBACK_REFRESH_MS = 30000;
const WINDOW_MS = 5 * 60 * 1000;
const FEED_RETENTION_MS = 26 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 1200;
const RETRY_DELAYS_MS = [500];
const CONVEX_PROXY_URL = String(process.env.CONVEX_SITE_URL || 'https://brainy-canary-207.eu-west-1.convex.site').replace(/\/$/, '') + '/marginpad-btc-liquidations?limit=400';

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
function normalizeEventSymbol(event) {
  return normalizeSymbol(event?.symbol ?? event?.market ?? event?.pair ?? event?.instrument ?? event?.asset ?? event?.data?.symbol ?? event?.data?.market);
}
function normalizeSymbol(symbol) {
  return String(symbol || '')
    .toUpperCase()
    .replace(/[-_/]/g, '')
    .replace(/USDC$|USDT$|USD$/i, '');
}
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
  let lastError = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
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
      console.log(`MarginPad request ${url} -> HTTP ${response.status} attempt=${attempt + 1}/${RETRY_DELAYS_MS.length + 1}`);
      if (response.ok) return await response.json();
      lastError = new Error(`MarginPad HTTP ${response.status}`);
      if (response.status !== 503 || attempt === RETRY_DELAYS_MS.length) throw lastError;
    } catch (error) {
      lastError = error?.name === 'AbortError'
        ? new Error(`MarginPad request timeout after ${timeoutMs}ms: ${url}`)
        : error;
      const retryable = lastError.message.includes('timeout') || lastError.message.includes('HTTP 503');
      if (!retryable || attempt === RETRY_DELAYS_MS.length) throw lastError;
    } finally {
      clearTimeout(timeout);
    }
    const delay = RETRY_DELAYS_MS[attempt];
    console.warn(`MarginPad transient failure; retrying in ${delay}ms: ${url}`);
    await new Promise(resolve => setTimeout(resolve, delay));
  }
  throw lastError || new Error(`MarginPad request failed: ${url}`);
}
async function fetchConvexProxy(fetchImpl = fetch) {
  const json = await fetchJson(CONVEX_PROXY_URL, fetchImpl, 2000);
  console.log('MarginPad CONVEX RAW:', JSON.stringify(json).slice(0, 12000));
  const events = extractEvents(json).filter(event => normalizeEventSymbol(event) === 'BTC');
  console.log(
    'MarginPad CONVEX PROXY: source=' + JSON.stringify(json?.source) +
    ' feed=' + JSON.stringify(json?.feedEvents) +
    ' live=' + JSON.stringify(json?.liveEvents) +
    ' events=' + events.length
  );
  return events;
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
  const json = await fetchJson(`${LIVE_URL}?symbol=${encodeURIComponent(normalized)}&limit=400`, fetchImpl, REQUEST_TIMEOUT_MS);
  return extractEvents(json).filter(event => normalizeEventSymbol(event) === normalized);
}
function mergeUniqueEvents(primary, secondary) {
  const merged = new Map();
  for (const event of [...(primary || []), ...(secondary || [])]) merged.set(eventKey(event), event);
  return [...merged.values()];
}
async function fetchSymbolFeed(symbol, fetchImpl = fetch) {
  const normalized = normalizeSymbol(symbol);
  const now = Date.now();
  const cached = fallbackCache.eventsBySymbol.get(normalized);

  const [feedResult, liveResult] = await Promise.allSettled([
    fetchLiveFeed(fetchImpl),
    fetchLiveSymbolFallback(normalized, fetchImpl)
  ]);

  let feedEvents = [];
  let liveEvents = [];

  if (feedResult.status === 'fulfilled') {
    feedEvents = feedResult.value.filter(event => normalizeEventSymbol(event) === normalized);
    console.log('MarginPad FEED RAW BTC:', JSON.stringify(feedEvents).slice(0, 12000));
    console.log(`MarginPad FEED ${normalized}: events=${feedEvents.length}`);
  } else {
    console.warn(`MarginPad feed ${normalized} failed: ${feedResult.reason?.message || feedResult.reason}`);
  }

  if (liveResult.status === 'fulfilled') {
    liveEvents = liveResult.value;
    console.log('MarginPad LIVE RAW BTC:', JSON.stringify(liveEvents).slice(0, 12000));
    console.log(`MarginPad LIVE FALLBACK ${normalized}: events=${liveEvents.length}`);
  } else {
    console.warn(`MarginPad live fallback ${normalized} failed: ${liveResult.reason?.message || liveResult.reason}`);
  }

  const events = mergeUniqueEvents(feedEvents, liveEvents);
  if (events.length) {
    fallbackCache.eventsBySymbol.set(normalized, { fetchedAt: now, events });
    return events;
  }

  if (cached && now - cached.fetchedAt < FALLBACK_REFRESH_MS) return cached.events;
  return [];
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
module.exports = { FEED_URL, fetchLiveFeed, LIVE_URL, DEFAULT_SYMBOLS, POLL_MS, REQUEST_TIMEOUT_MS, RETRY_DELAYS_MS, FALLBACK_REFRESH_MS, WINDOW_MS, FEED_RETENTION_MS, bucketStart, normalizeTs, normalizeSymbol, normalizeEventSymbol, eventKey, extractEvents, fetchFeed, fetchSymbolFeed, fetchLiveSymbolFallback, aggregateEvents, selectWinner, liquidationDirection, isLong };