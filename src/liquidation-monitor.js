const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';
const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const POLL_MS = 4000;
const FALLBACK_REFRESH_MS = 30000;
const WINDOW_MS = 5 * 60 * 1000;
const FEED_RETENTION_MS = 26 * 60 * 60 * 1000;

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
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`MarginPad HTTP ${response.status}`);
  return response.json();
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
  try {
    feedEvents = (await fetchLiveFeed(fetchImpl)).filter(event => normalizeSymbol(event.symbol) === normalized);
  } catch (error) {
    console.warn(`MarginPad feed ${normalized} failed: ${error.message}`);
  }

  const now = Date.now();
  const cached = fallbackCache.eventsBySymbol.get(normalized);
  if (cached && now - cached.fetchedAt < FALLBACK_REFRESH_MS) return mergeUniqueEvents(feedEvents, cached.events);

  try {
    const fresh = await fetchLiveSymbolFallback(normalized, fetchImpl);
    fallbackCache.eventsBySymbol.set(normalized, { fetchedAt: Date.now(), events: fresh });
    return mergeUniqueEvents(feedEvents, fresh);
  } catch (error) {
    console.warn(`MarginPad live fallback ${normalized} failed: ${error.message}`);
    return mergeUniqueEvents(feedEvents, cached?.events || []);
  }
}
async function fetchFeed(symbols = DEFAULT_SYMBOLS, fetchImpl = fetch) {
  const results = await Promise.all(symbols.map(async symbol => [normalizeSymbol(symbol), await fetchSymbolFeed(symbol, fetchImpl)]));
  return results.flatMap(([, events]) => events);
}

function isLong(event) {
  const side = String(event?.side || event?.direction || '').toLowerCase();
  return side.includes('long') || side === 'buy';
}

function aggregateEvents(events, symbols = DEFAULT_SYMBOLS, now = Date.now()) {
  const allowed = new Set(symbols.map(normalizeSymbol));
  const current = bucketStart(now);
  const rows = new Map();
  for (const event of events || []) {
    const ts = normalizeTs(event.ts);
    const symbol = normalizeSymbol(event.symbol);
    if (!ts || !allowed.has(symbol) || !isLong(event)) continue;
    const bucket = bucketStart(ts);
    if (bucket >= current) continue;
    const key = `${bucket}:${symbol}`;
    if (!rows.has(key)) rows.set(key, { bucket, symbol, longEvents: 0 });
    rows.get(key).longEvents += 1;
  }
  return [...rows.values()].sort((a, b) => b.bucket - a.bucket || b.longEvents - a.longEvents || a.symbol.localeCompare(b.symbol));
}

function selectWinner(rows, bucket) {
  const candidates = rows.filter(row => row.bucket === bucket);
  if (!candidates.length) return null;
  const max = Math.max(...candidates.map(row => row.longEvents));
  const winners = candidates.filter(row => row.longEvents === max);
  if (winners.length !== 1) return null;
  return winners[0];
}

module.exports = {
  FEED_URL,
  LIVE_URL,
  DEFAULT_SYMBOLS,
  POLL_MS,
  FALLBACK_REFRESH_MS,
  WINDOW_MS,
  FEED_RETENTION_MS,
  bucketStart,
  normalizeTs,
  normalizeSymbol,
  eventKey,
  extractEvents,
  fetchFeed,
  fetchSymbolFeed,
  aggregateEvents,
  selectWinner,
  isLong
};
