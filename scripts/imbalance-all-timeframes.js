const fs = require('fs');
const path = require('path');
const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Authoritative monitor: individual liquidation events only.
// Six coins are monitored. Each 5-minute period can produce exactly ONE
// alert. Alert side alternates globally and persists across workflow restarts.
const SYMBOLS = ['ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const SIDE_STATE_PATH = path.resolve('.monitor-side-state.json');

const seenLiquidations = new Set();
let dedupePeriodStart = null;
let periodAlreadyAlerted = false;
let expectedSide = loadExpectedSide();
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;
let initialized = false;

function loadExpectedSide() {
  try {
    const state = JSON.parse(fs.readFileSync(SIDE_STATE_PATH, 'utf8'));
    const lastSide = String(state?.lastAlertSide || '').toUpperCase();
    if (lastSide === 'LONG') return 'SHORT';
    if (lastSide === 'SHORT') return 'LONG';
  } catch {}
  return 'LONG';
}

function persistLastAlertSide(side) {
  const payload = JSON.stringify({
    version: 1,
    lastAlertSide: side,
    nextExpectedSide: side === 'LONG' ? 'SHORT' : 'LONG',
    updatedAt: new Date().toISOString()
  }, null, 2) + '\n';
  try {
    fs.writeFileSync(SIDE_STATE_PATH, payload);
    console.log(`SIDE STATE SAVED last=${side} next=${side === 'LONG' ? 'SHORT' : 'LONG'}`);
  } catch (error) {
    console.warn(`SIDE STATE SAVE FAILED: ${error.message}`);
  }
}

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
  console.log(`LIQUIDATION PERIOD RESET ${new Date(period).toISOString()} (5m; one coin only; expected side=${expectedSide})`);
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

async function findCurrentPolymarket(symbol, now) {
  const currentBucket = bucketStart(now, TIMEFRAME);
  return findMarketByEpoch(symbol, currentBucket, TIMEFRAME);
}

function enqueueAlert(message, symbol, side, key) {
  alertSendChain = alertSendChain.then(async () => {
    const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      expectedSide = side === 'LONG' ? 'SHORT' : 'LONG';
      persistLastAlertSide(side);
      console.log(`5M ALERT SENT ${symbol} ${side} key=${key}; NEXT EXPECTED SIDE=${expectedSide}`);
    } catch (error) {
      console.warn(`5M ALERT SEND FAILED ${symbol}: ${error.message}`);
    }
  }).catch(error => console.warn(`5M ALERT QUEUE FAILED: ${error.message}`));
}

async function processLiquidations(feeds, now) {
  resetDedupeWindow(now);
  if (periodAlreadyAlerted) return;

  const candidates = [];
  for (const symbol of SYMBOLS) {
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts < dedupePeriodStart || ts >= now) continue;

      const side = eventSide(event);
      if (side !== expectedSide) continue;

      const key = liquidationKey(symbol, ts, side, event);
      if (seenLiquidations.has(key)) continue;
      seenLiquidations.add(key);
      candidates.push({ symbol, side, key, event, ts });
    }
  }

  if (!initialized) {
    initialized = true;
    console.log(`INITIAL LIQUIDATION BASELINE READY; historical events suppressed=${seenLiquidations.size}; expected side=${expectedSide}`);
    return;
  }

  if (!candidates.length) return;

  // One coin per 5-minute period. The earliest matching liquidation wins;
  // every other coin/event in this period is ignored.
  candidates.sort((a, b) => a.ts - b.ts);
  const { symbol, side, key, event, ts } = candidates[0];
  periodAlreadyAlerted = true;

  console.log(`5M FIRST MATCH CLAIMED symbol=${symbol} side=${side} ts=${new Date(ts).toISOString()} ignored=${Math.max(0, candidates.length - 1)}; next expected side=${side === 'LONG' ? 'SHORT' : 'LONG'}`);

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
    notional: Math.abs(eventNotional),
    dedupeWindowStart: dedupePeriodStart,
    firstLiquidationOnly: true,
    periodMinutes: 5,
    alternatingSide: true,
    nextExpectedSide: side === 'LONG' ? 'SHORT' : 'LONG'
  }));

  let market = null;
  try {
    // CURRENT means the market active at the moment the alert is generated,
    // not the market after the liquidation event timestamp.
    market = await findCurrentPolymarket(symbol, Date.now());
  } catch (error) {
    console.warn(`POLYMARKET CURRENT LOOKUP FAILED 5m ${symbol}: ${error.message}`);
  }

  const message = [
    `🔥 ${symbol} · 5M`,
    side,
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    market?.url ? '' : null,
    market?.url ? `➡️ CURRENT · Polymarket 5M\n${market.url}` : null
  ].filter(value => value !== null).join('\n');

  enqueueAlert(message, symbol, side, key);
}

async function main() {
  console.log(`SINGLE LIQUIDATION MONITOR STARTED; coins=${SYMBOLS.join(',')}; BTC=DISABLED; only 5m; ONE COIN PER PERIOD; SIDE ALTERNATION PERSISTED; CURRENT Polymarket links; other coins ignored; no streaks; no imbalance`);
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
