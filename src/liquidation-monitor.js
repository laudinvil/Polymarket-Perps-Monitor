const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';
const DEFAULT_SYMBOLS = ['ALL'];
const POLL_MS = 4000;
const FALLBACK_REFRESH_MS = 30000;
const WINDOW_MS = 5 * 60 * 1000;
const FEED_RETENTION_MS = 26 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;

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
  if (json && Array.isArray(json.events)) return json.events;
  if (json && json.data && Array.isArray(json.data.events)) return json.data.events;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}
async function fetchJson(url, fetchImpl = fetch) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response;
      try {
        response = await fetchImpl(url, {
          headers: {
            accept: 'application/json',
            'user-agent': 'Polymarket-Perps-Monitor/1.0',
            'cache-control': 'no-cache'
          },
          signal: controller.signal
        });
      } finally {
        clearTimeout(timeout);
      }
      console.log(`MarginPad request ${url} -> HTTP ${response.status}`);
      if (response.ok) return response.json();
      if (![429, 502, 503, 504].includes(response.status)) {
        throw new Error(`MarginPad HTTP ${response.status}`);
      }
      const retryAfter = Number(response.headers?.get?.('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 10000)
        : Math.min(1000 * (2 ** attempt), 8000);
      lastError = new Error(`MarginPad HTTP ${response.status}`);
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, delay));
    } catch (error) {
      lastError = error?.name === 'AbortError' ? new Error(`MarginPad request timeout after ${REQUEST_TIMEOUT_MS}ms: ${url}`) : error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, Math.min(1000 * (2 ** attempt), 8000)));
    }
  }
  throw lastError || new Error('MarginPad request failed');
}
async function fetchLiveFeed(fetchImpl = fetch) {
  const now = Date.now();
  if (liveFeedPromise) return liveFeedPromise;
  if (now - liveFeedCache.fetchedAt < 3000) return [...liveFeedCache.events.values()];
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
  const json = await fetchJson(`${LIVE_URL}?symbol=${encodeURIComponent(normalized)}&limit=400`, fetchImpl);
  return extractEvents(json).filter(event => normalizeSymbol(event.symbol) === normalized);
}
function mergeUniqueEvents(primary, secondary) {
  const merged = new Map();
  for (const event of [...(primary || []), ...(secondary || [])]) merged.set(eventKey(event), event);
  return [...merged.values()];
}
async function fetchSymbolFeed(symbol, fetchImpl = fetch) {
  const normalized = normalizeSymbol(symbol);
  let feedEvents = [];
  let feedSucceeded = false;
  try {
    feedEvents = (await fetchLiveFeed(fetchImpl)).filter(event => normalizeSymbol(event.symbol) === normalized);
    feedSucceeded = true;
  } catch (error) {
    console.warn(`MarginPad feed ${normalized} failed: ${error.message}`);
    feedEvents = [...liveFeedCache.events.values()].filter(event => normalizeSymbol(event.symbol) === normalized);
  }

  let liveEvents = [];
  try {
    liveEvents = await fetchLiveSymbolFallback(normalized, fetchImpl);
    fallbackCache.eventsBySymbol.set(normalized, { fetchedAt: Date.now(), events: liveEvents });
  } catch (error) {
    console.warn(`MarginPad live fallback ${normalized} failed: ${error.message}`);
    const cached = fallbackCache.eventsBySymbol.get(normalized);
    liveEvents = cached?.events || [];
  }

  if (!feedSucceeded && !liveEvents.length && !feedEvents.length) {
    console.warn(`MarginPad ${normalized}: both API sources unavailable and no cached events`);
  }
  return mergeUniqueEvents(feedEvents, liveEvents);
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
module.exports = { FEED_URL, LIVE_URL, DEFAULT_SYMBOLS, POLL_MS, REQUEST_TIMEOUT_MS, FALLBACK_REFRESH_MS, WINDOW_MS, FEED_RETENTION_MS, bucketStart, normalizeTs, normalizeSymbol, eventKey, extractEvents, fetchFeed, fetchSymbolFeed, fetchLiveSymbolFallback, aggregateEvents, selectWinner, liquidationDirection, isLong };
