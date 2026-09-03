const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';

const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const POLL_MS = 4000;
const FALLBACK_REFRESH_MS = 15000;
const WINDOW_MS = 5 * 60 * 1000;

let fallbackCache = { fetchedAt: 0, events: [] };

function bucketStart(ts) {
  const ms = Number(ts);
  return Math.floor(ms / WINDOW_MS) * WINDOW_MS;
}

function normalizeTs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').toUpperCase().replace(/USDT$|USD$/i, '');
}

function eventKey(event) {
  return [event.ts, event.exchange, event.symbol, event.side, event.price, event.qty, event.notional].join('|');
}

function extractEvents(json) {
  if (json && Array.isArray(json.events)) return json.events;
  if (json && json.data && Array.isArray(json.data.events)) return json.data.events;
  if (json && Array.isArray(json.data)) return json.data;
  return null;
}

async function fetchJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`MarginPad feed HTTP ${response.status}`);
  return response.json();
}

async function fetchSymbolFeed(symbol, fetchImpl = fetch) {
  const url = `${LIVE_URL}?symbol=${encodeURIComponent(symbol)}&limit=400`;
  const json = await fetchJson(url, fetchImpl);
  const events = extractEvents(json);
  if (!events) throw new Error(`MarginPad live feed: invalid response shape for ${symbol}`);
  return events;
}

async function fetchFeed(symbols = DEFAULT_SYMBOLS, fetchImpl = fetch) {
  const json = await fetchJson(FEED_URL, fetchImpl);
  const feedEvents = extractEvents(json);
  if (!feedEvents) throw new Error('MarginPad feed: invalid response shape');

  const allowed = new Set(symbols.map(normalizeSymbol));
  const present = new Set(
    feedEvents
      .map((event) => normalizeSymbol(event.symbol))
      .filter((symbol) => allowed.has(symbol)),
  );
  const missingSymbols = symbols.filter((symbol) => !present.has(normalizeSymbol(symbol)));

  // /feed is the cheap market-wide source, but it can be incomplete: in practice
  // it may contain only a subset of monitored symbols. Fill only the missing
  // symbols from the per-symbol live endpoint so one partial /feed payload cannot
  // suppress ETH/SOL/XRP/DOGE/HYPE while still retaining the cheap primary feed.
  if (missingSymbols.length === 0 || feedEvents.length === 0) return feedEvents;

  const now = Date.now();
  if (now - fallbackCache.fetchedAt < FALLBACK_REFRESH_MS) {
    return [...feedEvents, ...fallbackCache.events];
  }

  const results = await Promise.all(
    missingSymbols.map(async (symbol) => {
      try {
        return await fetchSymbolFeed(symbol, fetchImpl);
      } catch (error) {
        console.warn(`MarginPad live fallback ${symbol}: ${error.message}`);
        return [];
      }
    }),
  );

  fallbackCache = {
    fetchedAt: now,
    events: results.flat(),
  };

  return [...feedEvents, ...fallbackCache.events];
}

function aggregateEvents(events, symbols = DEFAULT_SYMBOLS, now = Date.now()) {
  const allowed = new Set(symbols.map(normalizeSymbol));
  const currentBucket = bucketStart(now);
  const rows = new Map();

  for (const event of events || []) {
    const ts = normalizeTs(event.ts);
    const symbol = normalizeSymbol(event.symbol);
    if (!ts || !allowed.has(symbol)) continue;

    const bucket = bucketStart(ts);
    if (bucket >= currentBucket) continue;

    const key = `${bucket}:${symbol}`;
    if (!rows.has(key)) {
      rows.set(key, {
        bucket,
        symbol,
        events: 0,
        longEvents: 0,
        shortEvents: 0,
        notionalUsd: 0,
        longNotionalUsd: 0,
        shortNotionalUsd: 0,
      });
    }

    const row = rows.get(key);
    const notional = Number(event.notional) || 0;
    row.events += 1;
    row.notionalUsd += notional;

    const side = String(event.side || '').toLowerCase();
    if (side.includes('long') || side === 'buy') {
      row.longEvents += 1;
      row.longNotionalUsd += notional;
    } else if (side.includes('short') || side === 'sell') {
      row.shortEvents += 1;
      row.shortNotionalUsd += notional;
    }
  }

  return [...rows.values()].sort((a, b) => b.events - a.events || b.notionalUsd - a.notionalUsd);
}

function selectWinner(rows, bucket) {
  return rows
    .filter((row) => row.bucket === bucket)
    .sort((a, b) => b.notionalUsd - a.notionalUsd || b.events - a.events)[0] || null;
}

module.exports = {
  FEED_URL,
  LIVE_URL,
  DEFAULT_SYMBOLS,
  POLL_MS,
  FALLBACK_REFRESH_MS,
  WINDOW_MS,
  bucketStart,
  normalizeTs,
  normalizeSymbol,
  eventKey,
  extractEvents,
  fetchFeed,
  fetchSymbolFeed,
  aggregateEvents,
  selectWinner,
};
