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

const state = {
  strategy: 'polymarket-5m-seven-coin-unanimous-direction',
  processedMarkets: {},
  pendingPeriod: null,
  alertedPeriods: {},
  initialized: false
};
let lastOutcomeAttemptAt = 0;
let outcomeCheckInFlight = false;

function periodStart(now) { return Math.floor(now / PERIOD_MS) * PERIOD_MS; }
function appendHistory(record) { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n'); }
function persistState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({
    updatedAt: new Date().toISOString(),
    strategy: state.strategy,
    symbols: SYMBOLS,
    processedMarkets: state.processedMarkets,
    pendingPeriod: state.pendingPeriod,
    alertedPeriods: state.alertedPeriods,
    initialized: state.initialized
  }, null, 2) + '\n');
}
function restoreState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved?.strategy !== state.strategy) throw new Error('Invalid monitor state strategy');
    state.processedMarkets = saved.processedMarkets && typeof saved.processedMarkets === 'object' ? saved.processedMarkets : {};
    state.pendingPeriod = Number.isFinite(Number(saved.pendingPeriod)) ? Number(saved.pendingPeriod) : null;
    state.alertedPeriods = saved.alertedPeriods && typeof saved.alertedPeriods === 'object' ? saved.alertedPeriods : {};
    state.initialized = Boolean(saved.initialized);
    console.log(`STATE RESTORED seven-coin unanimous monitor; processed=${Object.keys(state.processedMarkets).length}`);
  } catch (error) {
    console.error(`STATE RESTORE FATAL: ${error.message}`);
    process.exitCode = 1;
    throw error;
  }
}
function cleanupProcessedMarkets() {
  const entries = Object.entries(state.processedMarkets).sort((a, b) => Number(a[1]?.periodStart || 0) - Number(b[1]?.periodStart || 0));
  if (entries.length > 300) for (const [key] of entries.slice(0, entries.length - 300)) delete state.processedMarkets[key];
  const alerts = Object.entries(state.alertedPeriods).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (alerts.length > 100) for (const [key] of alerts.slice(0, alerts.length - 100)) delete state.alertedPeriods[key];
}
function getWinner(market) {
  const winner = String(market?.winner || '').toUpperCase();
  return winner === 'UP' || winner === 'DOWN' ? winner : null;
}

async function fetchPeriodOutcomes(targetPeriod) {
  if (state.pendingPeriod === targetPeriod && Date.now() - lastOutcomeAttemptAt < OUTCOME_RETRY_MS) return true;
  state.pendingPeriod = targetPeriod;
  lastOutcomeAttemptAt = Date.now();

  const pendingSymbols = SYMBOLS.filter(symbol => !state.processedMarkets[`${symbol}:${targetPeriod}`]);
  if (!pendingSymbols.length) return evaluateCompletedPeriod(targetPeriod);

  const results = await Promise.all(pendingSymbols.map(async symbol => {
    try {
      const market = await findMarketByEpoch(symbol, targetPeriod, '5m');
      if (!market) {
        console.log(`5m OUTCOME ${symbol} period=${new Date(targetPeriod).toISOString()} market=NOT_FOUND`);
        return { symbol, market: null, winner: null };
      }
      const winner = getWinner(market);
      if (!winner) console.log(`5m OUTCOME WAIT ${symbol} period=${new Date(targetPeriod).toISOString()} closed=${Boolean(market.closed)} resolved=${Boolean(market.resolved)} prices=${JSON.stringify(market.outcomePrices || [])}`);
      return { symbol, market, winner };
    } catch (error) {
      console.warn(`5m OUTCOME CHECK FAILED ${symbol}: ${error.message}`);
      return { symbol, market: null, winner: null };
    }
  }));

  results.sort((a, b) => SYMBOLS.indexOf(a.symbol) - SYMBOLS.indexOf(b.symbol));
  for (const { symbol, market, winner } of results) {
    if (!market || !winner) continue;
    const key = `${symbol}:${targetPeriod}`;
    if (state.processedMarkets[key]) continue;
    state.processedMarkets[key] = {
      symbol,
      periodStart: targetPeriod,
      winner,
      marketUrl: market.url || null,
      closedTime: market.closedTime || null,
      processedAt: new Date().toISOString()
    };
    appendHistory({
      type: 'polymarket_5m_resolved_outcome',
      timeframe: '5m',
      symbol,
      periodStart: targetPeriod,
      winner,
      marketUrl: market.url || null,
      closed: Boolean(market.closed),
      resolved: Boolean(market.resolved),
      closedTime: market.closedTime || null
    });
    console.log(`5m OUTCOME COUNTED ${symbol}=${winner} period=${new Date(targetPeriod).toISOString()}`);
  }

  return evaluateCompletedPeriod(targetPeriod);
}

async function evaluateCompletedPeriod(targetPeriod) {
  const outcomes = SYMBOLS.map(symbol => state.processedMarkets[`${symbol}:${targetPeriod}`]?.winner || null);
  if (outcomes.some(winner => !winner)) {
    persistState();
    return false;
  }

  const direction = outcomes[0];
  const unanimous = outcomes.every(winner => winner === direction);
  if (unanimous && !state.alertedPeriods[String(targetPeriod)]) {
    const currentPeriod = periodStart(Date.now());
    let currentMarket = null;
    try { currentMarket = await findMarketByEpoch('BTC', currentPeriod, '5m'); } catch (error) { console.warn(`CURRENT BTC MARKET CHECK FAILED: ${error.message}`); }
    await sendUnanimousAlert(direction, targetPeriod, currentMarket?.url || null);
    state.alertedPeriods[String(targetPeriod)] = { direction, alertedAt: new Date().toISOString(), currentMarketUrl: currentMarket?.url || null };
  }

  state.pendingPeriod = targetPeriod;
  state.initialized = true;
  cleanupProcessedMarkets();
  persistState();
  return true;
}

async function fetchPreviousPeriodOutcomes(currentPeriod) {
  if (outcomeCheckInFlight) return;
  outcomeCheckInFlight = true;
  try {
    const latestTarget = currentPeriod - PERIOD_MS;
    let startTarget = state.pendingPeriod;
    if (!Number.isFinite(Number(startTarget))) {
      const processedPeriods = Object.values(state.processedMarkets).map(x => Number(x?.periodStart)).filter(Number.isFinite);
      startTarget = processedPeriods.length ? Math.max(...processedPeriods) + PERIOD_MS : latestTarget;
    } else {
      const pendingComplete = SYMBOLS.every(symbol => Boolean(state.processedMarkets[`${startTarget}:${symbol}`]));
      if (pendingComplete) startTarget += PERIOD_MS;
    }
    if (startTarget > latestTarget) return;

    const targets = [];
    for (let target = startTarget; target <= latestTarget && targets.length < MAX_BACKFILL_PERIODS; target += PERIOD_MS) targets.push(target);
    if (targets.length > 1) console.log(`5m OUTCOME BACKFILL periods=${targets.length} from=${new Date(targets[0]).toISOString()} to=${new Date(targets[targets.length - 1]).toISOString()}`);
    for (const targetPeriod of targets) {
      const complete = await fetchPeriodOutcomes(targetPeriod);
      if (!complete) break;
    }
    cleanupProcessedMarkets();
    persistState();
  } finally {
    outcomeCheckInFlight = false;
  }
}

async function sendUnanimousAlert(direction, closedPeriod, currentMarketUrl) {
  const message = [
    `🔥 BTC · 5M`,
    `ALL 7 COINS: ${direction}`,
    `BTC closes: ${direction}`,
    `Period: ${new Date(closedPeriod).toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour12: false })} UTC+3`,
    currentMarketUrl ? `➡️ CURRENT · Polymarket 5M\n${currentMarketUrl}` : null
  ].filter(Boolean).join('\n');
  try {
    await sendTelegramMessage(message);
    appendHistory({ type: 'polymarket_5m_unanimous_alert', timeframe: '5m', direction, closedPeriod, currentMarketUrl });
    console.log(`5m UNANIMOUS ALERT SENT BTC=${direction} currentMarket=${currentMarketUrl || 'NOT_FOUND'}`);
  } catch (error) {
    console.warn(`5m UNANIMOUS ALERT FAILED: ${error.message}`);
  }
}

async function process(now) {
  const currentPeriod = periodStart(now);
  await fetchPreviousPeriodOutcomes(currentPeriod);
  if (!state.initialized) console.log(`5m SEVEN-COIN UNANIMOUS MONITOR STARTED; symbols=${SYMBOLS.join(',')}; alert only when all seven resolved in the same direction; alert BTC with current BTC Polymarket 5M market link.`);
}

function main() {
  restoreState();
  (async () => {
    while (true) {
      try { await process(Date.now()); }
      catch (error) { console.warn(`UNANIMOUS MONITOR LOOP FAILED: ${error.message}`); }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  })().catch(error => {
    console.error(`MONITOR FATAL: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

main();
