const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const ASSETS = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const DIRECTIONS = new Set([
  'LIQUIDATED_CROSS_LONG',
  'LIQUIDATED_CROSS_SHORT',
  'LIQUIDATED_ISOLATED_LONG',
  'LIQUIDATED_ISOLATED_SHORT'
]);
const POLL_MS = 10000;
const LOOKBACK_MS = 30000;
const seen = new Set();
let timer = null;
let running = false;

function num(v) {
  return Number.isFinite(Number(v)) ? Number(v) : 0;
}

export async function pollPinaxLiquidations() {
  const apiKey = process.env.PINAX_API_KEY;
  if (!apiKey) {
    console.error('[Pinax] PINAX_API_KEY is not configured');
    return;
  }

  const end = Date.now();
  const start = end - LOOKBACK_MS;
  const params = new URLSearchParams({
    coin: [...ASSETS].join(','),
    dex: 'perps',
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    sort_by: 'time',
    limit: '100',
    page: '1'
  });

  try {
    const response = await fetch(`${PINAX_URL}?${params}`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json'
      }
    });

    const body = await response.text();
    if (!response.ok) {
      console.error(`[Pinax] HTTP ${response.status}: ${body.slice(0, 500)}`);
      return;
    }

    const payload = JSON.parse(body);
    const rows = Array.isArray(payload?.data) ? payload.data : [];

    for (const row of rows) {
      if (!ASSETS.has(String(row.coin ?? '').toUpperCase())) continue;
      if (!DIRECTIONS.has(String(row.direction ?? '').toUpperCase())) continue;

      const eventId = String(row.event_hash ?? `${row.timestamp}:${row.coin}:${row.direction}:${row.notional}`);
      if (seen.has(eventId)) continue;
      seen.add(eventId);

      console.log('[Pinax][REAL LIQUIDATION]', JSON.stringify({
        timestamp: row.timestamp,
        coin: row.coin,
        direction: row.direction,
        liquidation_kind: row.liquidation_kind,
        notional: num(row.notional),
        total_size: num(row.total_size),
        avg_fill_price: num(row.avg_fill_price),
        mark_price: num(row.mark_price),
        liquidation_method: row.liquidation_method,
        event_hash: row.event_hash
      }));
    }

    // Keep memory bounded during long GitHub Actions runs.
    if (seen.size > 5000) {
      const keep = [...seen].slice(-2500);
      seen.clear();
      for (const id of keep) seen.add(id);
    }
  } catch (error) {
    console.error('[Pinax] request error:', error?.message ?? error);
  }
}

export function startPinaxLiquidationDiagnostic() {
  if (running) return;
  running = true;
  console.log('[Pinax] liquidation diagnostic ENABLED — no Telegram alerts from Pinax');
  void pollPinaxLiquidations();
  timer = setInterval(() => void pollPinaxLiquidations(), POLL_MS);
}

export function stopPinaxLiquidationDiagnostic() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
}
