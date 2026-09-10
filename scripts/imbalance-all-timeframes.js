const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { findNextMarket, findCurrentMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');
const fs = require('fs');

// Authoritative BTC-only liquidation monitor.
// 5m periods. Individual liquidation events only.
// Alert on the FIRST liquidation after one or more completely empty 5m periods.
// A partial period is NEVER eligible to be confirmed as empty.
const SYMBOLS = ['BTC'];
const TIMEFRAME = '5m';
const PERIOD_MS = 5 * 60 * 1000;
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const STATE_FILE = '.monitor-state.json';
const HISTORY_FILE = 'monitor-history.log';

const state = {
  periodStart: null,
  periodEventCount: 0,
  armedAfterEmptyPeriod: false,
  periodAlreadyAlerted: false,
  initialized: false,
  seenLiquidations: new Set(),
  lastAlertAt: null,
  lastAlertSide: null,
};
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function periodStart(now) { return Math.floor(now / PERIOD_MS) * PERIOD_MS; }
function eventSide(event) {
  const value = String(event?.side || event?.direction || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 'LONG';
  if (value.includes('short') || value === 'sell') return 'SHORT';
  return null;
}
function displaySide(side) { return side === 'LONG' ? 'UP' : 'DOWN'; }
function liquidationKey(symbol, ts, side, event) {
  const id = event?.id ?? event?.liquidationId ?? event?.eventId ?? event?.tradeId ?? event?.txHash ?? event?.orderId;
  if (id !== undefined && id !== null && String(id) !== '') return `${symbol}:id:${String(id)}`;
  return [symbol, ts, side, event?.exchange ?? '', event?.price ?? '', event?.qty ?? event?.quantity ?? event?.size ?? '', event?.notional ?? event?.usd ?? event?.value ?? event?.amount ?? ''].join('|');
}
function numberValue(...values) {
  for (const value of values) { const n = Number(value); if (Number.isFinite(n)) return n; }
  return 0;
}
function money(value) { return `$${Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }
function price(value) { return Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 8 }); }
function persistStatus() {
  const snapshot = {
    updatedAt: new Date().toISOString(),
    timeframe: TIMEFRAME,
    symbol: 'BTC',
    periodStart: state.periodStart,
    periodEventCount: state.periodEventCount,
    armedAfterEmptyPeriod: state.armedAfterEmptyPeriod,
    periodAlreadyAlerted: state.periodAlreadyAlerted,
    initialized: state.initialized,
    lastAlertAt: state.lastAlertAt,
    lastAlertSide: state.lastAlertSide,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2) + '\n');
}
function appendHistory(record) {
  fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
}

async function fetchAllFeeds() {
  try { return new Map([['BTC', await fetchSymbolFeed('BTC')]]); }
  catch (error) { console.warn(`FEED BTC FAILED: ${error.message}`); return new Map([['BTC', []]]); }
}
function collectCurrentPeriodEvents(feeds, now) {
  const current = periodStart(now);
  const candidates = [];
  for (const symbol of SYMBOLS) {
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts < current || ts >= current + PERIOD_MS) continue;
      const side = eventSide(event);
      if (!side) continue;
      const key = liquidationKey(symbol, ts, side, event);
      if (state.seenLiquidations.has(key)) continue;
      state.seenLiquidations.add(key);
      state.periodEventCount += 1;
      candidates.push({ symbol, side, event, ts, key });
    }
  }
  candidates.sort((a, b) => a.ts - b.ts);
  return candidates;
}
function enqueueAlert(message, candidate) {
  alertSendChain = alertSendChain.then(async () => {
    const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      state.lastAlertAt = new Date(lastAlertSentAt).toISOString();
      state.lastAlertSide = candidate.side;
      persistStatus();
      appendHistory({ type: 'alert', timeframe: '5m', symbol: candidate.symbol, side: candidate.side, display: displaySide(candidate.side), periodStart: state.periodStart, price: numberValue(candidate.event?.price, candidate.event?.markPrice, candidate.event?.executionPrice), notional: numberValue(candidate.event?.notional, candidate.event?.usd, candidate.event?.value, candidate.event?.amount) });
      console.log(`5m EMPTY-PERIOD ALERT SENT ${candidate.symbol} ${candidate.side} display=${displaySide(candidate.side)}`);
    } catch (error) { console.warn(`5m EMPTY-PERIOD ALERT SEND FAILED ${candidate.symbol}: ${error.message}`); }
  }).catch(error => console.warn(`5m EMPTY-PERIOD ALERT QUEUE FAILED: ${error.message}`));
}

async function processTimeframe(feeds, now) {
  const current = periodStart(now);
  if (state.periodStart === null) {
    state.periodStart = current;
    state.periodEventCount = 0;
    state.armedAfterEmptyPeriod = false;
    state.periodAlreadyAlerted = false;
    state.seenLiquidations.clear();
    persistStatus();
    console.log(`5m EMPTY-PERIOD MONITOR START ${new Date(current).toISOString()}; BTC only; baseline suppresses historical events`);
  } else if (state.periodStart !== current) {
    const completedPeriod = state.periodStart;
    const completedPeriodEnd = completedPeriod + PERIOD_MS;
    if (completedPeriodEnd > now) {
      console.log(`5m PERIOD STILL PARTIAL ${new Date(completedPeriod).toISOString()}-${new Date(completedPeriodEnd).toISOString()}; no empty confirmation`);
      persistStatus();
      return;
    }
    const wasEmpty = state.periodEventCount === 0;
    appendHistory({ type: 'period', timeframe: '5m', symbol: 'BTC', periodStart: completedPeriod, eventCount: state.periodEventCount, empty: wasEmpty });
    if (state.initialized && wasEmpty) {
      state.armedAfterEmptyPeriod = true;
      console.log(`5m EMPTY PERIOD CONFIRMED ${new Date(completedPeriod).toISOString()}; next BTC liquidation will alert`);
    } else if (state.initialized) {
      state.armedAfterEmptyPeriod = false;
      console.log(`5m PERIOD HAD LIQUIDATIONS ${new Date(completedPeriod).toISOString()} count=${state.periodEventCount}; no alert armed`);
    }
    state.periodStart = current;
    state.periodEventCount = 0;
    state.periodAlreadyAlerted = false;
    state.seenLiquidations.clear();
    persistStatus();
    console.log(`5m PERIOD RESET ${new Date(current).toISOString()}`);
  }
  const newEvents = collectCurrentPeriodEvents(feeds, now);
  if (!state.initialized) {
    state.initialized = true;
    console.log(`INITIAL 5m BASELINE READY; current-period historical events suppressed count=${state.periodEventCount}`);
    persistStatus();
    return;
  }
  persistStatus();
  if (!state.armedAfterEmptyPeriod || state.periodAlreadyAlerted || !newEvents.length) return;
  const candidate = newEvents[0];
  state.periodAlreadyAlerted = true;
  state.armedAfterEmptyPeriod = false;
  const { symbol, side, event } = candidate;
  const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
  const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
  const eventNotional = numberValue(event?.notional, event?.usd, event?.value, event?.amount, eventPrice * eventQty);
  console.log(`5m EMPTY-PERIOD CLAIMED symbol=${symbol} side=${side} display=${displaySide(side)} currentPeriod=${new Date(state.periodStart).toISOString()} rule=first_liquidation_after_empty_5m_period`);
  let next5mMarket = null;
  let current15mMarket = null;
  const alertNow = Date.now();
  try { next5mMarket = await findNextMarket(symbol, alertNow, '5m'); console.log(`POLYMARKET NEXT ${symbol} 5m=${next5mMarket?.url ?? 'UNAVAILABLE'}`); }
  catch (error) { console.warn(`POLYMARKET NEXT LOOKUP FAILED 5m ${symbol}: ${error.message}`); }
  try { current15mMarket = await findCurrentMarket(symbol, alertNow, '15m'); console.log(`POLYMARKET CURRENT ${symbol} 15m=${current15mMarket?.url ?? 'UNAVAILABLE'}`); }
  catch (error) { console.warn(`POLYMARKET CURRENT LOOKUP FAILED 15m ${symbol}: ${error.message}`); }
  const message = [
    `🔥 ${symbol} · 5M`, displaySide(side), `Volume: ${money(eventNotional)}`, `Price: ${price(eventPrice)}`,
    next5mMarket?.url ? `➡️ NEXT · Polymarket 5M\n${next5mMarket.url}` : null,
    current15mMarket?.url ? `➡️ CURRENT · Polymarket 15M\n${current15mMarket.url}` : null,
  ].filter(Boolean).join('\n');
  enqueueAlert(message, candidate);
}

async function main() {
  console.log('5m EMPTY-PERIOD LIQUIDATION MONITOR STARTED; coins=BTC only; first liquidation after one or more empty 5m periods; individual events only; no imbalance; no streaks; one alert per armed period; next 5m + current 15m market links; partial periods never qualify as empty');
  while (true) {
    const now = Date.now();
    try { await processTimeframe(await fetchAllFeeds(), now); }
    catch (error) { console.warn(`MONITOR LOOP FAILED: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}
main().catch(error => { console.error(`MONITOR FATAL: ${error.stack || error.message}`); process.exitCode = 1; });