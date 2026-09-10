const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { findNextMarket, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Authoritative liquidation acceleration monitor.
// All supported coins. 5m periods. Individual liquidation events only.
// Alert when liquidation-event frequency accelerates for the same side across
// three consecutive 30s buckets: older < previous < latest, with latest >= 4.
// Maximum one alert per 5m period.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const ACCELERATION_BUCKET_MS = 30 * 1000;
const MIN_LATEST_COUNT = 4;
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;

const state = {
  periodStart: null,
  periodAlreadyAlerted: false,
  initialized: false,
  seenLiquidations: new Set(),
};
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function periodStart(now) {
  return Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000);
}

function accelerationBucketStart(ts) {
  return Math.floor(ts / ACCELERATION_BUCKET_MS) * ACCELERATION_BUCKET_MS;
}

function eventSide(event) {
  const value = String(event?.side || event?.direction || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 'LONG';
  if (value.includes('short') || value === 'sell') return 'SHORT';
  return null;
}

function displaySide(side) {
  return side === 'LONG' ? 'DOWN' : 'UP';
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

function price(value) {
  return Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function formatClobPrice(value) {
  return Number(value).toFixed(4);
}

function resetPeriod(now) {
  const next = periodStart(now);
  if (state.periodStart === next) return;
  state.periodStart = next;
  state.periodAlreadyAlerted = false;
  state.seenLiquidations.clear();
  console.log(`LIQUIDATION ACCELERATION PERIOD RESET ${new Date(next).toISOString()} (5m; all coins)`);
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

function buildAccelerationCandidates(feeds, now) {
  const buckets = new Map();
  const currentBucket = accelerationBucketStart(now);

  for (const symbol of SYMBOLS) {
    const events = feeds.get(symbol) || [];
    for (const event of events) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts < state.periodStart || ts >= currentBucket) continue;

      const side = eventSide(event);
      if (!side) continue;

      const key = liquidationKey(symbol, ts, side, event);
      if (state.seenLiquidations.has(key)) continue;
      state.seenLiquidations.add(key);

      const bucket = accelerationBucketStart(ts);
      const bucketKey = `${symbol}:${side}:${bucket}`;
      const row = buckets.get(bucketKey) || { symbol, side, bucket, count: 0, events: [] };
      row.count += 1;
      row.events.push({ event, ts, key });
      buckets.set(bucketKey, row);
    }
  }

  const candidates = [];
  for (const symbol of SYMBOLS) {
    for (const side of ['LONG', 'SHORT']) {
      const latestBucket = currentBucket - ACCELERATION_BUCKET_MS;
      const b2 = buckets.get(`${symbol}:${side}:${latestBucket - 2 * ACCELERATION_BUCKET_MS}`);
      const b1 = buckets.get(`${symbol}:${side}:${latestBucket - ACCELERATION_BUCKET_MS}`);
      const b0 = buckets.get(`${symbol}:${side}:${latestBucket}`);
      const c2 = b2?.count || 0;
      const c1 = b1?.count || 0;
      const c0 = b0?.count || 0;

      if (!(c2 < c1 && c1 < c0 && c0 >= MIN_LATEST_COUNT)) continue;

      const latestEvent = (b0?.events || []).sort((a, b) => a.ts - b.ts)[b0.events.length - 1];
      if (!latestEvent) continue;

      candidates.push({
        symbol,
        side,
        olderCount: c2,
        previousCount: c1,
        latestCount: c0,
        accelerationPercent: c1 > 0 ? ((c0 - c1) / c1) * 100 : null,
        latestEvent,
      });
    }
  }

  return candidates.sort((a, b) => {
    if (b.latestCount !== a.latestCount) return b.latestCount - a.latestCount;
    return (b.accelerationPercent || 0) - (a.accelerationPercent || 0);
  });
}

function enqueueAlert(message, candidate) {
  alertSendChain = alertSendChain.then(async () => {
    const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      console.log(`5m ACCELERATION ALERT SENT ${candidate.symbol} ${candidate.side} display=${displaySide(candidate.side)} counts=${candidate.olderCount}->${candidate.previousCount}->${candidate.latestCount}`);
    } catch (error) {
      console.warn(`5m ACCELERATION ALERT SEND FAILED ${candidate.symbol}: ${error.message}`);
    }
  }).catch(error => console.warn(`5m ACCELERATION ALERT QUEUE FAILED: ${error.message}`));
}

async function processTimeframe(feeds, now) {
  resetPeriod(now);
  if (state.periodAlreadyAlerted) return;

  const candidates = buildAccelerationCandidates(feeds, now);

  if (!state.initialized) {
    state.initialized = true;
    console.log('INITIAL LIQUIDATION ACCELERATION BASELINE READY 5m; historical events suppressed');
    return;
  }

  if (!candidates.length) return;

  const candidate = candidates[0];
  state.periodAlreadyAlerted = true;
  const { symbol, side, latestEvent } = candidate;
  const event = latestEvent.event;
  const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
  const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
  const eventNotional = numberValue(event?.notional, event?.usd, event?.value, event?.amount, eventPrice * eventQty);

  console.log(`5m LIQUIDATION ACCELERATION CLAIMED symbol=${symbol} side=${side} display=${displaySide(side)} counts=${candidate.olderCount}->${candidate.previousCount}->${candidate.latestCount} acceleration=${candidate.accelerationPercent?.toFixed(1) ?? 'n/a'}%`);

  let nextMarket = null;
  try {
    nextMarket = await findNextMarket(symbol, Date.now(), TIMEFRAME);
    console.log(`POLYMARKET NEXT ${symbol} 5m=${nextMarket?.url ?? 'UNAVAILABLE'}`);
  } catch (error) {
    console.warn(`POLYMARKET NEXT LOOKUP FAILED 5m ${symbol}: ${error.message}`);
  }

  let marketPrice = null;
  try {
    const midpoint = await findClobMidpoint(nextMarket, displaySide(side));
    if (midpoint !== null) marketPrice = formatClobPrice(midpoint);
    console.log(`CLOB MIDPOINT ${symbol} 5m ${displaySide(side)}=${marketPrice ?? 'UNAVAILABLE'}`);
  } catch (error) {
    console.warn(`CLOB MIDPOINT FAILED 5m ${symbol}: ${error.message}`);
  }

  const message = [
    `🔥 ${symbol} · 5M`,
    displaySide(side),
    'LIQUIDATION ACCELERATION',
    `30s: ${candidate.latestCount}`,
    `Previous 30s: ${candidate.previousCount}`,
    `Acceleration: ${candidate.accelerationPercent?.toFixed(0) ?? 'n/a'}%`,
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    marketPrice !== null ? `Polymarket Price: ${marketPrice}` : null,
    nextMarket?.url ? `➡️ NEXT · Polymarket 5M\n${nextMarket.url}` : null
  ].filter(value => value !== null).join('\n');

  enqueueAlert(message, candidate);
}

async function main() {
  console.log('LIQUIDATION ACCELERATION MONITOR STARTED; coins=BTC,ETH,SOL,XRP,DOGE,BNB,HYPE; timeframe=5m; 30s buckets; acceleration requires 3 rising buckets; latest >= 4; ONE ALERT PER PERIOD; individual events only; no imbalance; no streaks; next market only');
  while (true) {
    const now = Date.now();
    try {
      const feeds = await fetchAllFeeds();
      await processTimeframe(feeds, now);
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
