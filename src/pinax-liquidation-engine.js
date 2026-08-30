const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations/ohlc';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const POLL_MS = 10000;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const MIN_SIZE = 10;

let pollTimer = null;
let running = false;
let onWindowClose = null;
const windows = new Map();

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }

function timestampMs(value) {
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000;
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n > 1e12 ? n : n * 1000;
  const parsed = Date.parse(String(value ?? '').replace(' ', 'T') + (String(value ?? '').endsWith('Z') ? '' : 'Z'));
  return Number.isFinite(parsed) ? parsed : 0;
}

function bucketStart(ts, duration) { return Math.floor(ts / duration) * duration; }
function key(duration, start, asset) { return `${duration}:${start}:${asset}`; }

function rememberCandle(row, duration) {
  const asset = String(row.coin ?? '').toUpperCase();
  if (!ASSETS.includes(asset)) return;

  const ts = timestampMs(row.timestamp);
  if (!ts) return;

  // In liquidation-only OHLCV, buy_volume is the liquidation buy flow
  // (shorts being liquidated) and sell_volume is the liquidation sell flow
  // (longs being liquidated). Counterparty fills are excluded by Pinax.
  const shortVolume = num(row.buy_volume);
  const longVolume = num(row.sell_volume);
  const start = bucketStart(ts, duration);
  windows.set(key(duration, start, asset), {
    asset,
    longVolume,
    shortVolume,
    timestamp: ts
  });
}

async function fetchWindow(coin, duration, start, end) {
  const apiKey = process.env.PINAX_API_KEY;
  if (!apiKey) {
    console.error('[Pinax OHLCV] PINAX_API_KEY is not configured');
    return;
  }

  const interval = duration === WINDOW_5M ? '5m' : '15m';
  const params = new URLSearchParams({
    coin,
    dex: 'perps',
    interval,
    start_time: new Date(start).toISOString(),
    end_time: new Date(end).toISOString(),
    limit: '10',
    page: '1'
  });

  try {
    const response = await fetch(`${PINAX_URL}?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' }
    });
    const body = await response.text();
    if (!response.ok) {
      console.error(`[Pinax OHLCV] ${coin} ${interval} HTTP ${response.status}: ${body.slice(0, 300)}`);
      return;
    }
    const payload = JSON.parse(body);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    for (const row of rows) rememberCandle(row, duration);
  } catch (error) {
    console.error(`[Pinax OHLCV] ${coin} ${interval}:`, error?.message ?? error);
  }
}

async function poll() {
  const now = Date.now();
  const tasks = [];
  for (const duration of [WINDOW_5M, WINDOW_15M]) {
    const current = bucketStart(now, duration);
    const previous = current - duration;
    for (const coin of ASSETS) tasks.push(fetchWindow(coin, duration, previous, current));
  }
  await Promise.all(tasks);
  if (onWindowClose) await onWindowClose(now);
  prune(now);
}

function prune(now) {
  const cutoff = now - WINDOW_15M * 3;
  for (const [k, item] of windows) if (item.timestamp < cutoff) windows.delete(k);
}

export function consumePinaxWindow(duration, start, assets) {
  const selected = [];
  for (const asset of assets) {
    const item = windows.get(key(duration, start, asset));
    windows.delete(key(duration, start, asset));
    if (!item) continue;

    const side = item.longVolume > item.shortVolume ? 'LONG' : item.shortVolume > item.longVolume ? 'SHORT' : null;
    const volume = side === 'LONG' ? item.longVolume : side === 'SHORT' ? item.shortVolume : 0;
    if (!side || volume < MIN_SIZE) continue;

    selected.push({ asset, side, notional: volume, longVolume: item.longVolume, shortVolume: item.shortVolume });
  }
  return selected;
}

export function setPinaxWindowCloseHandler(handler) { onWindowClose = handler; }

export function startPinaxLiquidationEngine() {
  if (running) return;
  running = true;
  console.log('[Pinax OHLCV] liquidation-only 5m/15m engine ENABLED');
  console.log('[Pinax OHLCV] LONG = sell_volume, SHORT = buy_volume');
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_MS);
}

export function stopPinaxLiquidationEngine() {
  running = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
