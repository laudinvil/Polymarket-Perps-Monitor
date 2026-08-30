const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const ASSETS = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const DIRECTIONS = new Map([
  ['LIQUIDATED_CROSS_LONG', 'LONG'],
  ['LIQUIDATED_ISOLATED_LONG', 'LONG'],
  ['LIQUIDATED_CROSS_SHORT', 'SHORT'],
  ['LIQUIDATED_ISOLATED_SHORT', 'SHORT']
]);
const POLL_MS = 10000;
const LOOKBACK_MS = 45000;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const MIN_SIZE = 10;

let pollTimer = null;
let running = false;
const seen = new Set();
const best = new Map();
let onWindowClose = null;

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

function timestampMs(value) {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const text = String(value ?? '');
  const n = Number(text);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(text.replace(' ', 'T') + (text.endsWith('Z') ? '' : 'Z'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function bucketStart(ts, duration) { return Math.floor(ts / duration) * duration; }

function key(duration, start, asset, side) { return `${duration}:${start}:${asset}:${side}`; }

function remember(row, ts, side) {
  const notional = num(row.notional);
  if (notional < MIN_SIZE) return;
  const asset = String(row.coin ?? '').toUpperCase();
  if (!ASSETS.has(asset)) return;

  for (const duration of [WINDOW_5M, WINDOW_15M]) {
    const start = bucketStart(ts, duration);
    const k = key(duration, start, asset, side);
    const previous = best.get(k);
    if (!previous || notional > previous.notional) {
      best.set(k, {
        asset,
        side,
        quote: 'USDC',
        notional,
        price: num(row.avg_fill_price),
        timestamp: ts,
        eventHash: String(row.event_hash ?? '')
      });
    }
  }
}

async function poll() {
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
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    });
    const body = await response.text();
    if (!response.ok) {
      console.error(`[Pinax] HTTP ${response.status}: ${body.slice(0, 500)}`);
      return;
    }

    const payload = JSON.parse(body);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    for (const row of rows) {
      const direction = DIRECTIONS.get(String(row.direction ?? '').toUpperCase());
      const ts = timestampMs(row.timestamp);
      const eventId = String(row.event_hash ?? `${row.timestamp}:${row.coin}:${row.direction}:${row.notional}`);
      if (!direction || !ts || seen.has(eventId)) continue;
      seen.add(eventId);
      remember(row, ts, direction);
    }

    if (onWindowClose) await onWindowClose(end);
    prune(end);
  } catch (error) {
    console.error('[Pinax] request error:', error?.message ?? error);
  }
}

function prune(now) {
  const cutoff = now - WINDOW_15M * 2;
  for (const [k, item] of best) if (item.timestamp < cutoff) best.delete(k);
  if (seen.size > 5000) {
    const keep = [...seen].slice(-2500);
    seen.clear();
    for (const id of keep) seen.add(id);
  }
}

export function getPinaxBest(duration, start, asset, side) {
  return best.get(key(duration, start, asset, side)) ?? null;
}

export function consumePinaxWindow(duration, start, assets, side) {
  let selected = null;
  for (const asset of assets) {
    const item = best.get(key(duration, start, asset, side));
    if (item && (!selected || item.notional > selected.notional)) selected = item;
    best.delete(key(duration, start, asset, side));
  }
  return selected;
}

export function setPinaxWindowCloseHandler(handler) { onWindowClose = handler; }

export function startPinaxLiquidationEngine() {
  if (running) return;
  running = true;
  console.log('[Pinax] REAL liquidation engine ENABLED');
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_MS);
}

export function stopPinaxLiquidationEngine() {
  running = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
