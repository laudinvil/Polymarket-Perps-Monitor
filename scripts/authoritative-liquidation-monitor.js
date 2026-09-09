const fs = require('fs');
const path = require('path');
const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { bucketStart, findMarketByEpoch, TIMEFRAMES } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// AUTHORITATIVE: individual liquidations only.
// Liquidation in 5m window N creates a pending candidate; NO alert is sent in N.
// Wait through N+1 and N+2. At each later 5m boundary, check the just-completed window.
// If the completed window is clean, send the oldest pending candidate whose waiting period is complete.
// If the completed window contains any liquidation, do NOT send; the candidate continues waiting.
// One alert total per 5m window. LONG => UP; SHORT => DOWN.
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
    fs.writeFileSync(STATE_FILE, JSON.stringify({ alertWindowStart, hasAlerted, pendingBySymbol, seenLiquidations: Array.from(seenLiquidations).slice(-10000), updatedAt: Date.now() }, null, 2));
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

function numberValue(...values) { for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; } return 0; }
function money(value) { return `$${Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }
function price(value) { return Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 8 }); }

async function fetchAllFeeds() {
  const results = await Promise.all(SYMBOLS.map(async symbol => { try { return [symbol, await fetchSymbolFeed(symbol)]; } catch (error) { console.warn(`FEED ${symbol} FAILED: ${error.message}`); return [symbol, []]; } }));
  return new Map(results);
}

async function findCurrentMarket(symbol) { return findMarketByEpoch(symbol, bucketStart(Date.now(), TIMEFRAME), TIMEFRAME); }
async function findNextMarket(symbol) { return findMarketByEpoch(symbol, bucketStart(Date.now(), TIMEFRAME) + FIVE_MINUTE_MS, TIMEFRAME); }

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
  for (const symbol of SYMBOLS) for (const event of feeds.get(symbol) || []) {
    const ts = normalizeTs(event?.ts);
    if (!ts || ts >= now || ts <= startupTs) continue;
    const side = eventSide(event);
    if (side !== 'LONG' && side !== 'SHORT') continue;
    const key = liquidationKey(symbol, ts, side, event);
    if (seenLiquidations.has(key)) continue;
    seenLiquidations.add(key);
    const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
    const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
    const list = bySymbol.get(symbol) || [];
    list.push({ symbol, side, key, ts, eventPrice, eventNotional: Math.abs(eventPrice * eventQty) });
    bySymbol.set(symbol, list);
  }
  return bySymbol;
}

function hasLiquidationInWindow(feeds, start, end) {
  for (const symbol of SYMBOLS) for (const event of feeds.get(symbol) || []) {
    const ts = normalizeTs(event?.ts);
    if (!ts || ts < start || ts >= end) continue;
    const side = eventSide(event);
    if (side === 'LONG' || side === 'SHORT') return true;
  }
  return false;
}

async function processLiquidations(feeds, now) {
  const currentWindow = alignedWindowStart(now);
  const completedWindow = currentWindow - FIVE_MINUTE_MS;

  if (alertWindowStart !== currentWindow) {
    alertWindowStart = currentWindow;
    hasAlerted = false;
    saveState();
    console.log(`5M WINDOW RESET ${new Date(currentWindow).toISOString()}`);
  }

  const newLiquidations = collectNewLiquidations(feeds, now);
  if (!initialized) { initialized = true; saveState(); return; }

  // The completed window is the decision gate. A clean completed window permits the oldest
  // pending candidate that has already waited through its required N+1 and N+2 windows.
  // Any liquidation in the completed window keeps the candidate pending for another check.
  if (!hasAlerted) {
    const candidates = SYMBOLS.map(symbol => {
      const pending = pendingBySymbol[symbol];
      if (!pending) return null;
      const sourceWindow = Number(pending.sourceWindow);
      if (!Number.isFinite(sourceWindow) || completedWindow < sourceWindow + (3 * FIVE_MINUTE_MS)) return null;
      return { symbol, ...pending };
    }).filter(Boolean);

    if (candidates.length) {
      if (hasLiquidationInWindow(feeds, completedWindow, currentWindow)) {
        console.log(`5M WAIT CONTINUES completedWindow=${new Date(completedWindow).toISOString()} liquidationFound=true candidates=${candidates.map(x => x.symbol).join(',')}`);
      } else {
        candidates.sort((a, b) => a.sourceWindow - b.sourceWindow || a.symbol.localeCompare(b.symbol));
        const selected = candidates[0];
        const { symbol, side, key, eventPrice, eventNotional } = selected;
        hasAlerted = true;
        delete pendingBySymbol[symbol];
        saveState();

        let currentMarket = null;
        try { currentMarket = await findCurrentMarket(symbol); } catch (error) { console.warn(`POLYMARKET CURRENT LOOKUP FAILED ${symbol}: ${error.message}`); }
        let nextMarket = null;
        try { nextMarket = await findNextMarket(symbol); } catch (error) { console.warn(`POLYMARKET NEXT LOOKUP FAILED ${symbol}: ${error.message}`); }

        const lines = [
          `🔥 ${symbol} · 5M`,
          `Volume: ${money(eventNotional)}`,
          `Price: ${price(eventPrice)}`,
          currentMarket?.url ? `➡️ CURRENT · Polymarket 5M\n${currentMarket.url}` : null,
          nextMarket?.url ? `➡️ NEXT · Polymarket 5M\n${nextMarket.url}` : null
        ];
        enqueueAlert(lines.filter(Boolean).join('\n'), symbol, side, key, now);
      }
    }
  }

  // Any liquidation in the current window becomes a new pending candidate.
  for (const [symbol, events] of newLiquidations.entries()) {
    const currentEvents = events.filter(event => event.ts >= currentWindow && event.ts < currentWindow + FIVE_MINUTE_MS);
    if (!currentEvents.length) continue;
    currentEvents.sort((a, b) => a.ts - b.ts);
    const event = currentEvents[0];
    if (!pendingBySymbol[symbol]) {
      pendingBySymbol[symbol] = { sourceWindow: currentWindow, key: event.key, side: event.side, eventPrice: event.eventPrice, eventNotional: event.eventNotional };
      console.log(`5M PENDING ${symbol} sourceWindow=${new Date(currentWindow).toISOString()} side=${event.side}`);
    }
  }

  saveState();
}

async function main() {
  loadState();
  console.log(`SINGLE LIQUIDATION MONITOR STARTED; coins=${SYMBOLS.join(',')}; ALERT WINDOW=5M; LIQUIDATION IN N => NO ALERT; WAIT FULL N+1 AND N+2; IF N+3 CLEAN => ALERT; IF N+3 HAS LIQUIDATION => CONTINUE WAITING; LINK=CURRENT+NEXT MARKET; LONG=>UP; SHORT=>DOWN; ONE ALERT PER WINDOW; no imbalance; no streaks`);
  while (true) {
    const now = Date.now();
    try { await processLiquidations(await fetchAllFeeds(), now); } catch (error) { console.warn(`MONITOR LOOP FAILED: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
main().catch(error => { console.error(`MONITOR FATAL: ${error.stack || error.message}`); process.exitCode = 1; });