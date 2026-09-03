const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';

const DEFAULT_SYMBOLS = ['BTC'];
const POLL_MS = 4000;
const FALLBACK_REFRESH_MS = 15000;
const WINDOW_MS = 5 * 60 * 1000;

let fallbackCache = { fetchedAt: 0, eventsBySymbol: new Map() };

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

async function fetchFeed(symbols = DEFAULT_SYMBOLS, fetchImpl = fetch, now = Date.now()) {
  const json = await fetchJson(FEED_URL, fetchImpl);
  const feedEvents = extractEvents(json);
  if (!feedEvents) throw new Error('MarginPad feed: invalid response shape');

  const allowed = new Set(symbols.map(normalizeSymbol));
  const closedBucket = bucketStart(now) - WINDOW_MS;

  const coveredInClosedBucket = new Set(
    feedEvents
      .map((event) => {
        const symbol = normalizeSymbol(event.symbol);
        const ts = normalizeTs(event.ts);
        return ts && allowed.has(symbol) && bucketStart(ts) === closedBucket ? symbol : null;
      })
      .filter(Boolean),
  );

  const missingSymbols = symbols.filter((symbol) => !coveredInClosedBucket.has(normalizeSymbol(symbol)));

  if (missingSymbols.length > 0) {
    const fresh = Date.now();
    if (fresh - fallbackCache.fetchedAt >= FALLBACK_REFRESH_MS) {
      const results = await Promise.all(
        missingSymbols.map(async (symbol) => {
          try {
            return [symbol, await fetchSymbolFeed(symbol, fetchImpl)];
          } catch (error) {
            console.warn(`MarginPad live fallback ${symbol}: ${error.message}`);
            return [symbol, []];
          }
        }),
      );

      const eventsBySymbol = new Map(fallbackCache.eventsBySymbol);
      for (const [symbol, events] of results) {
        eventsBySymbol.set(normalizeSymbol(symbol), events);
      }
      fallbackCache = { fetchedAt: fresh, eventsBySymbol };
    }
  }

  const fallbackEvents = missingSymbols.flatMap(
    (symbol) => fallbackCache.eventsBySymbol.get(normalizeSymbol(symbol)) || [],
  );

  const unique = new Map();
  for (const event of [...feedEvents, ...fallbackEvents]) {
    unique.set(eventKey(event), event);
  }
  return [...unique.values()];
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
