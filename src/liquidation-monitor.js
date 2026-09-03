const FEED_URL = 'https://marginpad.io/api/v1/feed';

const DEFAULT_SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const POLL_MS = 4000;
const WINDOW_MS = 5 * 60 * 1000;

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

async function fetchFeed(fetchImpl = fetch) {
  const response = await fetchImpl(FEED_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`MarginPad feed HTTP ${response.status}`);
  const json = await response.json();
  if (!json || !Array.isArray(json.events)) throw new Error('MarginPad feed: invalid response shape');
  return json.events;
}

function selectWinner(rows, bucket) {
  return rows
    .filter((row) => row.bucket === bucket)
    .sort((a, b) => b.events - a.events || b.notionalUsd - a.notionalUsd)[0] || null;
}

module.exports = {
  FEED_URL,
  DEFAULT_SYMBOLS,
  POLL_MS,
  WINDOW_MS,
  bucketStart,
  normalizeTs,
  normalizeSymbol,
  eventKey,
  aggregateEvents,
  fetchFeed,
  selectWinner,
};
