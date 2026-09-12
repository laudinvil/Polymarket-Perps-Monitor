const fs = require('fs');
const path = require('path');
const { fetchFeed, eventKey, normalizeTs, DEFAULT_SYMBOLS, POLL_MS } = require('../src/liquidation-monitor');
const { findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const STATE_PATH = path.join(process.cwd(), '.liquidation-state.json');
const TZ = 'Europe/Kyiv';
const PERIOD_MS = 10 * 60 * 1000;
const PAPER_USD = 1;

// 10-minute periods are anchored to minutes 05, 15, 25, 35, 45, 55 (UTC+3).
function periodStart(ts) {
  const d = new Date(Number(ts));
  const minutes = d.getUTCMinutes();
  const anchoredMinute = 5 + Math.floor((minutes - 5 + 60) / 10) * 10;
  const start = new Date(d);
  start.setUTCMinutes(anchoredMinute, 0, 0);
  if (minutes < 5) start.setUTCHours(start.getUTCHours() - 1, 55, 0, 0);
  return start.getTime();
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastAlertPeriod: null, paperTrade: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function formatTime(epoch) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(epoch)).replace(',', '');
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function liquidationSide(event) {
  const side = String(event?.side || event?.direction || '').toLowerCase();
  if (side.includes('long') || side === 'buy') return 'LONG';
  if (side.includes('short') || side === 'sell') return 'SHORT';
  return side.toUpperCase() || 'UNKNOWN';
}

function paperOutcomeFromLiquidation(event) {
  const side = liquidationSide(event);
  return side === 'SHORT' ? 'DOWN' : side === 'LONG' ? 'UP' : null;
}

async function getPaperMarket(symbol, marketStart) {
  return findNextMarket(symbol, marketStart - 1, '5m');
}

async function getPaperEntry(symbol, ts, outcome) {
  const marketStart = Math.floor(ts / 300000) * 300000;
  const market = await getPaperMarket(symbol, marketStart);
  if (!market) return null;
  const price = Number(market.prices?.[outcome]);
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  return { market, marketStart, outcome, entryPrice: price, shares: PAPER_USD / price };
}

async function settlePaperTrade(trade, now) {
  if (!trade || now < trade.marketStart + 300000) return false;
  const market = await getPaperMarket(trade.symbol, trade.marketStart);
  if (!market || !market.resolved || !market.winner) return false;

  const winner = String(market.winner).toUpperCase();
  const win = winner === trade.outcome;
  const payout = win ? PAPER_USD / trade.entryPrice : 0;
  const pnl = payout - PAPER_USD;
  const result = win ? 'WIN' : 'LOSS';

  const message = [
    `📊 PAPER RESULT · ${trade.symbol} · 5M`,
    `BUY $${PAPER_USD.toFixed(2)} ${trade.outcome} @ ${trade.entryPrice.toFixed(4)}`,
    `Result: ${result}`,
    `Winner: ${winner}`,
    `Payout: $${payout.toFixed(2)}`,
    `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
    `Period: ${formatTime(trade.marketStart)} → ${formatTime(trade.marketStart + 300000)} UTC+3`,
    `➡️ MARKET`,
    market.url,
  ].join('\n');

  await sendTelegramMessage(message);
  trade.settled = true;
  trade.result = result;
  trade.winner = winner;
  trade.pnl = pnl;
  return true;
}

function isFreshEvent(event, startedAt, currentPeriod, seenEvents) {
  const ts = normalizeTs(event?.ts);
  if (!ts || ts < startedAt || periodStart(ts) !== currentPeriod) return false;
  const key = eventKey(event);
  if (seenEvents.has(key)) return false;
  seenEvents.add(key);
  return true;
}

async function alertForEvent(event, state) {
  const ts = normalizeTs(event.ts);
  const symbol = String(event.symbol || '').toUpperCase();
  const currentPeriod = periodStart(ts);
  if (state.lastAlertPeriod !== null && Number(state.lastAlertPeriod) === currentPeriod) return false;

  const nextMarket = await findNextMarket(symbol, ts, '5m');
  const nextUrl = nextMarket?.url || `https://polymarket.com/event/${symbol.toLowerCase()}-updown-5m-${Math.floor((Math.floor(ts / 300000) * 300000 + 300000) / 1000)}`;
  const outcome = paperOutcomeFromLiquidation(event);
  const paperTrade = outcome ? await getPaperEntry(symbol, ts, outcome) : null;

  const message = [
    `🔥 ${symbol} · LIQUIDATION`,
    `Side: ${liquidationSide(event)}`,
    `Size: ${formatUsd(event.notional)}`,
    `Price: ${event.price ?? 'n/a'}`,
    `Time: ${formatTime(ts)} UTC+3`,
    `10M period: ${formatTime(currentPeriod)} → ${formatTime(currentPeriod + PERIOD_MS)} UTC+3`,
    ...(paperTrade ? [
      `📈 PAPER TRADE · $${PAPER_USD.toFixed(2)}`,
      `BUY ${paperTrade.outcome} @ ${paperTrade.entryPrice.toFixed(4)}`,
      `Shares: ${paperTrade.shares.toFixed(4)}`,
    ] : ['📈 PAPER TRADE · entry price unavailable']),
    `➡️ NEXT · Polymarket 5M`,
    nextUrl,
  ].join('\n');

  await sendTelegramMessage(message);
  state.lastAlertPeriod = currentPeriod;
  if (paperTrade) {
    state.paperTrade = {
      ...paperTrade,
      symbol,
      alertTs: ts,
      settled: false,
    };
  }
  saveState(state);
  console.log(`[10M] ALERT ${symbol} side=${liquidationSide(event)} paper=${paperTrade?.outcome || 'N/A'} entry=${paperTrade?.entryPrice ?? 'N/A'} liquidation=${formatTime(ts)} period=${formatTime(currentPeriod)}`);
  return true;
}

async function main() {
  console.log(`MarginPad liquidation monitor started; symbols=${DEFAULT_SYMBOLS.join(',')}; timeframe=10m; anchored periods=05/15/25/35/45/55; all liquidation sides; first liquidation alerts immediately; remaining liquidations suppressed until next 10m period; paper=$${PAPER_USD.toFixed(2)} UP/DOWN with result settlement; poll=${POLL_MS}ms`);
  const state = loadState();
  const startedAt = Date.now();
  const seenEvents = new Set();

  while (true) {
    try {
      const now = Date.now();

      if (state.paperTrade && !state.paperTrade.settled) {
        if (await settlePaperTrade(state.paperTrade, now)) saveState(state);
      }

      const events = await fetchFeed(DEFAULT_SYMBOLS);
      const currentPeriod = periodStart(now);
      const fresh = events
        .filter(event => isFreshEvent(event, startedAt, currentPeriod, seenEvents))
        .sort((a, b) => normalizeTs(a.ts) - normalizeTs(b.ts));

      if (state.lastAlertPeriod !== null && Number(state.lastAlertPeriod) < currentPeriod) {
        state.lastAlertPeriod = null;
        saveState(state);
      }

      for (const event of fresh) {
        if (await alertForEvent(event, state)) break;
      }

      const totalCurrent = events.filter(event => {
        const ts = normalizeTs(event?.ts);
        return ts && periodStart(ts) === currentPeriod;
      }).length;
      console.log(`[10M] current=${formatTime(currentPeriod)} total_liquidations=${totalCurrent} alert=${state.lastAlertPeriod === currentPeriod ? 'SUPPRESSED_AFTER_FIRST' : 'WAITING_FOR_FIRST'} paper=${state.paperTrade?.settled ? state.paperTrade.result : state.paperTrade ? 'OPEN' : 'NONE'}`);
    } catch (error) {
      console.error(`[10M] monitor error: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});