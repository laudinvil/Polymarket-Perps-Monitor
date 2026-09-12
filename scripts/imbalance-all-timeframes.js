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
const PAPER_STAKE_USD = 1;

const state = {
  strategy: 'polymarket-5m-seven-coin-unanimous-direction',
  processedMarkets: {},
  pendingPeriod: null,
  alertedPeriods: {},
  paperTrades: {},
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
    paperTrades: state.paperTrades,
    initialized: state.initialized
  }, null, 2) + '\n');
}
function restoreState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved?.strategy !== state.strategy) {
      console.log(`STATE RESET: previous strategy=${saved?.strategy || 'unknown'}; starting unanimous seven-coin monitor from a clean state.`);
      return;
    }
    state.processedMarkets = saved.processedMarkets && typeof saved.processedMarkets === 'object' ? saved.processedMarkets : {};
    state.pendingPeriod = Number.isFinite(Number(saved.pendingPeriod)) ? Number(saved.pendingPeriod) : null;
    state.alertedPeriods = saved.alertedPeriods && typeof saved.alertedPeriods === 'object' ? saved.alertedPeriods : {};
    state.paperTrades = saved.paperTrades && typeof saved.paperTrades === 'object' ? saved.paperTrades : {};
    state.initialized = Boolean(saved.initialized);
    console.log(`STATE RESTORED seven-coin unanimous monitor; processed=${Object.keys(state.processedMarkets).length}; paperTrades=${Object.keys(state.paperTrades).length}`);
  } catch (error) {
    console.log(`STATE RESET: no compatible previous state (${error.message}); starting clean.`);
  }
}
function cleanupProcessedMarkets() {
  const entries = Object.entries(state.processedMarkets).sort((a, b) => Number(a[1]?.periodStart || 0) - Number(b[1]?.periodStart || 0));
  if (entries.length > 300) for (const [key] of entries.slice(0, entries.length - 300)) delete state.processedMarkets[key];
  const alerts = Object.entries(state.alertedPeriods).sort((a, b) => Number(a[0]) - Number(b[0]));
  if (alerts.length > 100) for (const [key] of alerts.slice(0, alerts.length - 100)) delete state.alertedPeriods[key];
  const trades = Object.entries(state.paperTrades).sort((a, b) => Number(a[1]?.periodStart || 0) - Number(b[1]?.periodStart || 0));
  if (trades.length > 200) for (const [key] of trades.slice(0, trades.length - 200)) delete state.paperTrades[key];
}
function getWinner(market) {
  const winner = String(market?.winner || '').toUpperCase();
  if (winner === 'UP' || winner === 'DOWN') return winner;
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes.map(x => String(x).toUpperCase()) : [];
  const prices = Array.isArray(market?.outcomePrices) ? market.outcomePrices.map(Number) : [];
  const upIndex = outcomes.findIndex(x => x === 'UP');
  const downIndex = outcomes.findIndex(x => x === 'DOWN');
  if (upIndex >= 0 && prices[upIndex] >= 0.99) return 'UP';
  if (downIndex >= 0 && prices[downIndex] >= 0.99) return 'DOWN';
  if (prices[0] >= 0.99 && prices[1] <= 0.01) return 'UP';
  if (prices[1] >= 0.99 && prices[0] <= 0.01) return 'DOWN';
  return null;
}
function getEntryPrice(market, direction) {
  const prices = Array.isArray(market?.outcomePrices) ? market.outcomePrices.map(Number) : [];
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes.map(x => String(x).toUpperCase()) : [];
  const index = outcomes.findIndex(x => x === direction);
  const price = index >= 0 ? prices[index] : (direction === 'UP' ? prices[0] : prices[1]);
  return Number.isFinite(price) && price > 0 && price < 1 ? price : null;
}

async function settlePaperTrade(targetPeriod, market, winner) {
  const trade = state.paperTrades[String(targetPeriod)];
  if (!trade || trade.settled || !winner) return;
  const won = trade.direction === winner;
  const payout = won ? trade.shares : 0;
  const pnl = payout - trade.stakeUsd;
  trade.winner = winner;
  trade.payoutUsd = Number(payout.toFixed(6));
  trade.pnlUsd = Number(pnl.toFixed(6));
  trade.settled = true;
  trade.settledAt = new Date().toISOString();
  appendHistory({ type: 'polymarket_5m_paper_trade_settled', timeframe: '5m', periodStart: targetPeriod, direction: trade.direction, winner, stakeUsd: trade.stakeUsd, entryPrice: trade.entryPrice, shares: trade.shares, payoutUsd: trade.payoutUsd, pnlUsd: trade.pnlUsd, marketUrl: trade.marketUrl || market?.url || null });
  const sign = pnl >= 0 ? '+' : '';
  const result = [
    `📊 PAPER TRADE RESULT · BTC · 5M`,
    `Trade: ${trade.direction}`,
    `Outcome: ${winner}`,
    `Stake: $${trade.stakeUsd.toFixed(2)}`,
    `Entry: ${trade.entryPrice.toFixed(4)}`,
    `Payout: $${trade.payoutUsd.toFixed(2)}`,
    `P/L: ${sign}$${pnl.toFixed(2)}`,
    `Period: ${new Date(targetPeriod).toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour12: false })} UTC+3`
  ].join('\n');
  try {
    await sendTelegramMessage(result, { replyToMessageId: trade.telegramMessageId });
    console.log(`5m PAPER RESULT SENT period=${new Date(targetPeriod).toISOString()} pnl=${sign}$${pnl.toFixed(2)}`);
  } catch (error) {
    console.warn(`5m PAPER RESULT FAILED: ${error.message}`);
  }
  persistState();
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
      if (!market) { console.log(`5m OUTCOME ${symbol} period=${new Date(targetPeriod).toISOString()} market=NOT_FOUND`); return { symbol, market: null, winner: null }; }
      const winner = getWinner(market);
      if (!winner) console.log(`5m OUTCOME WAIT ${symbol} period=${new Date(targetPeriod).toISOString()} closed=${Boolean(market.closed)} resolved=${Boolean(market.resolved)} prices=${JSON.stringify(market.outcomePrices || [])}`);
      return { symbol, market, winner };
    } catch (error) { console.warn(`5m OUTCOME CHECK FAILED ${symbol}: ${error.message}`); return { symbol, market: null, winner: null }; }
  }));

  for (const { symbol, market, winner } of results) {
    if (!market || !winner) continue;
    const key = `${symbol}:${targetPeriod}`;
    if (state.processedMarkets[key]) continue;
    state.processedMarkets[key] = { symbol, periodStart: targetPeriod, winner, marketUrl: market.url || null, closedTime: market.closedTime || null, processedAt: new Date().toISOString() };
    appendHistory({ type: 'polymarket_5m_resolved_outcome', timeframe: '5m', symbol, periodStart: targetPeriod, winner, marketUrl: market.url || null, closed: Boolean(market.closed), resolved: Boolean(market.resolved), closedTime: market.closedTime || null });
    console.log(`5m OUTCOME COUNTED ${symbol}=${winner} period=${new Date(targetPeriod).toISOString()}`);
    if (symbol === 'BTC') await settlePaperTrade(targetPeriod, market, winner);
  }
  return evaluateCompletedPeriod(targetPeriod);
}

async function evaluateCompletedPeriod(targetPeriod) {
  const outcomes = SYMBOLS.map(symbol => state.processedMarkets[`${symbol}:${targetPeriod}`]?.winner || null);
  if (outcomes.some(winner => !winner)) { persistState(); return false; }

  const direction = outcomes[0];
  const unanimous = outcomes.every(winner => winner === direction);
  if (unanimous && !state.alertedPeriods[String(targetPeriod)]) {
    const currentPeriod = periodStart(Date.now());
    let currentMarket = null;
    try { currentMarket = await findMarketByEpoch('BTC', currentPeriod, '5m'); } catch (error) { console.warn(`CURRENT BTC MARKET CHECK FAILED: ${error.message}`); }
    await sendUnanimousAlert(direction, targetPeriod, currentPeriod, currentMarket);
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
    if (!state.initialized && !state.pendingPeriod && Object.keys(state.processedMarkets).length === 0) {
      state.pendingPeriod = currentPeriod;
      persistState();
      console.log(`CLEAN START: monitoring begins with current 5M period ${new Date(currentPeriod).toISOString()}; no historical periods will be backfilled.`);
      return;
    }

    const latestTarget = currentPeriod - PERIOD_MS;
    let startTarget = state.pendingPeriod;
    if (!Number.isFinite(Number(startTarget))) {
      const processedPeriods = Object.values(state.processedMarkets).map(x => Number(x?.periodStart)).filter(Number.isFinite);
      startTarget = processedPeriods.length ? Math.max(...processedPeriods) + PERIOD_MS : currentPeriod;
    } else {
      const pendingComplete = SYMBOLS.every(symbol => Boolean(state.processedMarkets[`${symbol}:${startTarget}`]));
      if (pendingComplete) startTarget += PERIOD_MS;
    }
    if (startTarget > latestTarget) return;

    const targets = [];
    for (let target = startTarget; target <= latestTarget && targets.length < MAX_BACKFILL_PERIODS; target += PERIOD_MS) targets.push(target);
    for (const targetPeriod of targets) { const complete = await fetchPeriodOutcomes(targetPeriod); if (!complete) break; }
    cleanupProcessedMarkets();
    persistState();
  } finally { outcomeCheckInFlight = false; }
}

async function sendUnanimousAlert(direction, closedPeriod, currentPeriod, currentMarket) {
  const normalizedDirection = direction === 'DOWN' ? 'DOWN' : 'UP';
  const currentMarketUrl = currentMarket?.url || null;
  const entryPrice = getEntryPrice(currentMarket, normalizedDirection);
  const message = [
    `🔥 BTC · 5M`,
    `ALL 7 COINS: ${normalizedDirection}`,
    `BTC closes: ${normalizedDirection}`,
    `Period: ${new Date(closedPeriod).toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour12: false })} UTC+3`,
    entryPrice !== null ? `💵 PAPER: BUY ${normalizedDirection} $1.00 @ ${entryPrice.toFixed(4)}` : `💵 PAPER: BUY ${normalizedDirection} $1.00`,
    currentMarketUrl ? `➡️ CURRENT · Polymarket 5M\n${currentMarketUrl}` : null
  ].filter(Boolean).join('\n');
  try {
    const telegramMessage = await sendTelegramMessage(message);
    if (entryPrice !== null && currentMarket) {
      const shares = PAPER_STAKE_USD / entryPrice;
      state.paperTrades[String(currentPeriod)] = {
        periodStart: currentPeriod,
        direction: normalizedDirection,
        stakeUsd: PAPER_STAKE_USD,
        entryPrice,
        shares,
        marketUrl: currentMarketUrl,
        telegramMessageId: Number.isInteger(telegramMessage?.message_id) ? telegramMessage.message_id : null,
        openedAt: new Date().toISOString(),
        settled: false
      };
      appendHistory({ type: 'polymarket_5m_paper_trade_opened', timeframe: '5m', periodStart: currentPeriod, direction: normalizedDirection, stakeUsd: PAPER_STAKE_USD, entryPrice, shares, marketUrl: currentMarketUrl, telegramMessageId: telegramMessage?.message_id || null });
      console.log(`5m PAPER TRADE OPENED ${normalizedDirection} stake=$1 entry=${entryPrice.toFixed(4)} shares=${shares.toFixed(6)} period=${new Date(currentPeriod).toISOString()}`);
    } else {
      console.warn(`5m PAPER TRADE NOT OPENED: current BTC market price unavailable`);
    }
    appendHistory({ type: 'polymarket_5m_unanimous_alert', timeframe: '5m', direction: normalizedDirection, closedPeriod, currentPeriod, currentMarketUrl, paperEntryPrice: entryPrice });
    console.log(`5m UNANIMOUS ALERT SENT BTC=${normalizedDirection} currentMarket=${currentMarketUrl || 'NOT_FOUND'}`);
  } catch (error) { console.warn(`5m UNANIMOUS ALERT FAILED: ${error.message}`); }
}

async function process(now) {
  const currentPeriod = periodStart(now);
  await fetchPreviousPeriodOutcomes(currentPeriod);
  if (!state.initialized) console.log(`5m SEVEN-COIN UNANIMOUS MONITOR STARTED; symbols=${SYMBOLS.join(',')}; alert only when all seven resolved in the same direction; $1 paper trade on current BTC 5M ${'UP'}/${'DOWN'} and reply with final P/L.`);
}

function main() {
  restoreState();
  (async () => {
    while (true) {
      try { await process(Date.now()); }
      catch (error) { console.warn(`UNANIMOUS MONITOR LOOP FAILED: ${error.message}`); }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  })().catch(error => { console.error(`MONITOR FATAL: ${error.stack || error.message}`); process.exitCode = 1; });
}
main();
