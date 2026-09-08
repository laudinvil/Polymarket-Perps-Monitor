const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { TIMEFRAMES, bucketStart, findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Authoritative monitor: individual liquidation events only.
// No imbalance, no streaks, no 15m/1h/4h/1d monitoring.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const DEDUPE_WINDOW_MS = 15 * 60 * 1000;

const seenLiquidations = new Set();
let dedupePeriodStart = null;
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

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
  console.log(`LIQUIDATION DEDUPE RESET ${new Date(period).toISOString()} (15m window)`);
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

async function findNextPolymarket(symbol, eventTs) {
  const currentBucket = bucketStart(eventTs, TIMEFRAME);
  return findNextMarket(symbol, currentBucket + TIMEFRAMES[TIMEFRAME], TIMEFRAME);
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
  const currentBucket = bucketStart(now, TIMEFRAME);

  for (const symbol of SYMBOLS) {
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts < windowStart || ts >= now) continue;
      if (bucketStart(ts, TIMEFRAME) >= currentBucket) continue;

      const side = eventSide(event);
      if (!side) continue;

      const key = liquidationKey(symbol, ts, side, event);
      if (seenLiquidations.has(key)) continue;
      seenLiquidations.add(key);

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
        dedupeWindowStart: windowStart
      }));

      let market = null;
      try {
        market = await findNextPolymarket(symbol, ts);
      } catch (error) {
        console.warn(`POLYMARKET LOOKUP FAILED 5m ${symbol}: ${error.message}`);
      }

      const message = [
        `🔥 ${symbol} · 5M`,
        `Side: ${side === 'LONG' ? 'Long' : 'Short'}`,
        `Volume: ${money(eventNotional)}`,
        `Price: ${price(eventPrice)}`,
        `Qty: ${quantity(eventQty)}`,
        market?.url ? '' : null,
        market?.url ? `➡️ NEXT · Polymarket 5M\n${market.url}` : null
      ].filter(value => value !== null).join('\n');

      enqueueAlert(message, symbol, side, key);
    }
  }
}

async function main() {
  console.log(`SINGLE LIQUIDATION MONITOR STARTED; coins=${SYMBOLS.join(',')}; only 5m; individual events only; 15m dedupe; no streaks; no imbalance`);
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
