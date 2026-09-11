const { findCurrentMarket, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');
const fs = require('fs');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const PERIOD_MS = 5 * 60 * 1000;
const SNAPSHOT_DELAY_MS = 60 * 1000;
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const SPOT_URL = 'https://api.binance.com/api/v3/ticker/price';
const STATE_FILE = '.monitor-state.json';
const HISTORY_FILE = 'monitor-history.log';

// Primary signal: real spot move >= 0.15% after the first 60 seconds while
// Polymarket still prices the matching side at 52%-55%.
const MOMENTUM_THRESHOLD_PCT = 0.15;
const MOMENTUM_MIN_MARKET_PCT = 52;
const MOMENTUM_MAX_MARKET_PCT = 55;

// Divergence signal: real spot move >= 0.20% while Polymarket still prices
// the matching side at <=51%.
const DIVERGENCE_THRESHOLD_PCT = 0.20;
const DIVERGENCE_MAX_MARKET_PCT = 51;

const state = {
  periodStart: null,
  baselinePrices: {},
  signalChecked: false,
  periodAlreadyAlerted: false,
  lastAlertAt: null,
  lastAlertSymbol: null,
  initialized: false,
};

let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function periodStart(now) {
  return Math.floor(now / PERIOD_MS) * PERIOD_MS;
}

async function fetchSpotPrices() {
  const response = await fetch(SPOT_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Binance HTTP ${response.status}`);
  const rows = await response.json();
  const wanted = new Set(SYMBOLS.map(symbol => `${symbol}USDT`));
  const prices = {};
  for (const row of rows) {
    if (wanted.has(row?.symbol)) {
      const symbol = String(row.symbol).replace(/USDT$/, '');
      const price = Number(row.price);
      if (Number.isFinite(price) && price > 0) prices[symbol] = price;
    }
  }
  for (const symbol of SYMBOLS) {
    if (!Number.isFinite(prices[symbol])) throw new Error(`Missing Binance spot price for ${symbol}`);
  }
  return prices;
}

function persistState() {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      strategy: 'polymarket-5m-momentum',
      symbols: SYMBOLS,
      periodStart: state.periodStart,
      baselinePrices: state.baselinePrices,
      signalChecked: state.signalChecked,
      periodAlreadyAlerted: state.periodAlreadyAlerted,
      lastAlertAt: state.lastAlertAt,
      lastAlertSymbol: state.lastAlertSymbol,
      initialized: state.initialized,
    }, null, 2) + '\n',
  );
}

function appendHistory(record) {
  fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
}

function restoreState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved?.strategy !== 'polymarket-5m-momentum') return;
    if (!Number.isFinite(Number(saved?.periodStart))) return;
    state.periodStart = Number(saved.periodStart);
    state.baselinePrices = saved.baselinePrices && typeof saved.baselinePrices === 'object' ? saved.baselinePrices : {};
    state.signalChecked = Boolean(saved.signalChecked);
    state.periodAlreadyAlerted = Boolean(saved.periodAlreadyAlerted);
    state.lastAlertAt = saved.lastAlertAt ?? null;
    state.lastAlertSymbol = saved.lastAlertSymbol ?? null;
    state.initialized = Boolean(saved.initialized);
    console.log(`STATE RESTORED momentum period=${new Date(state.periodStart).toISOString()} baseline=${JSON.stringify(state.baselinePrices)} alerted=${state.periodAlreadyAlerted}`);
  } catch (error) {
    console.log(`STATE RESTORE: no usable momentum state (${error.message}); starting fresh`);
  }
}

function resetPeriod(current) {
  if (state.periodStart === current) return;
  state.periodStart = current;
  state.baselinePrices = {};
  state.signalChecked = false;
  state.periodAlreadyAlerted = false;
  persistState();
  console.log(`5m MOMENTUM PERIOD START ${new Date(current).toISOString()}`);
}

function pctChange(from, to) {
  return ((to - from) / from) * 100;
}

async function readMarketSide(symbol, direction, now) {
  const market = await findCurrentMarket(symbol, now, '5m');
  if (!market) return null;
  const outcome = direction === 'UP' ? 'UP' : 'DOWN';
  let price = await findClobMidpoint(market, outcome);
  if (!Number.isFinite(price)) price = Number(market?.prices?.[outcome]);
  if (!Number.isFinite(price)) return null;
  return { market, outcome, pricePct: price * 100 };
}

async function evaluateSignals(currentPrices, now) {
  if (state.periodAlreadyAlerted || state.signalChecked) return;
  if (now < state.periodStart + SNAPSHOT_DELAY_MS) return;

  const candidates = [];
  for (const symbol of SYMBOLS) {
    const baseline = Number(state.baselinePrices[symbol]);
    const current = Number(currentPrices[symbol]);
    if (!Number.isFinite(baseline) || !Number.isFinite(current)) continue;

    const movePct = pctChange(baseline, current);
    if (Math.abs(movePct) < MOMENTUM_THRESHOLD_PCT) continue;

    const direction = movePct > 0 ? 'UP' : 'DOWN';
    try {
      const marketSide = await readMarketSide(symbol, direction, now);
      if (!marketSide) {
        console.log(`5m SIGNAL CHECK ${symbol} move=${movePct.toFixed(3)}% direction=${direction} market_price=NA`);
        continue;
      }

      let signalType = null;
      if (marketSide.pricePct >= MOMENTUM_MIN_MARKET_PCT && marketSide.pricePct <= MOMENTUM_MAX_MARKET_PCT) {
        signalType = 'MOMENTUM';
      } else if (Math.abs(movePct) >= DIVERGENCE_THRESHOLD_PCT && marketSide.pricePct <= DIVERGENCE_MAX_MARKET_PCT) {
        signalType = 'DIVERGENCE';
      }

      console.log(`5m SIGNAL CHECK ${symbol} move=${movePct.toFixed(3)}% direction=${direction} market_${direction}=${marketSide.pricePct.toFixed(2)}% signal=${signalType || 'none'}`);
      if (signalType) {
        candidates.push({ symbol, direction, movePct, marketSide, signalType });
      }
    } catch (error) {
      console.warn(`5m MARKET CHECK FAILED ${symbol}: ${error.message}`);
    }
  }

  state.signalChecked = true;
  persistState();

  if (!candidates.length) {
    console.log(`5m NO SIGNAL period=${new Date(state.periodStart).toISOString()} after=60s`);
    return;
  }

  // One alert globally per 5m period. Prefer the largest absolute spot move.
  candidates.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
  const signal = candidates[0];
  state.periodAlreadyAlerted = true;
  state.lastAlertSymbol = signal.symbol;
  persistState();
  enqueueAlert(signal, state.periodStart, now);
}

function enqueueAlert(signal, currentPeriod, now) {
  alertSendChain = alertSendChain.then(async () => {
    const wait = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));

    try {
      const market = signal.marketSide.market;
      const message = [
        `🔥 ${signal.symbol} · 5M`,
        signal.signalType === 'MOMENTUM' ? 'MOMENTUM SIGNAL' : 'PRICE / POLYMARKET DIVERGENCE',
        `Direction: ${signal.direction}`,
        `Spot move: ${signal.movePct >= 0 ? '+' : ''}${signal.movePct.toFixed(3)}%`,
        `Polymarket ${signal.direction}: ${signal.marketSide.pricePct.toFixed(2)}%`,
        `Period: ${new Date(currentPeriod).toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour12: false })} UTC+3`,
        market?.url ? `➡️ CURRENT · Polymarket 5M\n${market.url}` : null,
      ].filter(Boolean).join('\n');

      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      state.lastAlertAt = new Date(lastAlertSentAt).toISOString();
      state.lastAlertSymbol = signal.symbol;
      persistState();
      appendHistory({
        type: 'polymarket_5m_momentum',
        timeframe: '5m',
        symbol: signal.symbol,
        direction: signal.direction,
        signalType: signal.signalType,
        spotMovePct: signal.movePct,
        polymarketPricePct: signal.marketSide.pricePct,
        currentPeriod,
        marketUrl: market?.url || null,
      });
      console.log(`5m MOMENTUM ALERT SENT symbol=${signal.symbol} type=${signal.signalType} direction=${signal.direction} move=${signal.movePct.toFixed(3)}% polymarket=${signal.marketSide.pricePct.toFixed(2)}% market=${market?.url || 'NONE'}`);
    } catch (error) {
      // Keep the period lock. A transient Telegram failure must not create duplicate signals.
      console.warn(`5m MOMENTUM ALERT FAILED ${signal.symbol}: ${error.message}`);
    }
  }).catch(error => console.warn(`5m ALERT QUEUE FAILED: ${error.message}`));
}

async function processPeriod(now) {
  const current = periodStart(now);
  resetPeriod(current);

  const prices = await fetchSpotPrices();

  if (!Object.keys(state.baselinePrices).length) {
    state.baselinePrices = prices;
    persistState();
    console.log(`5m BASELINE SNAPSHOT period=${new Date(current).toISOString()} prices=${JSON.stringify(prices)}`);
  }

  if (!state.initialized) {
    state.initialized = true;
    persistState();
    console.log(`INITIAL 5m MOMENTUM BASELINE READY symbols=${SYMBOLS.join(',')}`);
  }

  await evaluateSignals(prices, now);
}

function main() {
  restoreState();
  console.log(`5m POLYMARKET MOMENTUM MONITOR STARTED; symbols=${SYMBOLS.join(',')}; baseline=period-start; evaluation=+60s; momentum=0.15% + Polymarket 52-55%; divergence=0.20% + Polymarket <=51%; one alert per 5m period.`);

  (async () => {
    while (true) {
      const now = Date.now();
      try {
        await processPeriod(now);
      } catch (error) {
        console.warn(`MOMENTUM LOOP FAILED: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  })().catch(error => {
    console.error(`MONITOR FATAL: ${error.stack || error.message}`);
    process.exitCode = 1;
  });
}

main();
