const { findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');
const fs = require('fs');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const PERIOD_MS = 5 * 60 * 1000;
const POLL_MS = 4000;
const OUTCOME_RETRY_MS = 15000;
const STATE_FILE = '.monitor-state.json';
const HISTORY_FILE = 'monitor-history.log';

const state = {
  strategy: 'polymarket-5m-resolved-outcome-imbalance',
  longCount: 0,
  shortCount: 0,
  imbalance: 0,
  leader: null,
  processedMarkets: {},
  pendingPeriod: null,
  lastTransitionPeriod: null,
  lastTransitionSymbol: null,
  lastTransitionDirection: null,
  initialized: false,
};

let lastOutcomeAttemptAt = 0;
let outcomeCheckInFlight = false;

function periodStart(now) {
  return Math.floor(now / PERIOD_MS) * PERIOD_MS;
}

function appendHistory(record) {
  fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
}

function persistState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    strategy: state.strategy,
    symbols: SYMBOLS,
    longCount: state.longCount,
    shortCount: state.shortCount,
    imbalance: state.imbalance,
    leader: state.leader,
    processedMarkets: state.processedMarkets,
    pendingPeriod: state.pendingPeriod,
    lastTransitionPeriod: state.lastTransitionPeriod,
    lastTransitionSymbol: state.lastTransitionSymbol,
    lastTransitionDirection: state.lastTransitionDirection,
    initialized: state.initialized,
  }, null, 2) + '\n');
}

function restoreState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved?.strategy !== state.strategy) {
      console.log('STATE RESTORE: old strategy state ignored');
      return;
    }
    state.longCount = Number.isFinite(Number(saved.longCount)) ? Number(saved.longCount) : 0;
    state.shortCount = Number.isFinite(Number(saved.shortCount)) ? Number(saved.shortCount) : 0;
    state.imbalance = state.longCount - state.shortCount;
    state.leader = saved.leader || (state.imbalance > 0 ? 'LONG' : state.imbalance < 0 ? 'SHORT' : null);
    state.processedMarkets = saved.processedMarkets && typeof saved.processedMarkets === 'object' ? saved.processedMarkets : {};
    state.pendingPeriod = Number.isFinite(Number(saved.pendingPeriod)) ? Number(saved.pendingPeriod) : null;
    state.lastTransitionPeriod = Number.isFinite(Number(saved.lastTransitionPeriod)) ? Number(saved.lastTransitionPeriod) : null;
    state.lastTransitionSymbol = saved.lastTransitionSymbol || null;
    state.lastTransitionDirection = saved.lastTransitionDirection || null;
    state.initialized = Boolean(saved.initialized);
    console.log(`STATE RESTORED outcome-imbalance LONG=${state.longCount} SHORT=${state.shortCount} IMBALANCE=${state.imbalance} LEADER=${state.leader || '0'}`);
  } catch (error) {
    console.log(`STATE RESTORE: no usable outcome-imbalance state (${error.message}); starting fresh`);
  }
}

function cleanupProcessedMarkets() {
  const entries = Object.entries(state.processedMarkets).sort((a, b) => Number(a[1]?.periodStart || 0) - Number(b[1]?.periodStart || 0));
  if (entries.length <= 300) return;
  for (const [key] of entries.slice(0, entries.length - 300)) delete state.processedMarkets[key];
}

function getWinner(market) {
  const winner = String(market?.winner || '').toUpperCase();
  return winner === 'UP' || winner === 'DOWN' ? winner : null;
}

async function fetchPreviousPeriodOutcomes(currentPeriod) {
  const targetPeriod = currentPeriod - PERIOD_MS;
  if (state.pendingPeriod === targetPeriod && Date.now() - lastOutcomeAttemptAt < OUTCOME_RETRY_MS) return;
  if (outcomeCheckInFlight) return;

  state.pendingPeriod = targetPeriod;
  lastOutcomeAttemptAt = Date.now();
  outcomeCheckInFlight = true;

  try {
    for (const symbol of SYMBOLS) {
      const key = `${symbol}:${targetPeriod}`;
      if (state.processedMarkets[key]) continue;

      try {
        const market = await findMarketByEpoch(symbol, targetPeriod, '5m');
        if (!market) {
          console.log(`5m OUTCOME ${symbol} period=${new Date(targetPeriod).toISOString()} market=NOT_FOUND`);
          continue;
        }

        const winner = getWinner(market);
        if (!winner) {
          console.log(`5m OUTCOME WAIT ${symbol} period=${new Date(targetPeriod).toISOString()} closed=${Boolean(market.closed)} resolved=${Boolean(market.resolved)} prices=${JSON.stringify(market.outcomePrices || [])}`);
          continue;
        }

        const beforeLong = state.longCount;
        const beforeShort = state.shortCount;
        const beforeImbalance = state.imbalance;
        const beforeLeader = state.leader;

        if (winner === 'UP') state.longCount += 1;
        else state.shortCount += 1;
        state.imbalance = state.longCount - state.shortCount;
        const afterLeader = state.imbalance > 0 ? 'LONG' : state.imbalance < 0 ? 'SHORT' : null;
        const crossedToNewLeader = Boolean(afterLeader && beforeLeader && afterLeader !== beforeLeader);

        state.processedMarkets[key] = { symbol, periodStart: targetPeriod, winner, marketUrl: market.url || null, processedAt: new Date().toISOString() };

        appendHistory({
          type: 'polymarket_5m_resolved_outcome',
          timeframe: '5m', symbol, periodStart: targetPeriod, winner,
          marketUrl: market.url || null,
          closed: Boolean(market.closed), resolved: Boolean(market.resolved),
          outcomes: market.outcomes || [], outcomePrices: market.outcomePrices || [],
          beforeLong, beforeShort, beforeImbalance,
          afterLong: state.longCount, afterShort: state.shortCount, afterImbalance: state.imbalance,
          beforeLeader, afterLeader, crossedToNewLeader,
        });

        console.log(`5m OUTCOME COUNTED ${symbol}=${winner} | LONG ${beforeLong}->${state.longCount} SHORT ${beforeShort}->${state.shortCount} IMBALANCE ${beforeImbalance}->${state.imbalance} LEADER ${beforeLeader || '0'}->${afterLeader || '0'}`);

        if (crossedToNewLeader) {
          state.lastTransitionPeriod = targetPeriod;
          state.lastTransitionSymbol = symbol;
          state.lastTransitionDirection = winner;
          console.log(`5m IMBALANCE FLIP ${symbol} caused ${beforeLeader}->${afterLeader} | LONG=${state.longCount} SHORT=${state.shortCount} IMBALANCE=${state.imbalance}`);
          await sendTransitionAlert(symbol, winner, targetPeriod, state.longCount, state.shortCount, state.imbalance, market.url || null);
        }

        state.leader = afterLeader;
        state.initialized = true;
        persistState();
      } catch (error) {
        console.warn(`5m OUTCOME CHECK FAILED ${symbol}: ${error.message}`);
      }
    }

    cleanupProcessedMarkets();
    persistState();
  } finally {
    outcomeCheckInFlight = false;
  }
}

async function sendTransitionAlert(symbol, direction, marketPeriod, longCount, shortCount, imbalance, marketUrl) {
  const leader = imbalance > 0 ? 'LONG / UP' : 'SHORT / DOWN';
  const message = [
    `🔥 ${symbol} · 5M IMBALANCE FLIP`,
    `Outcome: ${direction}`,
    `Leader changed to: ${leader}`,
    `LONG / UP: ${longCount}`,
    `SHORT / DOWN: ${shortCount}`,
    `IMBALANCE: ${imbalance > 0 ? '+' : ''}${imbalance}`,
    `Period: ${new Date(marketPeriod).toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour12: false })} UTC+3`,
    marketUrl ? `➡️ CLOSED · Polymarket 5M\n${marketUrl}` : null,
  ].filter(Boolean).join('\n');

  try {
    await sendTelegramMessage(message);
    appendHistory({ type: 'polymarket_5m_imbalance_alert', timeframe: '5m', symbol, direction, longCount, shortCount, imbalance, leader, marketPeriod, marketUrl });
    console.log(`5m IMBALANCE ALERT SENT ${symbol} direction=${direction} LONG=${longCount} SHORT=${shortCount} IMBALANCE=${imbalance}`);
  } catch (error) {
    console.warn(`5m IMBALANCE ALERT FAILED ${symbol}: ${error.message}`);
  }
}

async function process(now) {
  const currentPeriod = periodStart(now);
  await fetchPreviousPeriodOutcomes(currentPeriod);
  if (!state.initialized) console.log(`5m RESOLVED-OUTCOME IMBALANCE MONITOR STARTED; symbols=${SYMBOLS.join(',')}; cumulative UP/LONG vs DOWN/SHORT counts; alert only when the global leader flips through zero.`);
}

function main() {
  restoreState();
  (async () => {
    while (true) {
      try { await process(Date.now()); }
      catch (error) { console.warn(`OUTCOME IMBALANCE LOOP FAILED: ${error.message}`); }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  })().catch(error => {
    console.error(`MONITOR FATAL: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

main();
