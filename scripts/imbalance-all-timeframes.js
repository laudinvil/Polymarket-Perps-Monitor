const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { findNextMarket, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Authoritative liquidation activity monitor.
// All supported coins. 5m periods. Individual liquidation events only.
// Activity is evaluated collectively across all coins: each of three consecutive
// 30s buckets must contain at least one liquidation from any monitored coin.
// The latest liquidation event becomes the alert event. Maximum one alert per 5m period.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const ACTIVITY_BUCKET_MS = 30 * 1000;
const REQUIRED_CONSECUTIVE_BUCKETS = 3;
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;

const state = {
  periodStart: null,
  periodAlreadyAlerted: false,
  initialized: false,
  seenLiquidations: new Set(),
  activityBuckets: new Map(),
};
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function periodStart(now) {
  return Math.floor(now / (5 * 60 * 1000)) * (5 * 60 * 1000);
}

function activityBucketStart(ts) {
  return Math.floor(ts / ACTIVITY_BUCKET_MS) * ACTIVITY_BUCKET_MS;
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
  state.activityBuckets.clear();
  console.log(`LIQUIDATION ACTIVITY PERIOD RESET ${new Date(next).toISOString()} (5m; all coins collectively)`);
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

function buildActivityCandidates(feeds, now) {
  const currentBucket = activityBucketStart(now);

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

      const bucket = activityBucketStart(ts);
      const row = state.activityBuckets.get(bucket) || { bucket, count: 0, events: [] };
      row.count += 1;
      row.events.push({ symbol, side, event, ts, key });
      state.activityBuckets.set(bucket, row);
    }
  }

  // Retain only buckets inside the current 5m period so the running state
  // cannot leak across period boundaries or grow indefinitely.
  for (const bucket of state.activityBuckets.keys()) {
    if (bucket < state.periodStart || bucket >= currentBucket) state.activityBuckets.delete(bucket);
  }

  const latestBucket = currentBucket - ACTIVITY_BUCKET_MS;
  const bucketRows = [];
  for (let i = REQUIRED_CONSECUTIVE_BUCKETS - 1; i >= 0; i -= 1) {
    const bucket = latestBucket - i * ACTIVITY_BUCKET_MS;
    const row = state.activityBuckets.get(bucket);
    bucketRows.push({ bucket, count: row?.count || 0, events: row?.events || [] });
  }

  console.log(`LIQUIDATION ACTIVITY BUCKETS ${bucketRows.map(row => `${new Date(row.bucket).toISOString()}=${row.count}`).join(' | ')}`);

  if (bucketRows.some(row => row.count < 1)) return [];

  const latestRow = bucketRows[bucketRows.length - 1];
  const latestEvent = [...latestRow.events].sort((a, b) => a.ts - b.ts).at(-1);
  if (!latestEvent) return [];

  return [{
    symbol: latestEvent.symbol,
    side: latestEvent.side,
    bucketCounts: bucketRows.map(row => row.count),
    latestCount: latestRow.count,
    latestEvent,
  }];
}

function enqueueAlert(message, candidate) {
  alertSendChain = alertSendChain.then(async () => {
    const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      console.log(`5m ACTIVITY ALERT SENT ${candidate.symbol} ${candidate.side} display=${displaySide(candidate.side)} buckets=${candidate.bucketCounts.join('->')}`);
    } catch (error) {
      console.warn(`5m ACTIVITY ALERT SEND FAILED ${candidate.symbol}: ${error.message}`);
    }
  }).catch(error => console.warn(`5m ACTIVITY ALERT QUEUE FAILED: ${error.message}`));
}

async function processTimeframe(feeds, now) {
  resetPeriod(now);
  if (state.periodAlreadyAlerted) return;

  const candidates = buildActivityCandidates(feeds, now);

  if (!state.initialized) {
    state.initialized = true;
    console.log('INITIAL LIQUIDATION ACTIVITY BASELINE READY 5m; historical events suppressed');
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

  console.log(`5m LIQUIDATION ACTIVITY CLAIMED symbol=${symbol} side=${side} display=${displaySide(side)} buckets=${candidate.bucketCounts.join('->')} rule=collective_all_coins_at_least_one_each_30s`);

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
    console.warn(`CLOB MIDPOINT FAILED 5m ${displaySide(side)}: ${error.message}`);
  }

  const message = [
    `🔥 ${symbol} · 5M`,
    displaySide(side),
    'LIQUIDATIONS EVERY 30S',
    `30s: ${candidate.latestCount}`,
    `Previous 30s: ${candidate.bucketCounts[1]}`,
    `30s before: ${candidate.bucketCounts[0]}`,
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    marketPrice !== null ? `Polymarket Price: ${marketPrice}` : null,
    nextMarket?.url ? `➡️ NEXT · Polymarket 5M\n${nextMarket.url}` : null
  ].filter(value => value !== null).join('\n');

  enqueueAlert(message, candidate);
}

async function main() {
  console.log('LIQUIDATION ACTIVITY MONITOR STARTED; coins=BTC,ETH,SOL,XRP,DOGE,BNB,HYPE; timeframe=5m; collective all coins; at least 1 liquidation in each 30s bucket; 3 consecutive 30s buckets required; latest liquidation becomes alert; ONE ALERT PER PERIOD; individual events only; no imbalance; no streaks; next market only');
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
