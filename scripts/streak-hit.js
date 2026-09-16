const fs = require('fs');
const { findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const SYMBOL = 'BTC';
const TIMEFRAMES = {
  '5m': { ms: 5 * 60 * 1000, history: 50, minStreak: 9 },
  '15m': { ms: 15 * 60 * 1000, history: 50, minStreak: 8 },
  '1h': { ms: 60 * 60 * 1000, history: 24, minStreak: 7 },
  '4h': { ms: 4 * 60 * 60 * 1000, history: 24, minStreak: 6 },
  '24h': { ms: 24 * 60 * 60 * 1000, history: 5, minStreak: 5 },
};
const STATE_FILE = '.streak-hit-state.json';
const HISTORY_FILE = 'streak-hit-history.log';
const POLL_MS = 15000;
const POLYBACKTEST_BASE = 'https://api.polybacktest.com/v3/btc/markets';

function floorPeriod(now, ms) { return Math.floor(now / ms) * ms; }
function append(record) { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n'); }
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { strategy: 'StreakHit', timeframes: {}, alerts: {} }; }
}
function saveState(state) { fs.writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: new Date().toISOString(), ...state }, null, 2) + '\n'); }
function winnerFromMarket(market) {
  const winner = String(market?.winner || '').toUpperCase();
  if (winner === 'UP' || winner === 'DOWN') return winner;
  const outcomes = Array.isArray(market?.outcomes) ? market.outcomes.map(x => String(x).toUpperCase()) : [];
  const prices = Array.isArray(market?.outcomePrices) ? market.outcomePrices.map(Number) : [];
  const up = outcomes.indexOf('UP');
  const down = outcomes.indexOf('DOWN');
  if (up >= 0 && prices[up] >= 0.99) return 'UP';
  if (down >= 0 && prices[down] >= 0.99) return 'DOWN';
  if (prices[0] >= 0.99 && prices[1] <= 0.01) return 'UP';
  if (prices[1] >= 0.99 && prices[0] <= 0.01) return 'DOWN';
  return null;
}
function currentMarketUrl(market) { return market?.url || null; }

async function resolvePeriod(timeframe, periodStart) {
  return findMarketByEpoch(SYMBOL, periodStart, timeframe);
}

function updateStreak(state, timeframe, periodStart, winner) {
  const cfg = TIMEFRAMES[timeframe];
  const bucket = state.timeframes[timeframe] ||= { periods: {}, lastProcessed: null, streak: 0, direction: null };
  const key = String(periodStart);
  if (bucket.periods[key]) return null;
  bucket.periods[key] = winner;
  if (winner === bucket.direction) bucket.streak += 1;
  else { bucket.direction = winner; bucket.streak = 1; }
  bucket.lastProcessed = periodStart;
  return bucket.streak >= cfg.minStreak ? {
    timeframe,
    periodStart,
    direction: winner,
    streak: bucket.streak,
    threshold: cfg.minStreak,
    newStreak: bucket.streak > cfg.minStreak,
  } : null;
}

async function sendAlert(alert, currentStart, currentMarket) {
  const direction = alert.direction === 'UP' ? '⬆️ UP' : '⬇️ DOWN';
  const label = alert.newStreak ? 'STREAK CONTINUES' : 'STREAK HIT';
  const url = currentMarketUrl(currentMarket);
  const lines = [
    `🔥 BTC · ${alert.timeframe.toUpperCase()} · ${label}`,
    `STREAK: ${direction} × ${alert.streak}`,
    `MIN: ${alert.threshold}`,
    `CLOSED: ${new Date(alert.periodStart).toISOString()}`,
    `NEXT: ${new Date(currentStart).toISOString()}`,
  ];
  if (url) lines.push(`➡️ CURRENT · Polymarket ${alert.timeframe.toUpperCase()}\n${url}`);
  await sendTelegramMessage(lines.join('\n'));
  append({ type: 'streak_hit_alert', symbol: SYMBOL, ...alert, currentStart, currentMarketUrl: url });
}

async function processTimeframe(state, timeframe, now) {
  const cfg = TIMEFRAMES[timeframe];
  const currentStart = floorPeriod(now, cfg.ms);
  const latestClosed = currentStart - cfg.ms;
  const bucket = state.timeframes[timeframe] ||= { periods: {}, lastProcessed: null, streak: 0, direction: null };
  let next = bucket.lastProcessed == null ? latestClosed - (cfg.history - 1) * cfg.ms : Number(bucket.lastProcessed) + cfg.ms;
  if (next > latestClosed) return;
  let guard = 0;
  while (next <= latestClosed && guard++ < cfg.history + 2) {
    if (bucket.periods[String(next)]) { next += cfg.ms; continue; }
    const market = await resolvePeriod(timeframe, next);
    const winner = winnerFromMarket(market);
    if (!winner) break;
    const alert = updateStreak(state, timeframe, next, winner);
    if (alert) {
      const currentMarket = await resolvePeriod(timeframe, currentStart);
      await sendAlert(alert, currentStart, currentMarket);
    }
    next += cfg.ms;
  }
}

async function polyBacktestMarkets(timeframe, limit) {
  const apiKey = process.env.POLYBACKTEST_API_KEY;
  if (!apiKey) throw new Error('POLYBACKTEST_API_KEY is required for StreakHit backtest');
  const url = `${POLYBACKTEST_BASE}?type=${encodeURIComponent(timeframe)}&limit=${limit}`;
  const response = await fetch(url, { headers: { 'X-API-Key': apiKey, Accept: 'application/json' } });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`PolyBackTest ${response.status}: ${text.slice(0, 500)}`);
  }
  const body = await response.json();
  return Array.isArray(body?.data) ? body.data : Array.isArray(body?.markets) ? body.markets : [];
}

function runBacktest(rows, timeframe) {
  const cfg = TIMEFRAMES[timeframe];
  const ordered = rows
    .filter(row => String(row?.winner || '').toLowerCase() === 'up' || String(row?.winner || '').toLowerCase() === 'down')
    .map(row => ({ ...row, winner: String(row.winner).toUpperCase() }))
    .sort((a, b) => new Date(a.start_time || a.startTime).getTime() - new Date(b.start_time || b.startTime).getTime());
  let direction = null;
  let streak = 0;
  const hits = [];
  for (const row of ordered) {
    if (row.winner === direction) streak += 1;
    else { direction = row.winner; streak = 1; }
    if (streak >= cfg.minStreak) hits.push({
      marketId: row.market_id || row.marketId,
      slug: row.slug,
      timeframe,
      startTime: row.start_time || row.startTime,
      endTime: row.end_time || row.endTime,
      direction,
      streak,
      threshold: cfg.minStreak,
      newStreak: streak > cfg.minStreak,
    });
  }
  return { timeframe, requested: cfg.history, received: rows.length, resolved: ordered.length, minimum: cfg.minStreak, hits };
}

async function backtest() {
  const results = [];
  for (const [timeframe, cfg] of Object.entries(TIMEFRAMES)) {
    const rows = await polyBacktestMarkets(timeframe, cfg.history);
    results.push(runBacktest(rows, timeframe));
  }
  console.log(JSON.stringify({ strategy: 'StreakHit', symbol: SYMBOL, generatedAt: new Date().toISOString(), results }, null, 2));
}

async function live() {
  const state = loadState();
  state.strategy = 'StreakHit';
  while (true) {
    for (const timeframe of Object.keys(TIMEFRAMES)) {
      try { await processTimeframe(state, timeframe, Date.now()); }
      catch (error) { console.warn(`StreakHit ${timeframe} failed: ${error.message}`); }
    }
    saveState(state);
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

const mode = process.argv[2] || 'live';
if (mode === 'backtest') backtest().catch(error => { console.error(error.stack || error.message); process.exit(1); });
else live().catch(error => { console.error(error.stack || error.message); process.exit(1); });
