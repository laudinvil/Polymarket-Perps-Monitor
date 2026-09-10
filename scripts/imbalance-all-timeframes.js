const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Authoritative liquidation monitor.
// All supported coins. 5m periods. Individual liquidation events only.
// Alert on the FIRST liquidation after one or more completely empty 5m periods.
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const PERIOD_MS = 5 * 60 * 1000;
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;

const state = {
  periodStart: null,
  periodEventCount: 0,
  armedAfterEmptyPeriod: false,
  periodAlreadyAlerted: false,
  initialized: false,
  seenLiquidations: new Set(),
};
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function periodStart(now) {
  return Math.floor(now / PERIOD_MS) * PERIOD_MS;
}

function eventSide(event) {
  const value = String(event?.side || event?.direction || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 'LONG';
  if (value.includes('short') || value === 'sell') return 'SHORT';
  return null;
}

function displaySide(side) {
  // Polymarket direction mapping requested by the user:
  // LONG liquidation -> UP, SHORT liquidation -> DOWN.
  return side === 'LONG' ? 'UP' : 'DOWN';
}

function liquidationKey(symbol, ts, side, event) {
  const id = event?.id ?? event?.liquidationId ?? event?.eventId ?? event?.tradeId ?? event?.txHash ?? event?.orderId;
  if (id !== undefined && id !== null && String(id) !== '') return `${symbol}:id:${String(id)}`;
  return [symbol, ts, side, event?.exchange ?? '', event?.price ?? '', event?.qty ?? event?.quantity ?? event?.size ?? '', event?.notional ?? event?.usd ?? event?.value ?? event?.amount ?? ''].join('|');
}

function numberValue(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function money(value) {
  return `$${Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function price(value) {
  return Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

async function fetchAllFeeds() {
  const results = await Promise.all(SYMBOLS.map(async symbol => {
    try {
      return [symbol, await fetchSymbolFeed(symbol)];
    } catch (error) {
      console.warn(`FEED ${symbol} FAILED: ${error.message}`);
      return [symbol, []];
    }
  }));
  return new Map(results);
}

function collectCurrentPeriodEvents(feeds, now) {
  const current = periodStart(now);
  const candidates = [];

  for (const symbol of SYMBOLS) {
    const events = feeds.get(symbol) || [];
    for (const event of events) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts < current || ts >= current + PERIOD_MS) continue;

      const side = eventSide(event);
      if (!side) continue;

      const key = liquidationKey(symbol, ts, side, event);
      if (state.seenLiquidations.has(key)) continue;
      state.seenLiquidations.add(key);

      const item = { symbol, side, event, ts, key };
      state.periodEventCount += 1;
      candidates.push(item);
    }
  }

  candidates.sort((a, b) => a.ts - b.ts);
  return candidates;
}

function enqueueAlert(message, candidate) {
  alertSendChain = alertSendChain.then(async () => {
    const waitMs = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    try {
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      console.log(`5m EMPTY-PERIOD ALERT SENT ${candidate.symbol} ${candidate.side} display=${displaySide(candidate.side)}`);
    } catch (error) {
      console.warn(`5m EMPTY-PERIOD ALERT SEND FAILED ${candidate.symbol}: ${error.message}`);
    }
  }).catch(error => console.warn(`5m EMPTY-PERIOD ALERT QUEUE FAILED: ${error.message}`));
}

async function processTimeframe(feeds, now) {
  const current = periodStart(now);

  if (state.periodStart === null) {
    state.periodStart = current;
    state.periodEventCount = 0;
    state.armedAfterEmptyPeriod = false;
    state.periodAlreadyAlerted = false;
    state.seenLiquidations.clear();
    console.log(`5m EMPTY-PERIOD MONITOR START ${new Date(current).toISOString()}; baseline suppresses historical events`);
  } else if (state.periodStart !== current) {
    const completedPeriod = state.periodStart;
    const wasEmpty = state.periodEventCount === 0;

    if (state.initialized && wasEmpty) {
      state.armedAfterEmptyPeriod = true;
      console.log(`5m EMPTY PERIOD CONFIRMED ${new Date(completedPeriod).toISOString()}; next liquidation will alert`);
    } else if (state.initialized) {
      state.armedAfterEmptyPeriod = false;
      console.log(`5m PERIOD HAD LIQUIDATIONS ${new Date(completedPeriod).toISOString()} count=${state.periodEventCount}; no alert armed`);
    }

    state.periodStart = current;
    state.periodEventCount = 0;
    state.periodAlreadyAlerted = false;
    state.seenLiquidations.clear();
    console.log(`5m PERIOD RESET ${new Date(current).toISOString()}`);
  }

  const newEvents = collectCurrentPeriodEvents(feeds, now);

  if (!state.initialized) {
    state.initialized = true;
    console.log(`INITIAL 5m BASELINE READY; current-period historical events suppressed count=${state.periodEventCount}`);
    return;
  }

  if (!state.armedAfterEmptyPeriod || state.periodAlreadyAlerted || !newEvents.length) return;

  // The first newly observed liquidation after one or more empty 5m periods triggers.
  const candidate = newEvents[0];
  state.periodAlreadyAlerted = true;
  state.armedAfterEmptyPeriod = false;

  const { symbol, side, event } = candidate;
  const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
  const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
  const eventNotional = numberValue(event?.notional, event?.usd, event?.value, event?.amount, eventPrice * eventQty);

  console.log(`5m EMPTY-PERIOD CLAIMED symbol=${symbol} side=${side} display=${displaySide(side)} currentPeriod=${new Date(state.periodStart).toISOString()} rule=first_liquidation_after_empty_5m_period`);

  let nextMarket = null;
  try {
    nextMarket = await findNextMarket(symbol, Date.now(), TIMEFRAME);
    console.log(`POLYMARKET NEXT ${symbol} 5m=${nextMarket?.url ?? 'UNAVAILABLE'}`);
  } catch (error) {
    console.warn(`POLYMARKET NEXT LOOKUP FAILED 5m ${symbol}: ${error.message}`);
  }

  const message = [
    `🔥 ${symbol} · 5M`,
    displaySide(side),
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    nextMarket?.url ? `➡️ NEXT · Polymarket 5M\n${nextMarket.url}` : null
  ].filter(value => value !== null).join('\n');

  enqueueAlert(message, candidate);
}

async function main() {
  console.log('5m EMPTY-PERIOD LIQUIDATION MONITOR STARTED; coins=BTC,ETH,SOL,XRP,DOGE,BNB,HYPE; first liquidation after one or more empty 5m periods; individual events only; no imbalance; no streaks; one alert per armed period; next market only');
  while (true) {
    const now = Date.now();
    try {
      const feeds = await fetchAllFeeds();
      await processTimeframe(feeds, now);
    } catch (error) {
      console.warn(`MONITOR LOOP FAILED: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(`MONITOR FATAL: ${error.stack || error.message}`);
  process.exitCode = 1;
});
