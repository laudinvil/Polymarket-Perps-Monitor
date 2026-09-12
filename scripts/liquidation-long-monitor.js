const fs = require('fs');
const path = require('path');
const { fetchFeed, eventKey, normalizeTs, DEFAULT_SYMBOLS, POLL_MS } = require('../src/liquidation-monitor');
const { bucketStart, findCurrentMarket, findMarketByEpoch, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const STATE_PATH = path.join(process.cwd(), '.liquidation-state.json');
const TZ = 'Europe/Kyiv';
const PERIOD_MS = 5 * 60 * 1000;
const PAPER_USD = 1;

function periodStart(ts) {
  const n = Number(ts);
  return Number.isFinite(n) ? bucketStart(n, '5m') : NaN;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastAlertPeriod: null, paperTrade: null, skipPeriod: null };
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

async function getPaperEntry(currentMarket, outcome) {
  if (!currentMarket || currentMarket.synthetic || !outcome) return null;
  const marketStart = Number(currentMarket.slug?.split('-').pop()) * 1000;
  if (!Number.isFinite(marketStart) || marketStart <= 0) return null;

  const midpoint = await findClobMidpoint(currentMarket, outcome);
  const gammaPrice = Number(currentMarket.prices?.[outcome]);
  const price = Number.isFinite(midpoint) && midpoint > 0 && midpoint < 1
    ? midpoint
    : gammaPrice;
  if (!Number.isFinite(price) || price <= 0 || price >= 1) return null;

  console.log(`[5M] PAPER entry CURRENT market=${currentMarket.slug} outcome=${outcome} clob_mid=${midpoint ?? 'N/A'} gamma=${Number.isFinite(gammaPrice) ? gammaPrice : 'N/A'} selected=${price}`);
  return { market: currentMarket, marketStart, outcome, entryPrice: price, shares: PAPER_USD / price };
}

async function settlePaperTrade(trade, state) {
  if (!trade) return false;
  const market = await findMarketByEpoch(trade.symbol, trade.marketStart, '5m');
  if (!market || !market.resolved || !market.winner) {
    console.log(`[5M] PAPER settlement pending symbol=${trade?.symbol || 'UNKNOWN'} marketStart=${formatTime(trade.marketStart)} resolved=${market?.resolved ?? 'N/A'} winner=${market?.winner ?? 'N/A'} closed=${market?.closed ?? 'N/A'}`);
    return false;
  }

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
    `Period: ${formatTime(trade.marketStart)} → ${formatTime(trade.marketStart + PERIOD_MS)} UTC+3`,
    `➡️ MARKET`,
    market.url,
  ].join('\n');

  const options = Number.isInteger(trade.sourceMessageId)
    ? { replyToMessageId: trade.sourceMessageId }
    : {};
  await sendTelegramMessage(message, options);
  trade.settled = true;
  trade.result = result;
  trade.winner = winner;
  trade.pnl = pnl;

  if (win) {
    const nextPeriod = trade.marketStart + PERIOD_MS;
    state.skipPeriod = nextPeriod;
    console.log(`[5M] PAPER WIN; skipping next 5M period=${formatTime(nextPeriod)}`);
  }

  return true;
}

function isFreshEvent(event, currentPeriod, seenEvents) {
  const ts = normalizeTs(event?.ts);
  if (!ts) return false;
  const eventPeriod = periodStart(ts);
  if (eventPeriod !== currentPeriod) return false;
  const key = eventKey(event);
  if (seenEvents.has(key)) return false;
  seenEvents.add(key);
  return true;
}

async function alertForEvent(event, state, currentPeriod) {
  const ts = normalizeTs(event.ts);
  const symbol = String(event.symbol || '').toUpperCase();
  const eventPeriod = periodStart(ts);

  if (eventPeriod !== currentPeriod) return false;
  if (state.skipPeriod !== null && Number(state.skipPeriod) === currentPeriod) {
    console.log(`[5M] SUPPRESSED WIN cooldown period=${formatTime(currentPeriod)} symbol=${symbol}`);
    return false;
  }
  if (state.lastAlertPeriod !== null && Number(state.lastAlertPeriod) === currentPeriod) {
    console.log(`[5M] SUPPRESSED duplicate period=${formatTime(currentPeriod)} symbol=${symbol}`);
    return false;
  }

  const alertNow = Date.now();
  const currentMarket = await findCurrentMarket(symbol, alertNow, '5m');
  const currentUrl = currentMarket?.url || `https://polymarket.com/event/${symbol.toLowerCase()}-updown-5m-${Math.floor(currentPeriod / 1000)}`;
  const outcome = paperOutcomeFromLiquidation(event);
  const paperTrade = outcome ? await getPaperEntry(currentMarket, outcome) : null;

  const message = [
    `🔥 ${symbol} · LIQUIDATION`,
    `Side: ${liquidationSide(event)}`,
    `Size: ${formatUsd(event.notional)}`,
    `Price: ${event.price ?? 'n/a'}`,
    `Time: ${formatTime(ts)} UTC+3`,
    `5M period: ${formatTime(currentPeriod)} → ${formatTime(currentPeriod + PERIOD_MS)} UTC+3`,
    ...(paperTrade ? [
      `📈 PAPER TRADE · $${PAPER_USD.toFixed(2)}`,
      `BUY ${paperTrade.outcome} @ ${paperTrade.entryPrice.toFixed(4)}`,
      `Shares: ${paperTrade.shares.toFixed(4)}`,
    ] : ['📈 PAPER TRADE · current market entry unavailable']),
    `➡️ CURRENT · Polymarket 5M`,
    currentUrl,
  ].join('\n');

  try {
    const sentMessage = await sendTelegramMessage(message);
    state.lastAlertPeriod = currentPeriod;
    if (paperTrade) {
      state.paperTrade = {
        ...paperTrade,
        symbol,
        alertTs: ts,
        sourceMessageId: Number(sentMessage?.message_id),
        settled: false,
      };
    }
    saveState(state);
  } catch (error) {
    console.error(`[5M] Telegram send failed; period remains available: ${error.message}`);
    return false;
  }

  console.log(`[5M] ALERT ${symbol} side=${liquidationSide(event)} paper=${paperTrade?.outcome || 'N/A'} entry=${paperTrade?.entryPrice ?? 'N/A'} sourceMessageId=${state.paperTrade?.sourceMessageId || 'N/A'} liquidation=${formatTime(ts)} period=${formatTime(currentPeriod)} current=${currentUrl}`);
  return true;
}

async function main() {
  console.log(`MarginPad liquidation monitor started; symbols=${DEFAULT_SYMBOLS.join(',')}; timeframe=5m; Polymarket-aligned periods; current-period alerts; all liquidation sides; one alert per current 5m period; paper=$${PAPER_USD.toFixed(2)} UP/DOWN with result settlement; entry from CURRENT 5m market; CLOB midpoint entry; current-market link; WIN skips next 5m period; poll=${POLL_MS}ms`);
  const state = loadState();
  const seenEvents = new Set();

  while (true) {
    try {
      const now = Date.now();
      const currentPeriod = periodStart(now);

      if (state.paperTrade && !state.paperTrade.settled) {
        if (await settlePaperTrade(state.paperTrade, state)) saveState(state);
      }

      const events = await fetchFeed(DEFAULT_SYMBOLS);
      const fresh = events
        .filter(event => isFreshEvent(event, currentPeriod, seenEvents))
        .sort((a, b) => normalizeTs(a.ts) - normalizeTs(b.ts));

      if (state.lastAlertPeriod !== null && Number(state.lastAlertPeriod) < currentPeriod) {
        state.lastAlertPeriod = null;
        saveState(state);
      }

      if (state.skipPeriod !== null && Number(state.skipPeriod) < currentPeriod) {
        console.log(`[5M] WIN cooldown completed period=${formatTime(state.skipPeriod)}`);
        state.skipPeriod = null;
        saveState(state);
      }

      for (const event of fresh) {
        if (await alertForEvent(event, state, currentPeriod)) break;
      }

      const totalCurrent = events.filter(event => {
        const ts = normalizeTs(event?.ts);
        return ts && periodStart(ts) === currentPeriod;
      }).length;
      console.log(`[5M] current=${formatTime(currentPeriod)} total_current=${totalCurrent} alert=${state.skipPeriod === currentPeriod ? 'SKIP_AFTER_WIN' : state.lastAlertPeriod === currentPeriod ? 'DONE_CURRENT_PERIOD' : 'WAITING_CURRENT_PERIOD'} paper=${state.paperTrade?.settled ? state.paperTrade.result : state.paperTrade ? 'OPEN' : 'NONE'}`);
    } catch (error) {
      console.error(`[5M] monitor error: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
