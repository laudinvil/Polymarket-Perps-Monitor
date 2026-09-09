const fs = require('fs');
const path = require('path');
const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { bucketStart, findMarketByEpoch, TIMEFRAMES } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// AUTHORITATIVE: individual liquidations only.
// Liquidation in 5m window N creates a pending candidate; NO alert is sent in N.
// The ENTIRE immediately following 5m window N+1 must finish before evaluation.
// At the boundary starting N+2, if the same coin had NO liquidation anywhere in N+1,
// send one alert for the next/current Polymarket market. If it liquidated at any point
// in N+1, cancel that pending candidate. One alert total per 5m window.
// LONG => UP; SHORT => DOWN. No minimum volume. No imbalance. No streaks.
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
let pendingBySymbol = {};
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function alignedWindowStart(ts) { return bucketStart(ts, TIMEFRAME); }

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const currentWindow = alignedWindowStart(Date.now());
    if (Number(state.alertWindowStart) === currentWindow) {
      alertWindowStart = currentWindow;
      hasAlerted = Boolean(state.hasAlerted);
    }
    if (state.pendingBySymbol && typeof state.pendingBySymbol === 'object') pendingBySymbol = { ...state.pendingBySymbol };
    for (const key of Array.isArray(state.seenLiquidations) ? state.seenLiquidations : []) if (typeof key === 'string') seenLiquidations.add(key);
    console.log(`ALERT STATE LOADED window=${alertWindowStart ?? 'none'} hasAlerted=${hasAlerted} pending=${Object.keys(pendingBySymbol).length} seen=${seenLiquidations.size}`);
  } catch (error) { console.log(`ALERT STATE INIT: ${error.message}`); }
}

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      alertWindowStart, hasAlerted, pendingBySymbol,
      seenLiquidations: Array.from(seenLiquidations).slice(-10000), updatedAt: Date.now()
    }, null, 2));
  } catch (error) { console.warn(`ALERT STATE SAVE FAILED: ${error.message}`); }
}

function eventSide(event) {
  const value = String(event?.side || event?.direction || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 'LONG';
  if (value.includes('short') || value === 'sell') return 'SHORT';
  return null;
}

function liquidationKey(symbol, ts, side, event) {
  return [symbol, Math.floor(Number(ts) / 1000), side, String(event?.exchange ?? '').toLowerCase(), numberValue(event?.price, event?.markPrice, event?.executionPrice), numberValue(event?.qty, event?.quantity, event?.size)].join('|');
}

function numberValue(...values) {
  for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; }
  return 0;
}
function money(value) { return `$${Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }
function price(value) { return Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 8 }); }

async function fetchAllFeeds() {
  const results = await Promise.all(SYMBOLS.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol)]; }
    catch (error) { console.warn(`FEED ${symbol} FAILED: ${error.message}`); return [symbol, []]; }
  }));
  return new Map(results);
}

async function findCurrentMarket(symbol) {
  const currentBucket = bucketStart(Date.now(), TIMEFRAME);
  return findMarketByEpoch(symbol, currentBucket, TIMEFRAME);
}

async function findNextMarket(symbol) {
  const currentBucket = bucketStart(Date.now(), TIMEFRAME);
  return findMarketByEpoch(symbol, currentBucket + FIVE_MINUTE_MS, TIMEFRAME);
}

function enqueueAlert(message, symbol, side, key, alertDetectedAt) {
  alertSendChain = alertSendChain.then(async () => {
    try {
      const waitMs = Math.max(0, 5000 - (Date.now() - lastAlertSentAt));
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      console.log(`5M ALERT SENT ${symbol} ${side === 'LONG' ? 'UP' : 'DOWN'} key=${key} detectedAt=${new Date(alertDetectedAt).toISOString()} sentAt=${new Date(lastAlertSentAt).toISOString()}`);
    } catch (error) { console.warn(`5M ALERT SEND FAILED ${symbol}: ${error.message}`); }
  }).catch(error => console.warn(`5M ALERT QUEUE FAILED: ${error.message}`));
}

function collectNewLiquidations(feeds, now) {
  const bySymbol = new Map();
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
      const item = { symbol, side, key, ts, eventPrice, eventNotional: Math.abs(eventPrice * eventQty) };
      const list = bySymbol.get(symbol) || [];
      list.push(item);
      bySymbol.set(symbol, list);
    }
  }
  return bySymbol;
}

// IMPORTANT: this checks the raw feed, not seenLiquidations.
// When called for a completed window, windowEnd must be the exact next boundary.
// This prevents a candidate from being evaluated early in N+1.
function hasLiquidationInWindow(feeds, symbol, windowStart, windowEnd) {
  return (feeds.get(symbol) || []).some(event => {
    const ts = normalizeTs(event?.ts);
    if (!ts || ts < windowStart || ts >= windowEnd) return false;
    return eventSide(event) === 'LONG' || eventSide(event) === 'SHORT';
  });
}

async function processLiquidations(feeds, now) {
  const currentWindow = alignedWindowStart(now);
  const previousWindow = currentWindow - FIVE_MINUTE_MS;

  if (alertWindowStart !== currentWindow) {
    alertWindowStart = currentWindow;
    hasAlerted = false;
    saveState();
    console.log(`5M WINDOW RESET ${new Date(currentWindow).toISOString()}`);
  }

  const newLiquidations = collectNewLiquidations(feeds, now);
  if (!initialized) { initialized = true; saveState(); return; }

  // N+1 is now COMPLETE. Evaluate candidates from N only at the N+2 boundary.
  // Therefore a liquidation anywhere in the full N+1 window cancels the candidate.
  for (const symbol of Object.keys(pendingBySymbol)) {
    const pending = pendingBySymbol[symbol];
    if (Number(pending.sourceWindow) !== previousWindow - FIVE_MINUTE_MS) continue;
    const liquidatedInCompletedNextWindow = hasLiquidationInWindow(feeds, symbol, previousWindow, currentWindow);
    if (liquidatedInCompletedNextWindow) {
      console.log(`5M PENDING CANCEL ${symbol}: liquidation in completed next window ${new Date(previousWindow).toISOString()}`);
      delete pendingBySymbol[symbol];
    }
  }

  // Any liquidation in the current window becomes pending. No alert is sent now.
  for (const [symbol, events] of newLiquidations.entries()) {
    const currentEvents = events.filter(event => event.ts >= currentWindow && event.ts < currentWindow + FIVE_MINUTE_MS);
    if (!currentEvents.length) continue;
    currentEvents.sort((a, b) => a.ts - b.ts);
    const event = currentEvents[0];
    pendingBySymbol[symbol] = {
      sourceWindow: currentWindow,
      key: event.key,
      side: event.side,
      eventPrice: event.eventPrice,
      eventNotional: event.eventNotional
    };
    console.log(`5M PENDING ${symbol} sourceWindow=${new Date(currentWindow).toISOString()} side=${event.side}`);
  }

  if (hasAlerted) { saveState(); return; }

  // Only at the boundary N+2: if N had a liquidation and the entire N+1 had none,
  // the candidate is eligible. This is deliberately evaluated against the full raw feed.
  const eligible = SYMBOLS.map(symbol => {
    const pending = pendingBySymbol[symbol];
    if (!pending || Number(pending.sourceWindow) !== previousWindow - FIVE_MINUTE_MS) return null;
    if (hasLiquidationInWindow(feeds, symbol, previousWindow, currentWindow)) return null;
    return { symbol, ...pending };
  }).filter(Boolean);

  if (!eligible.length) { saveState(); return; }

  eligible.sort((a, b) => a.sourceWindow - b.sourceWindow || a.symbol.localeCompare(b.symbol));
  const selected = eligible[0];
  const { symbol, side, key, eventPrice, eventNotional } = selected;
  hasAlerted = true;
  delete pendingBySymbol[symbol];
  saveState();

  let currentMarket = null;
  try { currentMarket = await findCurrentMarket(symbol); }
  catch (error) { console.warn(`POLYMARKET CURRENT LOOKUP FAILED ${symbol}: ${error.message}`); }

  let nextMarket = null;
  try { nextMarket = await findNextMarket(symbol); }
  catch (error) { console.warn(`POLYMARKET NEXT LOOKUP FAILED ${symbol}: ${error.message}`); }

  const lines = [
    `🔥 ${symbol} · 5M`,
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    currentMarket?.url ? `➡️ CURRENT · Polymarket 5M\n${currentMarket.url}` : null,
    nextMarket?.url ? `➡️ NEXT · Polymarket 5M\n${nextMarket.url}` : null
  ];
  enqueueAlert(lines.filter(value => value !== null).join('\n'), symbol, side, key, now);
}

async function main() {
  loadState();
  console.log(`SINGLE LIQUIDATION MONITOR STARTED; coins=${SYMBOLS.join(',')}; ALERT WINDOW=5M; LIQUIDATION IN N => NO ALERT; EVALUATE N+1 ONLY AFTER FULL WINDOW CLOSES; IF NO LIQUIDATION IN FULL N+1 => ALERT AT N+2; LINK=CURRENT+NEXT MARKET; LONG=>UP; SHORT=>DOWN; ONE ALERT PER WINDOW; no imbalance; no streaks`);
  while (true) {
    const now = Date.now();
    try { await processLiquidations(await fetchAllFeeds(), now); }
    catch (error) { console.warn(`MONITOR LOOP FAILED: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
main().catch(error => { console.error(`MONITOR FATAL: ${error.stack || error.message}`); process.exitCode = 1; });
