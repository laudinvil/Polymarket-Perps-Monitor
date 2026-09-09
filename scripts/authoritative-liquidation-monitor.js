const fs = require('fs');
const path = require('path');
const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { bucketStart, findMarketByEpoch, TIMEFRAMES } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// AUTHORITATIVE: individual liquidations only.
// Only SHORT liquidations are eligible and are displayed as DOWN.
// Alert window: exactly one active Polymarket 5m market bucket (:00/:05/:10/... UTC).
// One alert total per 5m window. The coin alerted in window N is blocked in window N+1.
// No minimum volume. No imbalance. No streaks.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const POLL_MS = 4000;
const FIVE_MINUTE_MS = TIMEFRAMES[TIMEFRAME];
const STATE_FILE = path.join(__dirname, '..', '.liquidation-alert-state.json');

const seenLiquidations = new Set();
const startupTs = Date.now();
let initialized = false;
let alertWindowStart = null;
let hasAlerted = false;
let lastAlertWindowBySymbol = {};
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function alignedWindowStart(ts) {
  return bucketStart(ts, TIMEFRAME);
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const currentWindow = alignedWindowStart(Date.now());
    if (Number(state.alertWindowStart) === currentWindow) {
      alertWindowStart = currentWindow;
      hasAlerted = Boolean(state.hasAlerted);
    }
    if (state.lastAlertWindowBySymbol && typeof state.lastAlertWindowBySymbol === 'object') {
      lastAlertWindowBySymbol = { ...state.lastAlertWindowBySymbol };
    }
    for (const key of Array.isArray(state.seenLiquidations) ? state.seenLiquidations : []) {
      if (typeof key === 'string') seenLiquidations.add(key);
    }
    console.log(`ALERT STATE LOADED window=${alertWindowStart ?? 'none'} hasAlerted=${hasAlerted} blockedSymbols=${Object.keys(lastAlertWindowBySymbol).length} seen=${seenLiquidations.size}`);
  } catch (error) {
    console.log(`ALERT STATE INIT: ${error.message}`);
  }
}

function saveState() {
  try {
    const keys = Array.from(seenLiquidations);
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      alertWindowStart,
      hasAlerted,
      lastAlertWindowBySymbol,
      seenLiquidations: keys.slice(-10000),
      updatedAt: Date.now()
    }, null, 2));
  } catch (error) {
    console.warn(`ALERT STATE SAVE FAILED: ${error.message}`);
  }
}

function eventSide(event) {
  const value = String(event?.side || event?.direction || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 'LONG';
  if (value.includes('short') || value === 'sell') return 'SHORT';
  return null;
}

function liquidationKey(symbol, ts, side, event) {
  return [
    symbol,
    Math.floor(Number(ts) / 1000),
    side,
    String(event?.exchange ?? '').toLowerCase(),
    numberValue(event?.price, event?.markPrice, event?.executionPrice),
    numberValue(event?.qty, event?.quantity, event?.size)
  ].join('|');
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
    try { return [symbol, await fetchSymbolFeed(symbol)]; }
    catch (error) { console.warn(`FEED ${symbol} FAILED: ${error.message}`); return [symbol, []]; }
  }));
  return new Map(results);
}

async function findNextMarket(symbol) {
  const now = Date.now();
  const currentBucket = bucketStart(now, TIMEFRAME);
  const nextEpoch = currentBucket + (2 * TIMEFRAMES[TIMEFRAME]);
  return findMarketByEpoch(symbol, nextEpoch, TIMEFRAME);
}

function enqueueAlert(message, symbol, key, alertDetectedAt) {
  alertSendChain = alertSendChain.then(async () => {
    try {
      const waitMs = Math.max(0, 5000 - (Date.now() - lastAlertSentAt));
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      console.log(`5M ALERT SENT ${symbol} DOWN key=${key} detectedAt=${new Date(alertDetectedAt).toISOString()} sentAt=${new Date(lastAlertSentAt).toISOString()}`);
    } catch (error) { console.warn(`5M ALERT SEND FAILED ${symbol}: ${error.message}`); }
  }).catch(error => console.warn(`5M ALERT QUEUE FAILED: ${error.message}`));
}

function wasBlockedFromPreviousWindow(symbol, currentWindow) {
  return Number(lastAlertWindowBySymbol[symbol]) === currentWindow - FIVE_MINUTE_MS;
}

async function processLiquidations(feeds, now) {
  const currentWindow = alignedWindowStart(now);
  if (alertWindowStart !== currentWindow) {
    alertWindowStart = currentWindow;
    hasAlerted = false;
    saveState();
    console.log(`5M WINDOW RESET ${new Date(currentWindow).toISOString()}`);
  }

  if (!initialized) {
    initialized = true;
    for (const symbol of SYMBOLS) {
      for (const event of feeds.get(symbol) || []) {
        const ts = normalizeTs(event?.ts);
        if (ts && ts < now) {
          const side = eventSide(event);
          if (side) seenLiquidations.add(liquidationKey(symbol, ts, side, event));
        }
      }
    }
    saveState();
    return;
  }

  if (hasAlerted) return;

  const candidates = [];
  for (const symbol of SYMBOLS) {
    if (wasBlockedFromPreviousWindow(symbol, currentWindow)) {
      console.log(`5M PREVIOUS-WINDOW COIN BLOCK ${symbol}`);
      continue;
    }
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts >= now || ts <= startupTs) continue;
      const side = eventSide(event);
      // SHORT only. In Telegram it is always DOWN.
      if (side !== 'SHORT') continue;
      const key = liquidationKey(symbol, ts, side, event);
      if (seenLiquidations.has(key)) continue;
      seenLiquidations.add(key);

      const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
      const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
      const eventNotional = Math.abs(eventPrice * eventQty);
      candidates.push({ symbol, key, ts, eventPrice, eventNotional });
    }
  }

  if (!candidates.length) return;

  candidates.sort((a, b) => a.ts - b.ts);
  const { symbol, key, eventPrice, eventNotional } = candidates[0];
  hasAlerted = true;
  lastAlertWindowBySymbol[symbol] = currentWindow;
  // Persist BEFORE Telegram send so restart cannot duplicate this window or
  // allow the same coin in the immediately following 5m window.
  saveState();

  let nextMarket = null;
  try { nextMarket = await findNextMarket(symbol); }
  catch (error) { console.warn(`POLYMARKET LOOKUP FAILED ${symbol}: ${error.message}`); }

  const lines = [
    `🔥 ${symbol} · 5M · DOWN`,
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    nextMarket?.url ? '' : null,
    nextMarket?.url ? `➡️ NEXT · Polymarket 5M\n${nextMarket.url}` : null
  ];

  enqueueAlert(lines.filter(value => value !== null).join('\n'), symbol, key, now);
}

async function main() {
  loadState();
  console.log(`SINGLE SHORT LIQUIDATION MONITOR STARTED; coins=${SYMBOLS.join(',')}; ALERT WINDOW=5M; MARKET BOUNDARIES=:00/:05/:10/...; SHORT ONLY => DOWN; ONE ALERT PER WINDOW; SAME COIN BLOCKED IN NEXT WINDOW; NO MIN VOLUME; NEXT +2 POLYMARKET LINK; no imbalance; no streaks`);
  while (true) {
    const now = Date.now();
    try { await processLiquidations(await fetchAllFeeds(), now); }
    catch (error) { console.warn(`MONITOR LOOP FAILED: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => { console.error(`MONITOR FATAL: ${error.stack || error.message}`); process.exitCode = 1; });