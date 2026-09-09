const fs = require('fs');
const path = require('path');
const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { bucketStart, findMarketByEpoch, TIMEFRAMES } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// AUTHORITATIVE: individual liquidations only.
// All monitored coins. Internal LONG/SHORT are displayed as DOWN/UP.
// Alert window: 30 minutes, aligned strictly to :15 and :45.
// Alerts are immediate. No next-period ignore. No minimum volume.
// No imbalance. No streaks.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '30m';
const POLL_MS = 4000;
const THIRTY_MINUTE_MS = 30 * 60 * 1000;
const WINDOW_OFFSET_MS = 15 * 60 * 1000;
const STATE_FILE = path.join(__dirname, '..', '.liquidation-alert-state.json');

const seenLiquidations = new Set();
const startupTs = Date.now();
let initialized = false;
let alertWindowStart = null;
let hasAlerted = false;
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function alignedWindowStart(ts) {
  return Math.floor((ts - WINDOW_OFFSET_MS) / THIRTY_MINUTE_MS) * THIRTY_MINUTE_MS + WINDOW_OFFSET_MS;
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const currentWindow = alignedWindowStart(Date.now());
    if (Number(state.alertWindowStart) === currentWindow) {
      alertWindowStart = currentWindow;
      hasAlerted = Boolean(state.hasAlerted);
    }
    for (const key of Array.isArray(state.seenLiquidations) ? state.seenLiquidations : []) {
      if (typeof key === 'string') seenLiquidations.add(key);
    }
    console.log(`ALERT STATE LOADED window=${alertWindowStart ?? 'none'} hasAlerted=${hasAlerted} seen=${seenLiquidations.size}`);
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

function displaySide(side) {
  return side === 'LONG' ? 'DOWN' : side === 'SHORT' ? 'UP' : side;
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
  const currentBucket = bucketStart(now, '5m');
  const nextEpoch = currentBucket + TIMEFRAMES['5m'];
  return findMarketByEpoch(symbol, nextEpoch, '5m');
}

function enqueueAlert(message, symbol, side, key, alertDetectedAt) {
  alertSendChain = alertSendChain.then(async () => {
    try {
      const waitMs = Math.max(0, 5000 - (Date.now() - lastAlertSentAt));
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      console.log(`30M ALERT SENT ${symbol} ${displaySide(side)} key=${key} detectedAt=${new Date(alertDetectedAt).toISOString()} sentAt=${new Date(lastAlertSentAt).toISOString()}`);
    } catch (error) { console.warn(`30M ALERT SEND FAILED ${symbol}: ${error.message}`); }
  }).catch(error => console.warn(`30M ALERT QUEUE FAILED: ${error.message}`));
}

async function processLiquidations(feeds, now) {
  const currentWindow = alignedWindowStart(now);
  if (alertWindowStart !== currentWindow) {
    alertWindowStart = currentWindow;
    hasAlerted = false;
    saveState();
    console.log(`30M WINDOW RESET ${new Date(currentWindow).toISOString()}`);
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
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts >= now || ts <= startupTs) continue;
      const side = eventSide(event);
      if (side !== 'LONG' && side !== 'SHORT') continue;
      const key = liquidationKey(symbol, ts, side, event);
      if (seenLiquidations.has(key)) continue;
      seenLiquidations.add(key);

      const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
      const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
      const eventNotional = Math.abs(eventPrice * eventQty);
      candidates.push({ symbol, side, key, ts, eventPrice, eventNotional });
    }
  }

  if (!candidates.length) return;

  candidates.sort((a, b) => a.ts - b.ts);
  const { symbol, side, key, eventPrice, eventNotional } = candidates[0];
  hasAlerted = true;
  // Persist BEFORE Telegram send so a monitor restart cannot produce another
  // alert inside the same :15/:45 window.
  saveState();

  let nextMarket = null;
  try { nextMarket = await findNextMarket(symbol); }
  catch (error) { console.warn(`POLYMARKET LOOKUP FAILED ${symbol}: ${error.message}`); }

  const lines = [
    `🔥 ${symbol} · 30M · ${displaySide(side)}`,
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    nextMarket?.url ? '' : null,
    nextMarket?.url ? `➡️ NEXT · Polymarket 5M\n${nextMarket.url}` : null
  ];

  enqueueAlert(lines.filter(value => value !== null).join('\n'), symbol, side, key, now);
}

async function main() {
  loadState();
  console.log(`SINGLE LIQUIDATION MONITOR STARTED; coins=${SYMBOLS.join(',')}; ALERT WINDOW=30M; BOUNDARIES=:15/:45; DISPLAY LONG=DOWN SHORT=UP; NO MIN VOLUME; NO NEXT-PERIOD IGNORE; NEXT ONLY POLYMARKET LINK; no imbalance; no streaks`);
  while (true) {
    const now = Date.now();
    try { await processLiquidations(await fetchAllFeeds(), now); }
    catch (error) { console.warn(`MONITOR LOOP FAILED: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => { console.error(`MONITOR FATAL: ${error.stack || error.message}`); process.exitCode = 1; });