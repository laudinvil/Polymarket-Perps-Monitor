const { findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');
const fs = require('fs');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const PERIOD_MS = 5 * 60 * 1000;
const POLL_MS = 4000;
const OUTCOME_RETRY_MS = 15000;
const MAX_BACKFILL_PERIODS = 24;
const STATE_FILE = '.monitor-state.json';
const HISTORY_FILE = 'monitor-history.log';

const state = { strategy: 'polymarket-5m-resolved-outcome-imbalance', upCount: 0, downCount: 0, imbalance: 0, leader: null, processedMarkets: {}, pendingPeriod: null, lastTransitionPeriod: null, lastTransitionSymbol: null, lastTransitionDirection: null, initialized: false };
let lastOutcomeAttemptAt = 0;
let outcomeCheckInFlight = false;
function periodStart(now) { return Math.floor(now / PERIOD_MS) * PERIOD_MS; }
function appendHistory(record) { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n'); }
function persistState() { fs.writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), strategy: state.strategy, symbols: SYMBOLS, upCount: state.upCount, downCount: state.downCount, imbalance: state.imbalance, leader: state.leader, processedMarkets: state.processedMarkets, pendingPeriod: state.pendingPeriod, lastTransitionPeriod: state.lastTransitionPeriod, lastTransitionSymbol: state.lastTransitionSymbol, lastTransitionDirection: state.lastTransitionDirection, initialized: state.initialized }, null, 2) + '\n'); }
function restoreState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved?.strategy !== state.strategy) throw new Error('Invalid monitor state strategy');
    if (!Number.isInteger(Number(saved.upCount)) || !Number.isInteger(Number(saved.downCount))) throw new Error('Invalid cumulative counts');
    state.upCount = Number(saved.upCount); state.downCount = Number(saved.downCount); state.imbalance = state.upCount - state.downCount;
    state.leader = saved.leader || (state.imbalance > 0 ? 'UP' : state.imbalance < 0 ? 'DOWN' : null);
    state.processedMarkets = saved.processedMarkets && typeof saved.processedMarkets === 'object' ? saved.processedMarkets : {};
    state.pendingPeriod = Number.isFinite(Number(saved.pendingPeriod)) ? Number(saved.pendingPeriod) : null;
    state.lastTransitionPeriod = Number.isFinite(Number(saved.lastTransitionPeriod)) ? Number(saved.lastTransitionPeriod) : null;
    state.lastTransitionSymbol = saved.lastTransitionSymbol || null; state.lastTransitionDirection = saved.lastTransitionDirection || null; state.initialized = Boolean(saved.initialized);
    console.log(`STATE RESTORED outcome-imbalance UP=${state.upCount} DOWN=${state.downCount} IMBALANCE=${state.imbalance} LEADER=${state.leader || '0'}`);
  } catch (error) { console.error(`STATE RESTORE FATAL: ${error.message}`); process.exitCode = 1; throw error; }
}
function cleanupProcessedMarkets() { const entries = Object.entries(state.processedMarkets).sort((a, b) => Number(a[1]?.periodStart || 0) - Number(b[1]?.periodStart || 0)); if (entries.length <= 300) return; for (const [key] of entries.slice(0, entries.length - 300)) delete state.processedMarkets[key]; }
function getWinner(market) { const winner = String(market?.winner || '').toUpperCase(); return winner === 'UP' || winner === 'DOWN' ? winner : null; }
async function fetchPeriodOutcomes(targetPeriod) {
  if (state.pendingPeriod === targetPeriod && Date.now() - lastOutcomeAttemptAt < OUTCOME_RETRY_MS) return true;
  state.pendingPeriod = targetPeriod; lastOutcomeAttemptAt = Date.now();
  const pendingSymbols = SYMBOLS.filter(symbol => !state.processedMarkets[`${symbol}:${targetPeriod}`]);
  if (!pendingSymbols.length) return true;
  const results = await Promise.all(pendingSymbols.map(async symbol => {
    try {
      const market = await findMarketByEpoch(symbol, targetPeriod, '5m');
      if (!market) { console.log(`5m OUTCOME ${symbol} period=${new Date(targetPeriod).toISOString()} market=NOT_FOUND`); return { symbol, market: null, winner: null }; }
      const winner = getWinner(market);
      if (!winner) console.log(`5m OUTCOME WAIT ${symbol} period=${new Date(targetPeriod).toISOString()} closed=${Boolean(market.closed)} resolved=${Boolean(market.resolved)} prices=${JSON.stringify(market.outcomePrices || [])}`);
      return { symbol, market, winner };
    } catch (error) { console.warn(`5m OUTCOME CHECK FAILED ${symbol}: ${error.message}`); return { symbol, market: null, winner: null }; }
  }));
  results.sort((a, b) => { const aTime = Date.parse(a.market?.closedTime || '') || Number.MAX_SAFE_INTEGER; const bTime = Date.parse(b.market?.closedTime || '') || Number.MAX_SAFE_INTEGER; if (aTime !== bTime) return aTime - bTime; return SYMBOLS.indexOf(a.symbol) - SYMBOLS.indexOf(b.symbol); });
  for (const { symbol, market, winner } of results) {
    if (!market || !winner) continue;
    const key = `${symbol}:${targetPeriod}`; if (state.processedMarkets[key]) continue;
    const beforeUp = state.upCount, beforeDown = state.downCount, beforeImbalance = state.imbalance, beforeLeader = state.leader;
    if (winner === 'UP') state.upCount += 1; else state.downCount += 1;
    state.imbalance = state.upCount - state.downCount;
    const afterLeader = state.imbalance > 0 ? 'UP' : state.imbalance < 0 ? 'DOWN' : null;
    const crossedToNewLeader = Boolean(afterLeader && beforeLeader && afterLeader !== beforeLeader);
    state.processedMarkets[key] = { symbol, periodStart: targetPeriod, winner, marketUrl: market.url || null, closedTime: market.closedTime || null, processedAt: new Date().toISOString() };
    appendHistory({ type: 'polymarket_5m_resolved_outcome', timeframe: '5m', symbol, periodStart: targetPeriod, winner, marketUrl: market.url || null, closed: Boolean(market.closed), resolved: Boolean(market.resolved), closedTime: market.closedTime || null, outcomes: market.outcomes || [], outcomePrices: market.outcomePrices || [], beforeUp, beforeDown, beforeImbalance, afterUp: state.upCount, afterDown: state.downCount, afterImbalance: state.imbalance, beforeLeader, afterLeader, crossedToNewLeader });
    console.log(`5m OUTCOME COUNTED ${symbol}=${winner} | UP ${beforeUp}->${state.upCount} DOWN ${beforeDown}->${state.downCount} IMBALANCE ${beforeImbalance}->${state.imbalance} LEADER ${beforeLeader || '0'}->${afterLeader || '0'}`);
    if (crossedToNewLeader) { state.lastTransitionPeriod = targetPeriod; state.lastTransitionSymbol = symbol; state.lastTransitionDirection = winner; console.log(`5m IMBALANCE FLIP ${symbol} caused ${beforeLeader}->${afterLeader} | UP=${state.upCount} DOWN=${state.downCount} IMBALANCE=${state.imbalance}`); await sendTransitionAlert(symbol, winner, targetPeriod, state.upCount, state.downCount, state.imbalance, market.url || null); }
    state.leader = afterLeader; state.initialized = true; persistState();
  }
  const complete = SYMBOLS.every(symbol => Boolean(state.processedMarkets[`${symbol}:${targetPeriod}`]));
  if (complete) state.pendingPeriod = targetPeriod;
  persistState(); return complete;
}
async function fetchPreviousPeriodOutcomes(currentPeriod) {
  if (outcomeCheckInFlight) return; outcomeCheckInFlight = true;
  try {
    const latestTarget = currentPeriod - PERIOD_MS;
    let startTarget = state.pendingPeriod;
    if (!Number.isFinite(Number(startTarget))) {
      const processedPeriods = Object.values(state.processedMarkets).map(x => Number(x?.periodStart)).filter(Number.isFinite);
      startTarget = processedPeriods.length ? Math.max(...processedPeriods) + PERIOD_MS : latestTarget;
    } else {
      const pendingComplete = SYMBOLS.every(symbol => Boolean(state.processedMarkets[`${symbol}:${startTarget}`]));
      if (pendingComplete) startTarget += PERIOD_MS;
    }
    if (startTarget > latestTarget) return;
    const targets = [];
    for (let target = startTarget; target <= latestTarget && targets.length < MAX_BACKFILL_PERIODS; target += PERIOD_MS) targets.push(target);
    if (targets.length > 1) console.log(`5m OUTCOME BACKFILL periods=${targets.length} from=${new Date(targets[0]).toISOString()} to=${new Date(targets[targets.length - 1]).toISOString()}`);
    for (const targetPeriod of targets) { const complete = await fetchPeriodOutcomes(targetPeriod); if (!complete) break; }
    cleanupProcessedMarkets(); persistState();
  } finally { outcomeCheckInFlight = false; }
}
async function sendTransitionAlert(symbol, direction, marketPeriod, upCount, downCount, imbalance, marketUrl) {
  const leader = imbalance > 0 ? 'UP' : 'DOWN';
  const message = [`🔥 ${symbol} · 5M IMBALANCE FLIP`, `Outcome: ${direction}`, `Leader changed to: ${leader}`, `UP: ${upCount}`, `DOWN: ${downCount}`, `IMBALANCE: ${imbalance > 0 ? '+' : ''}${imbalance}`, `Period: ${new Date(marketPeriod).toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour12: false })} UTC+3`, marketUrl ? `➡️ CLOSED · Polymarket 5M\n${marketUrl}` : null].filter(Boolean).join('\n');
  try { await sendTelegramMessage(message); appendHistory({ type: 'polymarket_5m_imbalance_alert', timeframe: '5m', symbol, direction, upCount, downCount, imbalance, leader, marketPeriod, marketUrl }); console.log(`5m IMBALANCE ALERT SENT ${symbol} direction=${direction} UP=${upCount} DOWN=${downCount} IMBALANCE=${imbalance}`); } catch (error) { console.warn(`5m IMBALANCE ALERT FAILED ${symbol}: ${error.message}`); }
}
async function process(now) { const currentPeriod = periodStart(now); await fetchPreviousPeriodOutcomes(currentPeriod); if (!state.initialized) console.log(`5m RESOLVED-OUTCOME IMBALANCE MONITOR STARTED; symbols=${SYMBOLS.join(',')}; cumulative UP vs DOWN counts; alert only when the global leader flips through zero.`); }
function main() { restoreState(); (async () => { while (true) { try { await process(Date.now()); } catch (error) { console.warn(`OUTCOME IMBALANCE LOOP FAILED: ${error.message}`); } await new Promise(resolve => setTimeout(resolve, POLL_MS)); } })().catch(error => { console.error(`MONITOR FATAL: ${error.stack || error.message}`); process.exitCode = 1; }); }
main();
