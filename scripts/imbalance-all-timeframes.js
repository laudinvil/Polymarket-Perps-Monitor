const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { findCurrentMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');
const fs = require('fs');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const PERIOD_MS = 5 * 60 * 1000;
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const STATE_FILE = '.monitor-state.json';
const HISTORY_FILE = 'monitor-history.log';
const emptyCounts = () => Object.fromEntries(SYMBOLS.map(s => [s, 0]));
const state = {
  periodStart: null,
  periodEventCount: emptyCounts(),
  previousPeriodCounts: null,
  periodBeforePreviousCounts: null,
  periodBeforeBeforePreviousCounts: null,
  periodBeforeBeforeBeforePreviousCounts: null,
  periodAlreadyAlerted: false,
  lastEvaluatedPeriod: null,
  initialized: false,
  seenLiquidations: new Set(),
  lastAlertAt: null,
  lastAlertSymbol: null,
};
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function periodStart(now) { return Math.floor(now / PERIOD_MS) * PERIOD_MS; }
function eventSide(e) {
  const v = String(e?.side || e?.direction || '').toLowerCase();
  if (v.includes('long') || v === 'buy') return 'LONG';
  if (v.includes('short') || v === 'sell') return 'SHORT';
  return null;
}
function liquidationKey(symbol, ts, side, e) {
  const id = e?.id ?? e?.liquidationId ?? e?.eventId ?? e?.tradeId ?? e?.txHash ?? e?.orderId;
  if (id !== undefined && id !== null && String(id) !== '') return `${symbol}:id:${String(id)}`;
  return [symbol, ts, side, e?.exchange ?? '', e?.price ?? '', e?.qty ?? e?.quantity ?? e?.size ?? '', e?.notional ?? e?.usd ?? e?.value ?? e?.amount ?? ''].join('|');
}
function persistStatus() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(), timeframe: TIMEFRAME, symbols: SYMBOLS,
    periodStart: state.periodStart, periodEventCount: state.periodEventCount,
    previousPeriodCounts: state.previousPeriodCounts,
    periodBeforePreviousCounts: state.periodBeforePreviousCounts,
    periodBeforeBeforePreviousCounts: state.periodBeforeBeforePreviousCounts,
    periodBeforeBeforeBeforePreviousCounts: state.periodBeforeBeforeBeforePreviousCounts,
    periodAlreadyAlerted: state.periodAlreadyAlerted, lastEvaluatedPeriod: state.lastEvaluatedPeriod,
    seenLiquidations: [...state.seenLiquidations].slice(-3000), initialized: state.initialized,
    lastAlertAt: state.lastAlertAt, lastAlertSymbol: state.lastAlertSymbol,
  }, null, 2) + '\n');
}
function appendHistory(r) { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...r }) + '\n'); }
function restoreState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s?.timeframe !== TIMEFRAME || !Array.isArray(s?.symbols) || s.symbols.join(',') !== SYMBOLS.join(',')) return;
    if (!Number.isFinite(Number(s?.periodStart))) return;
    state.periodStart = Number(s.periodStart); state.periodEventCount = emptyCounts();
    for (const symbol of SYMBOLS) state.periodEventCount[symbol] = Number(s?.periodEventCount?.[symbol] || 0);
    if (s?.previousPeriodCounts && typeof s.previousPeriodCounts === 'object') {
      state.previousPeriodCounts = emptyCounts();
      for (const symbol of SYMBOLS) state.previousPeriodCounts[symbol] = Number(s.previousPeriodCounts?.[symbol] || 0);
    }
    if (s?.periodBeforePreviousCounts && typeof s.periodBeforePreviousCounts === 'object') {
      state.periodBeforePreviousCounts = emptyCounts();
      for (const symbol of SYMBOLS) state.periodBeforePreviousCounts[symbol] = Number(s.periodBeforePreviousCounts?.[symbol] || 0);
    }
    if (s?.periodBeforeBeforePreviousCounts && typeof s.periodBeforeBeforePreviousCounts === 'object') {
      state.periodBeforeBeforePreviousCounts = emptyCounts();
      for (const symbol of SYMBOLS) state.periodBeforeBeforePreviousCounts[symbol] = Number(s.periodBeforeBeforePreviousCounts?.[symbol] || 0);
    }
    if (s?.periodBeforeBeforeBeforePreviousCounts && typeof s.periodBeforeBeforeBeforePreviousCounts === 'object') {
      state.periodBeforeBeforeBeforePreviousCounts = emptyCounts();
      for (const symbol of SYMBOLS) state.periodBeforeBeforeBeforePreviousCounts[symbol] = Number(s.periodBeforeBeforeBeforePreviousCounts?.[symbol] || 0);
    }
    state.periodAlreadyAlerted = Boolean(s?.periodAlreadyAlerted);
    state.lastEvaluatedPeriod = Number.isFinite(Number(s?.lastEvaluatedPeriod)) ? Number(s.lastEvaluatedPeriod) : null;
    state.seenLiquidations = new Set(Array.isArray(s?.seenLiquidations) ? s.seenLiquidations : []);
    state.initialized = Boolean(s?.initialized); state.lastAlertAt = s?.lastAlertAt ?? null; state.lastAlertSymbol = s?.lastAlertSymbol ?? null;
    console.log(`STATE RESTORED 5m period=${new Date(state.periodStart).toISOString()} counts=${JSON.stringify(state.periodEventCount)} previous=${state.previousPeriodCounts ? JSON.stringify(state.previousPeriodCounts) : 'none'} beforePrevious=${state.periodBeforePreviousCounts ? JSON.stringify(state.periodBeforePreviousCounts) : 'none'} beforeBeforePrevious=${state.periodBeforeBeforePreviousCounts ? JSON.stringify(state.periodBeforeBeforePreviousCounts) : 'none'} beforeBeforeBeforePrevious=${state.periodBeforeBeforeBeforePreviousCounts ? JSON.stringify(state.periodBeforeBeforeBeforePreviousCounts) : 'none'} evaluated=${state.lastEvaluatedPeriod === null ? 'none' : new Date(state.lastEvaluatedPeriod).toISOString()} seen=${state.seenLiquidations.size}`);
  } catch (e) { console.log(`STATE RESTORE: no usable state (${e.message}); starting fresh`); }
}
async function fetchAllFeeds() {
  const entries = await Promise.all(SYMBOLS.map(async symbol => { try { return [symbol, await fetchSymbolFeed(symbol)]; } catch (e) { console.warn(`FEED ${symbol} FAILED: ${e.message}`); return [symbol, []]; } }));
  return new Map(entries);
}
function collectCurrentPeriodEvents(feeds, now) {
  const current = periodStart(now); let added = 0;
  for (const symbol of SYMBOLS) for (const e of feeds.get(symbol) || []) {
    const ts = normalizeTs(e?.ts); if (!ts || ts < current || ts >= current + PERIOD_MS) continue;
    const side = eventSide(e); if (!side) continue;
    const key = liquidationKey(symbol, ts, side, e); if (state.seenLiquidations.has(key)) continue;
    state.seenLiquidations.add(key); state.periodEventCount[symbol]++; added++;
  }
  return added;
}
function findDisappearance(beforeBeforeBeforePreviousCounts, beforeBeforePreviousCounts, beforePreviousCounts, previousCounts, currentCounts) {
  if (!beforeBeforeBeforePreviousCounts || !beforeBeforePreviousCounts || !beforePreviousCounts || !previousCounts) return null;
  return SYMBOLS.find(symbol =>
    Number(beforeBeforeBeforePreviousCounts?.[symbol] || 0) > 0 &&
    Number(beforeBeforePreviousCounts?.[symbol] || 0) === 0 &&
    Number(beforePreviousCounts?.[symbol] || 0) === 0 &&
    Number(previousCounts?.[symbol] || 0) === 0 &&
    Number(currentCounts?.[symbol] || 0) === 0
  ) || null;
}
function enqueueAlert(symbol, closedPeriod, triggerCounts, empty1Counts, empty2Counts, empty3Counts, empty4Counts) {
  alertSendChain = alertSendChain.then(async () => {
    const wait = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt)); if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const market = await findCurrentMarket(symbol, Date.now(), '5m');
      const message = [
        `🔥 ${symbol} · 5M`,
        `Previous: ${triggerCounts[symbol]} liquidations`,
        'Current: 0 liquidations',
        `Period: ${new Date(closedPeriod).toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour12: false })}`,
        market?.url ? `➡️ CURRENT · Polymarket 5M\n${market.url}` : null,
      ].filter(Boolean).join('\n');
      await sendTelegramMessage(message); lastAlertSentAt = Date.now(); state.lastAlertAt = new Date(lastAlertSentAt).toISOString(); state.lastAlertSymbol = symbol; persistStatus();
      appendHistory({ type: 'liquidation_disappearance_alert', timeframe: '5m', symbol, closedPeriod, triggerCounts: { fourPeriodsAgo: triggerCounts[symbol], emptyPeriod1: empty1Counts[symbol], emptyPeriod2: empty2Counts[symbol], emptyPeriod3: empty3Counts[symbol], emptyPeriod4: empty4Counts[symbol] }, marketUrl: market?.url || null });
      console.log(`5m DISAPPEARANCE ALERT SENT symbol=${symbol} closedPeriod=${new Date(closedPeriod).toISOString()} trigger=${triggerCounts[symbol]}->0->0->0->0 GLOBAL_PERIOD_LOCK=CLOSED market=${market?.url || 'NONE'} marketType=CURRENT`);
    } catch (e) { console.warn(`5m DISAPPEARANCE ALERT FAILED ${symbol}: ${e.message}`); }
  }).catch(e => console.warn(`5m ALERT QUEUE FAILED: ${e.message}`));
}
function initializePeriod(current) {
  if (state.periodStart === null) {
    state.periodStart = current; state.periodEventCount = emptyCounts(); state.periodAlreadyAlerted = false; state.lastEvaluatedPeriod = null; state.seenLiquidations.clear(); persistStatus();
    console.log(`5m MONITOR START ${new Date(current).toISOString()} symbols=${SYMBOLS.join(',')}`); return;
  }
  if (state.periodStart === current) return;
  const closed = state.periodStart; const closedCounts = { ...state.periodEventCount }; const previousCounts = state.previousPeriodCounts; const beforePreviousCounts = state.periodBeforePreviousCounts; const beforeBeforePreviousCounts = state.periodBeforeBeforePreviousCounts; const beforeBeforeBeforePreviousCounts = state.periodBeforeBeforeBeforePreviousCounts;
  const disappearance = findDisappearance(beforeBeforeBeforePreviousCounts, beforeBeforePreviousCounts, beforePreviousCounts, previousCounts, closedCounts);
  state.lastEvaluatedPeriod = closed; state.periodBeforeBeforeBeforePreviousCounts = beforeBeforePreviousCounts ? { ...beforePreviousCounts } : null; state.periodBeforeBeforePreviousCounts = previousCounts ? { ...previousCounts } : null; state.periodBeforePreviousCounts = closedCounts; state.previousPeriodCounts = closedCounts;
  state.periodStart = current; state.periodEventCount = emptyCounts(); state.periodAlreadyAlerted = false; state.seenLiquidations.clear(); persistStatus();
  console.log(`5m PERIOD CHECK closed=${new Date(closed).toISOString()} beforeBeforeBeforePrevious=${beforeBeforeBeforePreviousCounts ? JSON.stringify(beforeBeforeBeforePreviousCounts) : 'NONE'} beforeBeforePrevious=${beforeBeforePreviousCounts ? JSON.stringify(beforeBeforePreviousCounts) : 'NONE'} beforePrevious=${previousCounts ? JSON.stringify(previousCounts) : 'NONE'} previous=${JSON.stringify(closedCounts)} current=${JSON.stringify(closedCounts)} disappearance=${disappearance || 'NONE'} next=${new Date(current).toISOString()}`);
  if (disappearance) { state.periodAlreadyAlerted = true; persistStatus(); console.log(`5m DISAPPEARANCE CLAIMED symbol=${disappearance} trigger=${beforeBeforeBeforePreviousCounts[disappearance]}->0->0->0->0 closedPeriod=${new Date(closed).toISOString()} GLOBAL_PERIOD_LOCK=CLOSED`); enqueueAlert(disappearance, closed, beforeBeforeBeforePreviousCounts, beforeBeforePreviousCounts, beforePreviousCounts, previousCounts, closedCounts); }
}
async function processTimeframe(feeds, now) {
  const current = periodStart(now); initializePeriod(current); const added = collectCurrentPeriodEvents(feeds, now);
  if (!state.initialized) { state.initialized = true; persistStatus(); console.log(`INITIAL 5m DISAPPEARANCE BASELINE READY current=${new Date(current).toISOString()}`); return; }
  if (added) persistStatus();
}
function main() {
  restoreState(); console.log(`5m DISAPPEARANCE MONITOR STARTED; symbols=${SYMBOLS.join(',')}; alert only after four consecutive empty 5m periods following a 5m period with >=1 liquidation; boundary check; one alert per period; alert link=current market.`);
  (async () => { while (true) { const now = Date.now(); try { await processTimeframe(await fetchAllFeeds(), now); } catch (e) { console.warn(`MONITOR LOOP FAILED: ${e.message}`); } await new Promise(r => setTimeout(r, POLL_MS)); } })().catch(e => { console.error(`MONITOR FATAL: ${e.stack || e.message}`); process.exitCode = 1; });
}
main();
