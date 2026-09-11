const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');
const fs = require('fs');

// Authoritative BTC + ETH + SOL + XRP liquidation monitor.
// 5m periods. Individual liquidation events only.
// RULE: exactly ONE global alert maximum for a 5m period across ALL coins.
// A new period may alert only when the immediately preceding period had NO
// liquidation events AND NO alert. The alert lock is persisted independently
// of any MarginPad feed recount, so a restart cannot forget the previous alert.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const TIMEFRAME = '5m';
const PERIOD_MS = 5 * 60 * 1000;
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const STATE_FILE = '.monitor-state.json';
const HISTORY_FILE = 'monitor-history.log';

const emptyCounts = () => ({ BTC: 0, ETH: 0, SOL: 0, XRP: 0 });
const state = {
  periodStart: null,
  periodEventCount: emptyCounts(),
  periodHadLiquidations: false,
  previousPeriodWasEmpty: false,
  previousPeriodHadAlert: false,
  periodAlreadyAlerted: false,
  alertPeriodStart: null,
  initialized: false,
  seenLiquidations: new Set(),
  lastAlertAt: null,
  lastAlertSide: null,
  lastAlertSymbol: null,
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
function displaySide(side) { return side === 'LONG' ? 'DOWN' : 'UP'; }
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
function periodHasEvents(counts) { return SYMBOLS.some(symbol => Number(counts?.[symbol] || 0) > 0); }

function persistStatus() {
  const snapshot = {
    updatedAt: new Date().toISOString(), timeframe: TIMEFRAME, symbols: SYMBOLS,
    periodStart: state.periodStart,
    periodEventCount: state.periodEventCount,
    periodHadLiquidations: state.periodHadLiquidations,
    previousPeriodWasEmpty: state.previousPeriodWasEmpty,
    previousPeriodHadAlert: state.previousPeriodHadAlert,
    periodAlreadyAlerted: state.periodAlreadyAlerted,
    alertPeriodStart: state.alertPeriodStart,
    initialized: state.initialized,
    lastAlertAt: state.lastAlertAt,
    lastAlertSide: state.lastAlertSide,
    lastAlertSymbol: state.lastAlertSymbol,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2) + '\n');
}
function appendHistory(record) { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n'); }

function restoreState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved?.timeframe !== TIMEFRAME) return;
    if (Array.isArray(saved?.symbols) && saved.symbols.join(',') !== SYMBOLS.join(',')) return;
    if (!Number.isFinite(Number(saved?.periodStart))) return;

    state.periodStart = Number(saved.periodStart);
    state.periodEventCount = {
      BTC: Number(saved?.periodEventCount?.BTC || 0),
      ETH: Number(saved?.periodEventCount?.ETH || 0),
      SOL: Number(saved?.periodEventCount?.SOL || 0),
      XRP: Number(saved?.periodEventCount?.XRP || 0),
    };
    state.periodHadLiquidations = Boolean(saved?.periodHadLiquidations) || periodHasEvents(state.periodEventCount);
    state.previousPeriodWasEmpty = Boolean(saved?.previousPeriodWasEmpty);
    state.previousPeriodHadAlert = Boolean(saved?.previousPeriodHadAlert);
    state.periodAlreadyAlerted = Boolean(saved?.periodAlreadyAlerted);
    state.alertPeriodStart = Number.isFinite(Number(saved?.alertPeriodStart)) ? Number(saved.alertPeriodStart) : null;
    state.initialized = Boolean(saved?.initialized);
    state.lastAlertAt = saved?.lastAlertAt ?? null;
    state.lastAlertSide = saved?.lastAlertSide ?? null;
    state.lastAlertSymbol = saved?.lastAlertSymbol ?? null;

    console.log(`STATE RESTORED period=${new Date(state.periodStart).toISOString()} periodAlert=${state.periodAlreadyAlerted} alertPeriodStart=${state.alertPeriodStart === null ? 'none' : new Date(state.alertPeriodStart).toISOString()} periodHadLiquidations=${state.periodHadLiquidations}`);
  } catch (error) {
    console.log(`STATE RESTORE: no usable state (${error.message}); starting fresh`);
  }
}

async function fetchAllFeeds() {
  const feeds = new Map();
  for (const symbol of SYMBOLS) {
    try { feeds.set(symbol, await fetchSymbolFeed(symbol)); }
    catch (error) { console.warn(`FEED ${symbol} FAILED: ${error.message}`); feeds.set(symbol, []); }
  }
  return feeds;
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
      state.periodEventCount[symbol] += 1;
      state.periodHadLiquidations = true;
      candidates.push({ symbol, side, event, ts, key });
    }
  }
  candidates.sort((a, b) => a.ts - b.ts);
  return candidates;
}

function enqueueAlert(message, candidate, claimedPeriod) {
  alertSendChain = alertSendChain.then(async () => {
    const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      state.lastAlertAt = new Date(lastAlertSentAt).toISOString();
      state.lastAlertSide = candidate.side;
      state.lastAlertSymbol = candidate.symbol;
      persistStatus();
      appendHistory({ type: 'alert', timeframe: '5m', symbol: candidate.symbol, side: candidate.side, display: displaySide(candidate.side), periodStart: claimedPeriod, alertPeriodStart: claimedPeriod, price: numberValue(candidate.event?.price, candidate.event?.markPrice, candidate.event?.executionPrice), notional: numberValue(candidate.event?.notional, candidate.event?.usd, candidate.event?.value, candidate.event?.amount) });
      console.log(`5m ALERT SENT ${candidate.symbol} ${candidate.side} period=${new Date(claimedPeriod).toISOString()} ALERT_PERIOD_LOCK=${claimedPeriod}`);
    } catch (error) {
      console.warn(`5m ALERT SEND FAILED ${candidate.symbol}: ${error.message}`);
    }
  }).catch(error => console.warn(`5m ALERT QUEUE FAILED: ${error.message}`));
}

function initializePeriodFromStateOrSafeBaseline(feeds, current) {
  if (state.periodStart === null) {
    state.periodStart = current;
    state.periodEventCount = emptyCounts();
    state.periodHadLiquidations = false;
    state.periodAlreadyAlerted = false;
    state.alertPeriodStart = null;
    state.seenLiquidations.clear();

    // Only use a feed check when there is no persisted period state at all.
    // Once state exists, alert history is authoritative and is never replaced
    // by a partial MarginPad feed response.
    const previousCounts = emptyCounts();
    for (const symbol of SYMBOLS) {
      for (const event of feeds.get(symbol) || []) {
        const ts = normalizeTs(event?.ts);
        if (ts && ts >= current - PERIOD_MS && ts < current && eventSide(event)) previousCounts[symbol] += 1;
      }
    }
    state.previousPeriodWasEmpty = !periodHasEvents(previousCounts);
    state.previousPeriodHadAlert = false;
    console.log(`5m MONITOR START ${new Date(current).toISOString()} predecessor=${state.previousPeriodWasEmpty ? 'EMPTY' : 'NON_EMPTY'} source=initial_feed_only`);
    persistStatus();
    return;
  }

  if (state.periodStart === current) return;

  const closedPeriod = state.periodStart;
  const closedHadAlert = state.alertPeriodStart === closedPeriod || state.periodAlreadyAlerted;
  const closedHadLiquidations = state.periodHadLiquidations || periodHasEvents(state.periodEventCount);
  const gap = current - closedPeriod;

  // If exactly one period elapsed, the persisted state is authoritative.
  // If more than one period elapsed, we cannot prove the immediately previous
  // period was empty, so fail closed and require an observed empty period.
  const immediatelyPrevious = gap === PERIOD_MS;
  state.previousPeriodHadAlert = closedHadAlert && immediatelyPrevious;
  state.previousPeriodWasEmpty = immediatelyPrevious && !closedHadAlert && !closedHadLiquidations;

  state.periodStart = current;
  state.periodEventCount = emptyCounts();
  state.periodHadLiquidations = false;
  state.periodAlreadyAlerted = false;
  state.alertPeriodStart = state.alertPeriodStart;
  state.seenLiquidations.clear();

  persistStatus();
  console.log(`5m PERIOD RESET ${new Date(current).toISOString()} previousPeriod=${new Date(closedPeriod).toISOString()} previousAlert=${state.previousPeriodHadAlert} previousLiquidations=${closedHadLiquidations} predecessor=${state.previousPeriodWasEmpty ? 'EMPTY' : 'NON_EMPTY'} source=PERSISTED_STATE global_alert_lock=${state.previousPeriodHadAlert ? 'BLOCKED' : 'OPEN'}`);
}

async function processTimeframe(feeds, now) {
  const current = periodStart(now);
  initializePeriodFromStateOrSafeBaseline(feeds, current);

  const newEvents = collectCurrentPeriodEvents(feeds, now);

  if (!state.initialized) {
    state.initialized = true;
    persistStatus();
    console.log(`INITIAL 5m BASELINE READY current=${new Date(current).toISOString()} observed=${state.periodHadLiquidations} predecessorEmpty=${state.previousPeriodWasEmpty} previousPeriodHadAlert=${state.previousPeriodHadAlert}`);
    return;
  }

  persistStatus();

  if (state.previousPeriodHadAlert) {
    if (newEvents.length) console.log(`5m ALERT SUPPRESSED ${newEvents.length} event(s); PREVIOUS_PERIOD_ALERT_LOCK=true previousAlertPeriod=${new Date(state.periodStart - PERIOD_MS).toISOString()} current=${new Date(state.periodStart).toISOString()}`);
    return;
  }

  if (state.periodAlreadyAlerted) {
    if (newEvents.length) console.log(`5m ALERT SUPPRESSED ${newEvents.length} event(s); GLOBAL_PERIOD_LOCK=true symbol=${state.lastAlertSymbol || 'unknown'} period=${new Date(state.periodStart).toISOString()}`);
    return;
  }

  if (!newEvents.length) return;

  if (!state.previousPeriodWasEmpty) {
    console.log(`5m LIQUIDATION IGNORED ${newEvents.length} event(s); predecessor was NOT EMPTY; no alert allowed for current period`);
    return;
  }

  // Claim before any async lookup/send. This is the durable one-alert-per-period lock.
  const candidate = newEvents[0];
  const claimedPeriod = state.periodStart;
  state.periodAlreadyAlerted = true;
  state.alertPeriodStart = claimedPeriod;
  persistStatus();

  const { symbol, side, event } = candidate;
  const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
  const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
  const eventNotional = numberValue(event?.notional, event?.usd, event?.value, event?.amount, eventPrice * eventQty);
  console.log(`5m ALERT CLAIMED symbol=${symbol} side=${side} period=${new Date(claimedPeriod).toISOString()} alertPeriodStart=${claimedPeriod} rule=PREVIOUS_PERIOD_EMPTY_AND_NO_ALERT GLOBAL_PERIOD_LOCK=CLOSED`);

  const alertNow = Date.now();
  let next5mMarket = null;
  let next15mMarket = null;
  try { next5mMarket = await findNextMarket(symbol, alertNow, '5m'); console.log(`POLYMARKET NEXT ${symbol} 5m=${next5mMarket?.url ?? 'UNAVAILABLE'}`); }
  catch (error) { console.warn(`POLYMARKET NEXT LOOKUP FAILED 5m ${symbol}: ${error.message}`); }
  try { next15mMarket = await findNextMarket(symbol, alertNow, '15m'); console.log(`POLYMARKET NEXT ${symbol} 15m=${next15mMarket?.url ?? 'UNAVAILABLE'}`); }
  catch (error) { console.warn(`POLYMARKET NEXT LOOKUP FAILED 15m ${symbol}: ${error.message}`); }

  const message = [
    `🔥 ${symbol} · 5M`,
    displaySide(side),
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    next5mMarket?.url ? `➡️ NEXT · Polymarket 5M\n${next5mMarket.url}` : null,
    next15mMarket?.url ? `➡️ NEXT · Polymarket 15M\n${next15mMarket.url}` : null,
  ].filter(Boolean).join('\n');

  enqueueAlert(message, candidate, claimedPeriod);
}

function main() {
  restoreState();
  console.log('5m LIQUIDATION MONITOR STARTED; coins=BTC,ETH,SOL,XRP; EXACTLY ONE GLOBAL ALERT PER 5m PERIOD; alertPeriodStart persisted; previous-period alert lock survives restart; no feed recount can reopen a locked period; later same-coin and other-coin alerts suppressed.');
  (async () => {
    while (true) {
      const now = Date.now();
      try { await processTimeframe(await fetchAllFeeds(), now); }
      catch (error) { console.warn(`MONITOR LOOP FAILED: ${error.message}`); }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  })().catch(error => { console.error(`MONITOR FATAL: ${error.stack || error.message}`); process.exitCode = 1; });
}
main();
