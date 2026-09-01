const PINAX_API_KEY = process.env.PINAX_API_KEY || process.env.PINAX_API_TOKEN;
const PINAX_OHLC_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations/ohlc';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;

function windowStart(ms, size) { return Math.floor(ms / size) * size; }

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function fetchOhlc(coin, startMs, endMs) {
  const url = new URL(PINAX_OHLC_URL);
  url.searchParams.set('coin', coin);
  url.searchParams.set('dex', 'perps');
  url.searchParams.set('interval', '5m');
  url.searchParams.set('start_time', String(Math.floor(startMs / 1000)));
  url.searchParams.set('end_time', String(Math.floor(endMs / 1000)));
  url.searchParams.set('limit', '20');

  console.log(`[OHLC][REQUEST] ${coin} interval=5m target=${new Date(startMs).toISOString()}..${new Date(endMs).toISOString()}`);
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${PINAX_API_KEY}`,
      Accept: 'application/json'
    }
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${coin}: Pinax OHLC HTTP ${response.status}: ${raw.slice(0, 500)}`);

  let body;
  try { body = JSON.parse(raw); } catch { throw new Error(`${coin}: Pinax OHLC returned non-JSON: ${raw.slice(0, 300)}`); }
  const rows = Array.isArray(body?.data) ? body.data : [];
  console.log(`[OHLC][RESPONSE] ${coin} rows=${rows.length} sampleKeys=${rows[0] ? Object.keys(rows[0]).join(',') : 'none'}`);
  return rows;
}

function rowTimestampMs(row) {
  const value = row?.timestamp ?? row?.time ?? row?.start_time;
  if (value === undefined || value === null) return NaN;
  const n = Number(value);
  if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : NaN;
}

function summarize(rows, startMs, endMs) {
  const matched = rows
    .filter(row => {
      const ts = rowTimestampMs(row);
      return Number.isFinite(ts) && ts >= startMs && ts < endMs;
    })
    .sort((a, b) => rowTimestampMs(a) - rowTimestampMs(b));

  if (!matched.length) return null;

  const first = matched[0];
  const last = matched[matched.length - 1];
  return {
    candles: matched.length,
    open: first.open,
    high: matched.reduce((v, r) => Math.max(v, num(r.high)), -Infinity),
    low: matched.reduce((v, r) => Math.min(v, num(r.low)), Infinity),
    close: last.close,
    mark_price_open: first.mark_price_open,
    mark_price_high: matched.reduce((v, r) => Math.max(v, num(r.mark_price_high)), -Infinity),
    mark_price_low: matched.reduce((v, r) => Math.min(v, num(r.mark_price_low)), Infinity),
    mark_price_close: last.mark_price_close,
    buy_volume: matched.reduce((v, r) => v + num(r.buy_volume), 0),
    sell_volume: matched.reduce((v, r) => v + num(r.sell_volume), 0),
    gross_volume: matched.reduce((v, r) => v + num(r.gross_volume), 0),
    net_volume: matched.reduce((v, r) => v + num(r.net_volume), 0),
    open_long_volume: matched.reduce((v, r) => v + num(r.open_long_volume), 0),
    close_long_volume: matched.reduce((v, r) => v + num(r.close_long_volume), 0),
    open_short_volume: matched.reduce((v, r) => v + num(r.open_short_volume), 0),
    close_short_volume: matched.reduce((v, r) => v + num(r.close_short_volume), 0),
    transactions: matched.reduce((v, r) => v + num(r.transactions), 0),
    unique_liquidators: matched.reduce((v, r) => v + num(r.unique_liquidators), 0),
    unique_liquidated: matched.reduce((v, r) => v + num(r.unique_liquidated), 0),
    total_fees: matched.reduce((v, r) => v + num(r.total_fees), 0)
  };
}

async function main() {
  if (!PINAX_API_KEY) throw new Error('PINAX_API_KEY/PINAX_API_TOKEN is not configured');

  const now = Date.now();
  const closed5mStart = windowStart(now, WINDOW_5M) - WINDOW_5M;
  const closed15mStart = windowStart(now, WINDOW_15M) - WINDOW_15M;
  const closed5mEnd = closed5mStart + WINDOW_5M;
  const closed15mEnd = closed15mStart + WINDOW_15M;

  console.log('=== PINAX LIQUIDATION OHLC DIAGNOSTIC ===');
  console.log(`NOW: ${new Date(now).toISOString()}`);
  console.log(`5M TARGET: ${new Date(closed5mStart).toISOString()}..${new Date(closed5mEnd).toISOString()}`);
  console.log(`15M TARGET: ${new Date(closed15mStart).toISOString()}..${new Date(closed15mEnd).toISOString()}`);
  console.log('NOTE: Pinax liquidation OHLC supports 5m but not native 15m; 15m is composed from three aligned 5m candles.');
  console.log('NOTE: unique_liquidated is NOT summed as a true unique-user count across 15m; it is shown only as a diagnostic sum.');

  for (const coin of ASSETS) {
    try {
      const rows5m = await fetchOhlc(coin, closed5mStart, closed5mEnd);
      const rows15m = await fetchOhlc(coin, closed15mStart, closed15mEnd);
      console.log(`[OHLC][SUMMARY] ${coin} 5M=${JSON.stringify(summarize(rows5m, closed5mStart, closed5mEnd))}`);
      console.log(`[OHLC][SUMMARY] ${coin} 15M_COMPOSED=${JSON.stringify(summarize(rows15m, closed15mStart, closed15mEnd))}`);
    } catch (error) {
      console.error(`[OHLC][ERROR] ${coin}:`, error?.message ?? error);
    }
  }

  console.log('=== END PINAX LIQUIDATION OHLC DIAGNOSTIC ===');
}

main().catch(error => {
  console.error('[OHLC][FATAL]', error?.message ?? error);
  process.exitCode = 1;
});
