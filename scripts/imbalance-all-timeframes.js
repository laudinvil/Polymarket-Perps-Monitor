const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { bucketStart, findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Authoritative monitor: individual liquidation events only.
// All 7 coins are monitored, but only the FIRST liquidation per 10-minute
// Polymarket period is alerted. The coin that alerted in the previous period
// is blocked for the immediately following period.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;

const seenLiquidations = new Set();
let dedupePeriodStart = null;
let periodAlreadyAlerted = false;
let lastAlertSymbol = null;
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;
let initialized = false;

function eventSide(event) {
  const value = String(event?.side || event?.direction || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 'LONG';
  if (value.includes('short') || value === 'sell') return 'SHORT';
  return null;
}

function dedupeWindowStart(ts) {
  return Math.floor(ts / DEDUPE_WINDOW_MS) * DEDUPE_WINDOW_MS;
}

function resetDedupeWindow(ts) {
  const period = dedupeWindowStart(ts);
  if (dedupePeriodStart === period) return;
  dedupePeriodStart = period;
  seenLiquidations.clear();
  periodAlreadyAlerted = false;
  console.log(`LIQUIDATION PERIOD RESET ${new Date(period).toISOString()} (10m; first liquidation only; previous coin blocked=${lastAlertSymbol || 'none'})`);
}

function liquidationKey(symbol, ts, side, event) {
  const id = event?.id ?? event?.liquidationId ?? event?.eventId ?? event?.tradeId ?? event?.txHash ?? event?.orderId;
  if (id !== undefined && id !== null && String(id) !== '') return `${symbol}:id:${String(id)}`;
  return [symbol, ts, side, event?.exchange ?? '', event?.price ?? '', event?.qty ?? event?.quantity ?? event?.size ?? '', event?.notional ?? event?.usd ?? event?.value ?? event?.amount ?? ''].join('|');
}

function numberValue(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function money(value) {
  return `$${Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function quantity(value) {
  return Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function price(value) {
  return Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

async function fetchAllFeeds() {
  const results = await Promise.all(SYMBOLS.map(async symbol => {
    try {
      return [symbol, await fetchSymbolFeed(symbol)];
    } catch (error) {
      console.warn(`FEED ${symbol} FAILED: ${error.message}`);
      return [symbol, []];
    }
  }));
  return new Map(results);
}

async function findPreviousPolymarket(symbol, eventTs) {
  const currentBucket = bucketStart(eventTs, TIMEFRAME);
  return findNextMarket(symbol, currentBucket, TIMEFRAME);
}

function enqueueAlert(message, symbol, side, key) {
  alertSendChain = alertSendChain.then(async () => {
    const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      console.log(`5M ALERT SENT ${symbol} ${side} key=${key}`);
    } catch (error) {
      console.warn(`5M ALERT SEND FAILED ${symbol}: ${error.message}`);
    }
  }).catch(error => console.warn(`5M ALERT QUEUE FAILED: ${error.message}`));
}

async function processLiquidations(feeds, now) {
  resetDedupeWindow(now);
  const windowStart = dedupePeriodStart;
  const blockedSymbol = lastAlertSymbol;

  // Once one liquidation has claimed this 10m period, all other coins/events
  // are ignored until the next 10m period begins.
  if (periodAlreadyAlerted) return;

  const candidates = [];
  for (const symbol of SYMBOLS) {
    // A coin that alerted in the previous 10m period cannot alert again
    // in the immediately following 10m period.
    if (symbol === blockedSymbol) continue;

    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts < windowStart || ts >= now) continue;

      const side = eventSide(event);
      if (!side) continue;

      const key = liquidationKey(symbol, ts, side, event);
      if (seenLiquidations.has(key)) continue;
      seenLiquidations.add(key);
      candidates.push({ symbol, side, key, event, ts });
    }
  }

  if (!initialized) {
    initialized = true;
    console.log(`INITIAL LIQUIDATION BASELINE READY; historical events suppressed=${seenLiquidations.size}; previous coin block=${blockedSymbol || 'none'}`);
    return;
  }

  if (!candidates.length) return;

  // The earliest newly observed liquidation wins the 10m period, regardless of coin,
  // except that the previous period's winning coin is blocked for this period.
  candidates.sort((a, b) => a.ts - b.ts);
  const { symbol, side, key, event, ts } = candidates[0];
  periodAlreadyAlerted = true;
  lastAlertSymbol = symbol;

  // All other candidates are intentionally ignored for this 10m period.
  console.log(`10M FIRST LIQUIDATION CLAIMED symbol=${symbol} side=${side} ts=${new Date(ts).toISOString()} ignored=${Math.max(0, candidates.length - 1)}; next-period block=${symbol}`);

  const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
  const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
  const eventNotional = numberValue(event?.notional, event?.usd, event?.value, event?.amount, eventPrice * eventQty);

  console.log(JSON.stringify({
    type: 'liquidation',
    timeframe: '5m',
    symbol,
    ts,
    side,
    price: eventPrice,
    qty: eventQty,
    notional: Math.abs(eventNotional),
    dedupeWindowStart: windowStart,
    firstLiquidationOnly: true,
    periodMinutes: 10,
    previousPeriodCoinBlocked: blockedSymbol
  }));

  let market = null;
  try {
    market = await findPreviousPolymarket(symbol, ts);
  } catch (error) {
    console.warn(`POLYMARKET LOOKUP FAILED 5m ${symbol}: ${error.message}`);
  }

  const message = [
    `🔥 ${symbol} · 5M`,
    side,
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    `Qty: ${quantity(eventQty)}`,
    market?.url ? '' : null,
    market?.url ? `➡️ NEXT · Polymarket 5M\n${market.url}` : null
  ].filter(value => value !== null).join('\n');

  enqueueAlert(message, symbol, side, key);
}

async function main() {
  console.log(`SINGLE LIQUIDATION MONITOR STARTED; coins=${SYMBOLS.join(',')}; only 5m; FIRST LIQUIDATION ONLY per 10m period; previous-period coin blocked; other events ignored; no streaks; no imbalance`);
  while (true) {
    const now = Date.now();
    try {
      const feeds = await fetchAllFeeds();
      await processLiquidations(feeds, now);
    } catch (error) {
      console.warn(`MONITOR LOOP FAILED: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(`MONITOR FATAL: ${error.stack || error.message}`);
  process.exitCode = 1;
});