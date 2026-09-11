const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');
const fs = require('fs');

// Authoritative BTC + ETH + SOL + XRP liquidation monitor.
// 5m periods. Individual liquidation events only.
// Alert on the FIRST NEW liquidation in a 5m period ONLY when the immediately
// preceding 5m period was completely empty.
// GLOBAL RULE: exactly ONE alert maximum for the entire 5m period, regardless
// of which coin triggered it. Once claimed, every later event/coin is suppressed.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP'];
const TIMEFRAME = '5m';
const PERIOD_MS = 5 * 60 * 1000;
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const STATE_FILE = '.monitor-state.json';
const HISTORY_FILE = 'monitor-history.log';

const state = {
  periodStart: null,
  periodEventCount: { BTC: 0, ETH: 0, SOL: 0, XRP: 0 },
  previousPeriodWasEmpty: false,
  periodAlreadyAlerted: false,
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
    periodStart: state.periodStart, periodEventCount: state.periodEventCount,
    previousPeriodWasEmpty: state.previousPeriodWasEmpty,
    periodAlreadyAlerted: state.periodAlreadyAlerted,
    initialized: state.initialized, lastAlertAt: state.lastAlertAt,
    lastAlertSide: state.lastAlertSide, lastAlertSymbol: state.lastAlertSymbol,
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(snapshot, null, 2) + '\n');
}
function appendHistory(record) { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n'); }

function restoreState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved?.timeframe !== TIMEFRAME) return;
    if (Array.isArray(saved?.symbols) && saved.symbols.join(',') !== SYMBOLS.join(',')) return;
    if (Number.isFinite(Number(saved?.periodStart))) state.periodStart = Number(saved.periodStart);
    if (state.periodStart === null) return;
    state.periodEventCount = {
      BTC: Number(saved?.periodEventCount?.BTC || 0),
      ETH: Number(saved?.periodEventCount?.ETH || 0),
      SOL: Number(saved?.periodEventCount?.SOL || 0),
      XRP: Number(saved?.periodEventCount?.XRP || 0),
    };
    state.previousPeriodWasEmpty = Boolean(saved?.previousPeriodWasEmpty);
    state.periodAlreadyAlerted = Boolean(saved?.periodAlreadyAlerted);
    state.initialized = Boolean(saved?.initialized);
    state.lastAlertAt = saved?.lastAlertAt ?? null;
    state.lastAlertSide = saved?.lastAlertSide ?? null;
    state.lastAlertSymbol = saved?.lastAlertSymbol ?? null;
    console.log(`STATE RESTORED period=${new Date(state.periodStart).toISOString()} alreadyAlerted=${state.periodAlreadyAlerted} previousEmpty=${state.previousPeriodWasEmpty}`);
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
function countPeriodEvents(feeds, start) {
  const counts = { BTC: 0, ETH: 0, SOL: 0, XRP: 0 };
  for (const symbol of SYMBOLS) {
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts < start || ts >= start + PERIOD_MS) continue;
      if (!eventSide(event)) continue;
      counts[symbol] += 1;
    }
  }
  return counts;
}
function collectCurrentPeriodEvents(feeds, now) {
  const current = periodStart(now); const candidates = [];
  for (const symbol of SYMBOLS) {
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts < current || ts >= current + PERIOD_MS) continue;
      const side = eventSide(event); if (!side) continue;
      const key = liquidationKey(symbol, ts, side, event);
      if (state.seenLiquidations.has(key)) continue;
      state.seenLiquidations.add(key); state.periodEventCount[symbol] += 1;
      candidates.push({ symbol, side, event, ts, key });
    }
  }
  candidates.sort((a, b) => a.ts - b.ts); return candidates;
}
function enqueueAlert(message, candidate) {
  alertSendChain = alertSendChain.then(async () => {
    const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      await sendTelegramMessage(message); lastAlertSentAt = Date.now();
      state.lastAlertAt = new Date(lastAlertSentAt).toISOString(); state.lastAlertSide = candidate.side; state.lastAlertSymbol = candidate.symbol;
      persistStatus(); appendHistory({ type: 'alert', timeframe: '5m', symbol: candidate.symbol, side: candidate.side, display: displaySide(candidate.side), periodStart: state.periodStart, price: numberValue(candidate.event?.price, candidate.event?.markPrice, candidate.event?.executionPrice), notional: numberValue(candidate.event?.notional, candidate.event?.usd, candidate.event?.value, candidate.event?.amount) });
      console.log(`5m FIRST-LIQUIDATION ALERT SENT ${candidate.symbol} ${candidate.side} display=${displaySide(candidate.side)} predecessorEmpty=true GLOBAL_PERIOD_LOCK=true`);
    } catch (error) { console.warn(`5m ALERT SEND FAILED ${candidate.symbol}: ${error.message}`); }
  }).catch(error => console.warn(`5m ALERT QUEUE FAILED: ${error.message}`));
}

async function processTimeframe(feeds, now) {
  const current = periodStart(now);
  if (state.periodStart === null) {
    state.periodStart = current;
    state.periodEventCount = { BTC: 0, ETH: 0, SOL: 0, XRP: 0 };
    state.periodAlreadyAlerted = false;
    state.seenLiquidations.clear();
    const previousCounts = countPeriodEvents(feeds, current - PERIOD_MS);
    state.previousPeriodWasEmpty = !periodHasEvents(previousCounts);
    console.log(`5m MONITOR START ${new Date(current).toISOString()}; BTC+ETH+SOL+XRP; predecessor=${state.previousPeriodWasEmpty ? 'EMPTY' : 'NON_EMPTY'}`);
  } else if (state.periodStart !== current) {
    const closedPeriodCounts = countPeriodEvents(feeds, state.periodStart);
    const closedPeriodWasEmpty = !periodHasEvents(closedPeriodCounts);
    state.previousPeriodWasEmpty = closedPeriodWasEmpty;
    state.periodStart = current;
    state.periodEventCount = { BTC: 0, ETH: 0, SOL: 0, XRP: 0 };
    state.periodAlreadyAlerted = false;
    state.seenLiquidations.clear();
    persistStatus();
    console.log(`5m PERIOD RESET ${new Date(current).toISOString()} predecessor=${closedPeriodWasEmpty ? 'EMPTY' : 'NON_EMPTY'} source=feed_recount; waiting_for_first_new_liquidation=true; global_alert_lock=OPEN`);
  }

  const newEvents = collectCurrentPeriodEvents(feeds, now);
  if (!state.initialized) {
    state.initialized = true;
    console.log(`INITIAL 5m BASELINE READY; current-period historical events suppressed BTC=${state.periodEventCount.BTC} ETH=${state.periodEventCount.ETH} SOL=${state.periodEventCount.SOL} XRP=${state.periodEventCount.XRP}; predecessorEmpty=${state.previousPeriodWasEmpty}; globalAlertLock=${state.periodAlreadyAlerted ? 'CLOSED' : 'OPEN'}`);
    persistStatus(); return;
  }
  persistStatus();
  if (state.periodAlreadyAlerted) {
    if (newEvents.length) console.log(`5m ALERT SUPPRESSED ${newEvents.length} new event(s); GLOBAL PERIOD ALREADY ALERTED symbol=${state.lastAlertSymbol || 'unknown'} period=${new Date(state.periodStart).toISOString()}`);
    return;
  }
  if (!newEvents.length) return;
  if (!state.previousPeriodWasEmpty) {
    console.log(`5m LIQUIDATION IGNORED ${newEvents.length} new event(s); predecessor was NOT empty; current period remains unalerted`);
    return;
  }

  // Claim the global period lock before async Telegram/Polymarket work.
  const candidate = newEvents[0];
  state.periodAlreadyAlerted = true;
  persistStatus();
  const { symbol, side, event } = candidate;
  const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
  const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
  const eventNotional = numberValue(event?.notional, event?.usd, event?.value, event?.amount, eventPrice * eventQty);
  console.log(`5m FIRST-LIQUIDATION CLAIMED symbol=${symbol} side=${side} display=${displaySide(side)} currentPeriod=${new Date(state.periodStart).toISOString()} rule=empty_predecessor_then_first_new_liquidation GLOBAL_PERIOD_LOCK=CLOSED`);

  const alertNow = Date.now();
  let next5mMarket = null; let next15mMarket = null;
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
  enqueueAlert(message, candidate);
}

function main() {
  restoreState();
  console.log('5m LIQUIDATION MONITOR STARTED; coins=BTC,ETH,SOL,XRP; require EMPTY preceding 5m period; then FIRST NEW liquidation alerts once; EMPTY current period waits; CLOSED periods are feed-recounted across restarts; INDIVIDUAL events only; NO imbalance; NO streaks; EXACTLY ONE GLOBAL ALERT PER 5m PERIOD across ALL coins; later same-coin and other-coin alerts suppressed; next 5m + next 15m market links only');
  (async () => {
    while (true) {
      const now = Date.now();
      try { await processTimeframe(await fetchAllFeeds(), now); } catch (error) { console.warn(`MONITOR LOOP FAILED: ${error.message}`); }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  })().catch(error => { console.error(`MONITOR FATAL: ${error.stack || error.message}`); process.exitCode = 1; });
}
main();
