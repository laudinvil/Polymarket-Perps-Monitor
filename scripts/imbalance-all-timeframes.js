const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { findNextMarket } = require('../src/polymarket');
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
  periodHadLiquidations: false,
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
    updatedAt: new Date().toISOString(),
    timeframe: TIMEFRAME,
    symbols: SYMBOLS,
    periodStart: state.periodStart,
    periodEventCount: state.periodEventCount,
    periodHadLiquidations: state.periodHadLiquidations,
    periodAlreadyAlerted: state.periodAlreadyAlerted,
    lastEvaluatedPeriod: state.lastEvaluatedPeriod,
    initialized: state.initialized,
    lastAlertAt: state.lastAlertAt,
    lastAlertSymbol: state.lastAlertSymbol,
  }, null, 2) + '\n');
}
function appendHistory(r) { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...r }) + '\n'); }
function restoreState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s?.timeframe !== TIMEFRAME) return;
    if (!Array.isArray(s?.symbols) || s.symbols.join(',') !== SYMBOLS.join(',')) return;
    if (!Number.isFinite(Number(s?.periodStart))) return;
    state.periodStart = Number(s.periodStart);
    state.periodEventCount = emptyCounts();
    for (const symbol of SYMBOLS) state.periodEventCount[symbol] = Number(s?.periodEventCount?.[symbol] || 0);
    state.periodHadLiquidations = Boolean(s?.periodHadLiquidations) || Object.values(state.periodEventCount).some(Number);
    state.periodAlreadyAlerted = Boolean(s?.periodAlreadyAlerted);
    state.lastEvaluatedPeriod = Number.isFinite(Number(s?.lastEvaluatedPeriod)) ? Number(s.lastEvaluatedPeriod) : null;
    state.initialized = Boolean(s?.initialized);
    state.lastAlertAt = s?.lastAlertAt ?? null;
    state.lastAlertSymbol = s?.lastAlertSymbol ?? null;
    console.log(`STATE RESTORED 5m period=${new Date(state.periodStart).toISOString()} counts=${JSON.stringify(state.periodEventCount)} evaluated=${state.lastEvaluatedPeriod === null ? 'none' : new Date(state.lastEvaluatedPeriod).toISOString()}`);
  } catch (e) {
    console.log(`STATE RESTORE: no usable state (${e.message}); starting fresh`);
  }
}
async function fetchAllFeeds() {
  const entries = await Promise.all(SYMBOLS.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol)]; }
    catch (e) { console.warn(`FEED ${symbol} FAILED: ${e.message}`); return [symbol, []]; }
  }));
  return new Map(entries);
}
function collectCurrentPeriodEvents(feeds, now) {
  const current = periodStart(now);
  let added = 0;
  for (const symbol of SYMBOLS) {
    for (const e of feeds.get(symbol) || []) {
      const ts = normalizeTs(e?.ts);
      if (!ts || ts < current || ts >= current + PERIOD_MS) continue;
      const side = eventSide(e);
      if (!side) continue;
      const key = liquidationKey(symbol, ts, side, e);
      if (state.seenLiquidations.has(key)) continue;
      state.seenLiquidations.add(key);
      state.periodEventCount[symbol]++;
      state.periodHadLiquidations = true;
      added++;
    }
  }
  return added;
}
function findContrarian(counts) {
  const missing = SYMBOLS.filter(symbol => Number(counts?.[symbol] || 0) === 0);
  const active = SYMBOLS.filter(symbol => Number(counts?.[symbol] || 0) > 0);
  return active.length === SYMBOLS.length - 1 && missing.length === 1 ? missing[0] : null;
}
function enqueueAlert(symbol, closedPeriod, counts) {
  alertSendChain = alertSendChain.then(async () => {
    const wait = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (wait) await new Promise(r => setTimeout(r, wait));
    try {
      const market = await findNextMarket(symbol, Date.now(), '5m');
      const message = [
        `🔥 CONTRARIAN · ${symbol} · 5M`,
        'Liquidations: 0',
        `Others: ${SYMBOLS.filter(s => s !== symbol).map(s => `${s} ${counts[s]}`).join(' · ')}`,
        market?.url ? `➡️ NEXT · Polymarket 5M\n${market.url}` : null,
      ].filter(Boolean).join('\n');
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      state.lastAlertAt = new Date(lastAlertSentAt).toISOString();
      state.lastAlertSymbol = symbol;
      persistStatus();
      appendHistory({ type: 'contrarian_alert', timeframe: '5m', symbol, closedPeriod, counts, marketUrl: market?.url || null });
      console.log(`5m CONTRARIAN ALERT SENT symbol=${symbol} closedPeriod=${new Date(closedPeriod).toISOString()}`);
    } catch (e) {
      console.warn(`5m CONTRARIAN ALERT FAILED ${symbol}: ${e.message}`);
    }
  }).catch(e => console.warn(`5m ALERT QUEUE FAILED: ${e.message}`));
}
function initializePeriod(current) {
  if (state.periodStart === null) {
    state.periodStart = current;
    state.periodEventCount = emptyCounts();
    state.periodHadLiquidations = false;
    state.periodAlreadyAlerted = false;
    state.lastEvaluatedPeriod = null;
    state.seenLiquidations.clear();
    persistStatus();
    console.log(`5m MONITOR START ${new Date(current).toISOString()} symbols=${SYMBOLS.join(',')}`);
    return null;
  }
  if (state.periodStart === current) return null;

  const closed = state.periodStart;
  const closedCounts = { ...state.periodEventCount };
  const contrarian = findContrarian(closedCounts);
  state.lastEvaluatedPeriod = closed;
  state.periodStart = current;
  state.periodEventCount = emptyCounts();
  state.periodHadLiquidations = false;
  state.periodAlreadyAlerted = false;
  state.seenLiquidations.clear();
  persistStatus();
  console.log(`5m PERIOD CHECK closed=${new Date(closed).toISOString()} counts=${JSON.stringify(closedCounts)} contrarian=${contrarian || 'NONE'} next=${new Date(current).toISOString()}`);
  if (contrarian) {
    state.periodAlreadyAlerted = true;
    persistStatus();
    console.log(`5m CONTRARIAN CLAIMED symbol=${contrarian} closedPeriod=${new Date(closed).toISOString()} GLOBAL_PERIOD_LOCK=CLOSED`);
    enqueueAlert(contrarian, closed, closedCounts);
  }
  return contrarian;
}
async function processTimeframe(feeds, now) {
  const current = periodStart(now);
  initializePeriod(current);
  const added = collectCurrentPeriodEvents(feeds, now);
  if (!state.initialized) {
    state.initialized = true;
    persistStatus();
    console.log(`INITIAL 5m CONTRARIAN BASELINE READY current=${new Date(current).toISOString()} observed=${state.periodHadLiquidations}`);
    return;
  }
  if (added) persistStatus();
}
function main() {
  restoreState();
  console.log(`5m CONTRARIAN MONITOR STARTED; symbols=${SYMBOLS.join(',')}; alert when exactly one coin has 0 liquidations and all other coins have >=1 in the just-closed 5m period; boundary check; one alert per period.`);
  (async () => {
    while (true) {
      const now = Date.now();
      try { await processTimeframe(await fetchAllFeeds(), now); }
      catch (e) { console.warn(`MONITOR LOOP FAILED: ${e.message}`); }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  })().catch(e => { console.error(`MONITOR FATAL: ${e.stack || e.message}`); process.exitCode = 1; });
}
main();
