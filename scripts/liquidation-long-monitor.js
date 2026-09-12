const fs = require('fs');
const path = require('path');
const { fetchFeed, eventKey, normalizeTs, DEFAULT_SYMBOLS, POLL_MS } = require('../src/liquidation-monitor');
const { bucketStart, findNextMarket, findMarketByEpoch, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const STATE_PATH = path.join(process.cwd(), '.liquidation-state.json');
const TZ = 'Europe/Kyiv';
const PERIOD_MS = 5 * 60 * 1000;
const PAPER_USD = 1;
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL || 'https://brainy-canary-207.eu-west-1.convex.site';
const CONVEX_INGEST_TOKEN = process.env.CONVEX_INGEST_TOKEN || '';

function periodStart(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? bucketStart(n, '5m') : NaN;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch { return { lastAlertPeriod: null, paperTrade: null, skipPeriod: null }; }
}

function saveState(state) { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }

async function convexRequest(pathname, options = {}) {
  if (!CONVEX_INGEST_TOKEN) throw new Error('CONVEX_INGEST_TOKEN is not configured');
  const response = await fetch(`${CONVEX_SITE_URL}${pathname}`, {
    ...options,
    headers: { accept: 'application/json', authorization: `Bearer ${CONVEX_INGEST_TOKEN}`, ...(options.headers || {}) },
  });
  if (!response.ok) throw new Error(`Convex HTTP ${response.status}`);
  return response.json();
}

async function loadPersistentPaperTrade(state) {
  const trade = await convexRequest('/paper/open');
  if (!trade) return false;
  state.paperTrade = {
    symbol: trade.symbol, marketStart: trade.marketStart, outcome: trade.outcome,
    entryPrice: trade.entryPrice, shares: trade.shares, alertTs: trade.alertTs,
    sourceMessageId: trade.sourceMessageId, settled: Boolean(trade.settled),
    result: trade.result, winner: trade.winner, pnl: trade.pnl,
    closedPrice: trade.closedPrice, closeTs: trade.closeTs, closePnl: trade.closePnl,
  };
  saveState(state);
  console.log(`[5M] RESTORED PAPER TRADE symbol=${trade.symbol} market=${formatTime(trade.marketStart)} outcome=${trade.outcome} closed=${trade.closedPrice ?? 'N/A'} settled=${Boolean(trade.settled)}`);
  return true;
}

async function persistPaperTrade(trade) {
  await convexRequest('/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'paper.upsert', data: {
      symbol: trade.symbol, marketStart: trade.marketStart, outcome: trade.outcome,
      entryPrice: trade.entryPrice, shares: trade.shares, alertTs: trade.alertTs,
      sourceMessageId: Number.isInteger(trade.sourceMessageId) ? trade.sourceMessageId : undefined,
      settled: Boolean(trade.settled), result: trade.result, winner: trade.winner, pnl: trade.pnl,
      closedPrice: trade.closedPrice, closeTs: trade.closeTs, closePnl: trade.closePnl,
      updatedAt: Date.now(),
    }}),
  });
}

function formatTime(epoch) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(epoch)).replace(',', '');
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

async function getPaperEntry(nextMarket, outcome) {
  if (!nextMarket || nextMarket.synthetic || !outcome) return null;
  const marketStart = Number(nextMarket.slug?.split('-').pop()) * 1000;
  if (!Number.isFinite(marketStart) || marketStart <= 0) return null;
  const midpoint = await findClobMidpoint(nextMarket, outcome);
  const gammaPrice = Number(nextMarket.prices?.[outcome]);
  const price = Number.isFinite(midpoint) && midpoint > 0 && midpoint < 1 ? midpoint : gammaPrice;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;
  console.log(`[5M] PAPER entry NEXT+1 market=${nextMarket.slug} outcome=${outcome} clob_mid=${midpoint ?? 'N/A'} gamma=${Number.isFinite(gammaPrice) ? gammaPrice : 'N/A'} selected=${price}`);
  return { market: nextMarket, marketStart, outcome, entryPrice: price, shares: PAPER_USD / price };
}

async function settlePaperTrade(trade, state) {
  if (!trade || trade.settled) return false;
  const now = Date.now();
  const endTs = Number(trade.marketStart) + PERIOD_MS;
  if (!Number.isFinite(endTs) || now < endTs) return false;
  const market = await findMarketByEpoch(trade.symbol, trade.marketStart, '5m');
  if (!market) return false;
  let changed = false;
  if (!Number.isFinite(Number(trade.closedPrice))) {
    const closePrice = await findClobMidpoint(market, trade.outcome);
    if (Number.isFinite(closePrice) && closePrice >= 0 && closePrice <= 1) {
      const value = trade.shares * closePrice;
      const closePnl = value - PAPER_USD;
      trade.closedPrice = closePrice; trade.closeTs = endTs; trade.closePnl = closePnl; changed = true;
      const closeMessage = [
        `📊 PAPER CLOSE · ${trade.symbol} · 5M`,
        `BUY $${PAPER_USD.toFixed(2)} ${trade.outcome} @ ${trade.entryPrice.toFixed(4)}`,
        `CLOSE @ ${closePrice.toFixed(4)}`, `Value: $${value.toFixed(2)}`,
        `P&L: ${closePnl >= 0 ? '+' : ''}$${closePnl.toFixed(2)}`,
        `Period: ${formatTime(trade.marketStart)} → ${formatTime(endTs)} UTC+3`,
        `➡️ MARKET`, market.url,
      ].join('\n');
      const options = Number.isInteger(trade.sourceMessageId) ? { replyToMessageId: trade.sourceMessageId } : {};
      await sendTelegramMessage(closeMessage, options);
    }
  }
  if (changed) { await persistPaperTrade(trade); saveState(state); }
  if (!market.resolved || !market.winner) return changed;
  const winner = String(market.winner).toUpperCase();
  const win = winner === trade.outcome;
  const payout = win ? trade.shares : 0;
  const pnl = payout - PAPER_USD;
  const result = win ? 'WIN' : 'LOSS';
  const message = [
    `🏁 FINAL PAPER RESULT · ${trade.symbol} · 5M`,
    `BUY $${PAPER_USD.toFixed(2)} ${trade.outcome} @ ${trade.entryPrice.toFixed(4)}`,
    ...(Number.isFinite(Number(trade.closedPrice)) ? [`CLOSE @ ${Number(trade.closedPrice).toFixed(4)}`, `Close P&L: ${Number(trade.closePnl).toFixed(2) >= 0 ? '+' : ''}$${Number(trade.closePnl).toFixed(2)}`] : []),
    `Result: ${result}`, `Winner: ${winner}`, `Payout: $${payout.toFixed(2)}`,
    `Final P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
    `Period: ${formatTime(trade.marketStart)} → ${formatTime(endTs)} UTC+3`, `➡️ MARKET`, market.url,
  ].join('\n');
  const options = Number.isInteger(trade.sourceMessageId) ? { replyToMessageId: trade.sourceMessageId } : {};
  await sendTelegramMessage(message, options);
  trade.settled = true; trade.result = result; trade.winner = winner; trade.pnl = pnl;
  if (win) state.skipPeriod = endTs;
  await persistPaperTrade(trade); saveState(state); return true;
}

function isFreshEvent(event, currentPeriod, seenEvents) {
  const ts = normalizeTs(event?.ts);
  if (!ts || periodStart(ts) !== currentPeriod) return false;
  const key = eventKey(event); if (seenEvents.has(key)) return false;
  seenEvents.add(key); return true;
}

async function alertForEvent(event, state, currentPeriod) {
  const ts = normalizeTs(event.ts);
  const symbol = String(event.symbol || '').toUpperCase();
  if (periodStart(ts) !== currentPeriod) return false;
  if (state.paperTrade && !state.paperTrade.settled) return false;
  if (state.skipPeriod !== null && Number(state.skipPeriod) === currentPeriod) return false;
  if (state.lastAlertPeriod !== null && Number(state.lastAlertPeriod) === currentPeriod) return false;

  const alertNow = Date.now();
  const nextMarket = await findNextMarket(symbol, alertNow, '5m');
  const nextUrl = nextMarket?.url || `https://polymarket.com/event/${symbol.toLowerCase()}-updown-5m-${Math.floor((currentPeriod + PERIOD_MS) / 1000)}`;
  const outcome = paperOutcomeFromLiquidation(event);
  const paperTrade = outcome ? await getPaperEntry(nextMarket, outcome) : null;
  const message = [
    `🔥 ${symbol} · LIQUIDATION`, `Side: ${liquidationSide(event)}`, `Size: ${formatUsd(event.notional)}`,
    `Price: ${event.price ?? 'n/a'}`, `Time: ${formatTime(ts)} UTC+3`,
    `5M period: ${formatTime(currentPeriod)} → ${formatTime(currentPeriod + PERIOD_MS)} UTC+3`,
    ...(paperTrade ? [`📈 PAPER TRADE · $${PAPER_USD.toFixed(2)}`, `BUY ${paperTrade.outcome} @ ${paperTrade.entryPrice.toFixed(4)}`, `Shares: ${paperTrade.shares.toFixed(4)}`] : ['📈 PAPER TRADE · next+1 market entry unavailable']),
    `➡️ NEXT+1 · Polymarket 5M`, nextUrl,
  ].join('\n');

  try {
    const sentMessage = await sendTelegramMessage(message);
    state.lastAlertPeriod = currentPeriod;
    if (paperTrade) {
      state.paperTrade = { ...paperTrade, symbol, alertTs: ts, sourceMessageId: Number(sentMessage?.message_id), settled: false };
      await persistPaperTrade(state.paperTrade);
    }
    saveState(state);
  } catch (error) {
    console.error(`[5M] Telegram/Convex send failed; period remains available: ${error.message}`); return false;
  }
  console.log(`[5M] ALERT ${symbol} side=${liquidationSide(event)} paper=${paperTrade?.outcome || 'N/A'} entry=${paperTrade?.entryPrice ?? 'N/A'} sourceMessageId=${state.paperTrade?.sourceMessageId || 'N/A'} liquidation=${formatTime(ts)} period=${formatTime(currentPeriod)} next+1=${nextUrl}`);
  return true;
}

function isCurrentPeriodEvent(event, currentPeriod) {
  const ts = normalizeTs(event?.ts); return Boolean(ts && periodStart(ts) === currentPeriod);
}

async function main() {
  console.log(`MarginPad liquidation monitor started; symbols=${DEFAULT_SYMBOLS.join(',')}; timeframe=5m; current-period alerts; one alert per current 5m period; persistent Convex paper state; close at market end; final result after official resolution; WIN skips next 5m period; poll=${POLL_MS}ms`);
  const state = loadState(); const seenEvents = new Set();
  if (!CONVEX_INGEST_TOKEN) throw new Error('CONVEX_INGEST_TOKEN is required for persistent paper state');
  try { await loadPersistentPaperTrade(state); } catch (error) { throw new Error(`Convex paper state unavailable: ${error.message}`); }
  while (true) {
    try {
      const now = Date.now(); const currentPeriod = periodStart(now);
      if (state.paperTrade && !state.paperTrade.settled) { if (await settlePaperTrade(state.paperTrade, state)) saveState(state); }
      const events = await fetchFeed(DEFAULT_SYMBOLS);
      const fresh = events.filter(event => isFreshEvent(event, currentPeriod, seenEvents)).sort((a, b) => normalizeTs(a.ts) - normalizeTs(b.ts));
      if (state.lastAlertPeriod !== null && Number(state.lastAlertPeriod) < currentPeriod) { state.lastAlertPeriod = null; saveState(state); }
      if (state.skipPeriod !== null && Number(state.skipPeriod) < currentPeriod) { state.skipPeriod = null; saveState(state); }
      for (const event of fresh) { if (await alertForEvent(event, state, currentPeriod)) break; }
      const totalCurrent = events.filter(event => isCurrentPeriodEvent(event, currentPeriod)).length;
      console.log(`[5M] current=${formatTime(currentPeriod)} total_current=${totalCurrent} alert=${state.paperTrade && !state.paperTrade.settled ? 'WAITING_PAPER_SETTLEMENT' : state.skipPeriod === currentPeriod ? 'SKIP_AFTER_WIN' : state.lastAlertPeriod === currentPeriod ? 'DONE_CURRENT_PERIOD' : 'WAITING_CURRENT_PERIOD'} paper=${state.paperTrade?.settled ? state.paperTrade.result : state.paperTrade ? 'OPEN' : 'NONE'}`);
    } catch (error) { console.error(`[5M] monitor error: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => { console.error(error); process.exit(1); });
