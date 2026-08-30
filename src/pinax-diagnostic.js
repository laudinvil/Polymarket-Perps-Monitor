const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations/ohlc';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const PERIODS = [
  { label: '5M', interval: '5m', ms: 5 * 60 * 1000 },
  { label: '15M', interval: '15m', ms: 15 * 60 * 1000 }
];

function number(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(ms) { return new Date(ms).toISOString(); }

async function fetchCandle(asset, period) {
  const token = process.env.PINAX_API_KEY;
  if (!token) throw new Error('PINAX_API_KEY is not configured');

  const now = Date.now();
  const current = Math.floor(now / period.ms) * period.ms;
  const previous = current - period.ms;
  const params = new URLSearchParams({
    coin: asset,
    dex: 'perps',
    interval: period.interval,
    start_time: iso(previous),
    end_time: iso(current),
    limit: '10',
    page: '1'
  });

  const response = await fetch(`${PINAX_URL}?${params}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);

  const payload = JSON.parse(body);
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const row = rows.at(-1) ?? rows[0] ?? null;
  if (!row) return { asset, period: period.label, previous, current, row: null };

  return {
    asset,
    period: period.label,
    previous,
    current,
    row,
    long: number(row.sell_volume),
    short: number(row.buy_volume),
    gross: number(row.gross_volume),
    transactions: number(row.transactions),
    uniqueLiquidated: number(row.unique_liquidated)
  };
}

console.log('=== PINAX LIQUIDATION-ONLY OHLCV DIAGNOSTIC ===');
console.log('Telegram: DISABLED (diagnostic only)');
console.log('Testing previous fully closed 5M/15M candles.');

const results = await Promise.all(
  PERIODS.flatMap(period => ASSETS.map(asset => fetchCandle(asset, period).catch(error => ({
    asset,
    period: period.label,
    error: error?.message ?? String(error)
  })))
);

for (const result of results) {
  if (result.error) {
    console.log(`[ERROR] ${result.asset} ${result.period}: ${result.error}`);
    continue;
  }
  if (!result.row) {
    console.log(`[EMPTY] ${result.asset} ${result.period} ${iso(result.previous)} -> ${iso(result.current)}`);
    continue;
  }
  const winner = result.long > result.short ? 'LONG' : result.short > result.long ? 'SHORT' : 'TIE';
  console.log(
    `[OHLCV] ${result.asset} ${result.period} ${iso(result.previous)} -> ${iso(result.current)} ` +
    `LONG=${result.long} SHORT=${result.short} GROSS=${result.gross} ` +
    `TX=${result.transactions} LIQUIDATED=${result.uniqueLiquidated} WINNER=${winner}`
  );
}

console.log('=== DIAGNOSTIC COMPLETE: NO TELEGRAM ALERTS SENT ===');
