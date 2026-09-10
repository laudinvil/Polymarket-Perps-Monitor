const fs = require('fs');
const path = require('path');
const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { bucketStart, findMarketByEpoch, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Authoritative liquidation monitor: individual liquidation events only.
// BTC only. 5m periods only. Each period can produce exactly ONE alert.
// Alert side alternates and persists across workflow restarts.
const SYMBOLS = ['BTC'];
const TIMEFRAME = '5m';
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const SIDE_STATE_PATH = path.resolve('.monitor-side-state.json');

const state = {
  timeframe: TIMEFRAME,
  seenLiquidations: new Set(),
  periodStart: null,
  periodAlreadyAlerted: false,
  expectedSide: loadExpectedSide(),
  initialized: false,
};
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function loadExpectedSide() {
  try {
    const saved = JSON.parse(fs.readFileSync(SIDE_STATE_PATH, 'utf8'));
    const lastSide = String(saved?.['5m']?.lastAlertSide || '').toUpperCase();
    if (lastSide === 'LONG') return 'SHORT';
    if (lastSide === 'SHORT') return 'LONG';
  } catch {}
  return 'LONG';
}

function persistLastAlertSide(side) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(SIDE_STATE_PATH, 'utf8')); } catch {}
  saved['5m'] = {
    version: 1,
    lastAlertSide: side,
    nextExpectedSide: side === 'LONG' ? 'SHORT' : 'LONG',
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(SIDE_STATE_PATH, JSON.stringify(saved, null, 2) + '\n');
    console.log(`SIDE STATE SAVED timeframe=5m last=${side} next=${side === 'LONG' ? 'SHORT' : 'LONG'}`);
  } catch (error) {
    console.warn(`SIDE STATE SAVE FAILED 5m: ${error.message}`);
  }
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

function resetPeriod(now) {
  const period = bucketStart(now, TIMEFRAME);
  if (state.periodStart === period) return;
  state.periodStart = period;
  state.seenLiquidations.clear();
  state.periodAlreadyAlerted = false;
  console.log(`LIQUIDATION PERIOD RESET ${new Date(period).toISOString()} (5m; BTC only; expected side=${state.expectedSide})`);
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
  return findMarketByEpoch(symbol, bucketStart(now, TIMEFRAME), TIMEFRAME);
}

function enqueueAlert(message, symbol, side, key) {
  alertSendChain = alertSendChain.then(async () => {
    const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      state.expectedSide = side === 'LONG' ? 'SHORT' : 'LONG';
      persistLastAlertSide(side);
      console.log(`5m ALERT SENT ${symbol} ${side} display=${displaySide(side)} key=${key}; NEXT EXPECTED SIDE=${state.expectedSide}`);
    } catch (error) {
      console.warn(`5m ALERT SEND FAILED ${symbol}: ${error.message}`);
    }
  }).catch(error => console.warn(`5m ALERT QUEUE FAILED: ${error.message}`));
}

async function processTimeframe(feeds, now) {
  resetPeriod(now);
  if (state.periodAlreadyAlerted) return;

  const candidates = [];
  for (const symbol of SYMBOLS) {
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts < state.periodStart || ts >= now) continue;

      const side = eventSide(event);
      if (side !== state.expectedSide) continue;

      const key = liquidationKey(symbol, ts, side, event);
      if (state.seenLiquidations.has(key)) continue;
      state.seenLiquidations.add(key);
      candidates.push({ symbol, side, key, event, ts });
    }
  }

  if (!state.initialized) {
    state.initialized = true;
    console.log(`INITIAL LIQUIDATION BASELINE READY 5m; historical events suppressed=${state.seenLiquidations.size}; expected side=${state.expectedSide}`);
    return;
  }

  if (!candidates.length) return;

  candidates.sort((a, b) => a.ts - b.ts);
  const { symbol, side, key, event, ts } = candidates[0];
  state.periodAlreadyAlerted = true;

  console.log(`5m FIRST MATCH CLAIMED symbol=${symbol} side=${side} display=${displaySide(side)} ts=${new Date(ts).toISOString()} ignored=${Math.max(0, candidates.length - 1)}; next expected side=${side === 'LONG' ? 'SHORT' : 'LONG'}`);

  const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
  const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
  const eventNotional = numberValue(event?.notional, event?.usd, event?.value, event?.amount, eventPrice * eventQty);

  console.log(JSON.stringify({
    type: 'liquidation', timeframe: '5m', symbol, ts, side,
    displaySide: displaySide(side), price: eventPrice,
    notional: Math.abs(eventNotional), periodStart: state.periodStart,
    firstLiquidationOnly: true, alternatingSide: true,
    nextExpectedSide: side === 'LONG' ? 'SHORT' : 'LONG'
  }));

  let market = null;
  try {
    market = await findCurrentPolymarket(symbol, Date.now());
  } catch (error) {
    console.warn(`POLYMARKET CURRENT LOOKUP FAILED 5m ${symbol}: ${error.message}`);
  }

  let marketPrice = null;
  try {
    const outcome = displaySide(side);
    const midpoint = await findClobMidpoint(market, outcome);
    if (midpoint !== null) marketPrice = formatClobPrice(midpoint);
    console.log(`CLOB MIDPOINT ${symbol} 5m ${outcome}=${marketPrice ?? 'UNAVAILABLE'}`);
  } catch (error) {
    console.warn(`CLOB MIDPOINT FAILED 5m ${symbol}: ${error.message}`);
  }

  const message = [
    `🔥 ${symbol} · 5M`,
    displaySide(side),
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    marketPrice !== null ? `Polymarket Price: ${marketPrice}` : null,
    market?.url ? '' : null,
    market?.url ? `➡️ CURRENT · Polymarket 5M\n${market.url}` : null
  ].filter(value => value !== null).join('\n');

  enqueueAlert(message, symbol, side, key);
}

async function main() {
  console.log('SINGLE LIQUIDATION MONITOR STARTED; coins=BTC; timeframe=5m; ONE ALERT PER PERIOD; SIDE ALTERNATION PERSISTED; display LONG=>DOWN SHORT=>UP; CLOB midpoint price; no streaks; no imbalance; no 15m');
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
