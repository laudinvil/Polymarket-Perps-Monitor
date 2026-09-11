const { findCurrentMarket, findMarketByEpoch, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');
const fs = require('fs');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const PERIOD_MS = 5 * 60 * 1000;
const SNAPSHOT_DELAY_MS = 60 * 1000;
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const RTDS_TOPIC = 'crypto_prices_twap_sixty';
const STATE_FILE = '.monitor-state.json';
const HISTORY_FILE = 'monitor-history.log';
const CHAINLINK_SYMBOLS = Object.fromEntries(SYMBOLS.map(symbol => [symbol, `${symbol.toLowerCase()}/usd`]));

// Primary signal: Chainlink 60s TWAP move >= 0.10% after the first 60 seconds
// while Polymarket still prices the matching side at 51%-55%.
const MOMENTUM_THRESHOLD_PCT = 0.10;
const MOMENTUM_MIN_MARKET_PCT = 51;
const MOMENTUM_MAX_MARKET_PCT = 55;

// Divergence signal: Chainlink 60s TWAP move >= 0.15% while Polymarket
// still prices the matching side at <=52%.
const DIVERGENCE_THRESHOLD_PCT = 0.15;
const DIVERGENCE_MAX_MARKET_PCT = 52;

const state = {
  periodStart: null,
  baselinePrices: {},
  signalChecked: false,
  periodAlreadyAlerted: false,
  lastAlertAt: null,
  lastAlertSymbol: null,
  lastAlertPeriodStart: null,
  lastOutcomeCheckedPeriod: null,
  lastAlertDirection: null,
  initialized: false,
};

const chainlinkPrices = {};
let rtdsSocket = null;
let rtdsReconnectTimer = null;
let rtdsReady = false;
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function periodStart(now) {
  return Math.floor(now / PERIOD_MS) * PERIOD_MS;
}

function startRtds() {
  if (rtdsReconnectTimer) {
    clearTimeout(rtdsReconnectTimer);
    rtdsReconnectTimer = null;
  }

  try {
    rtdsSocket = new WebSocket(RTDS_URL);
  } catch (error) {
    console.warn(`CHAINLINK RTDS CONNECT FAILED: ${error.message}`);
    scheduleRtdsReconnect();
    return;
  }

  rtdsSocket.addEventListener('open', () => {
    rtdsReady = true;
    const subscriptions = SYMBOLS.map(symbol => ({
      topic: RTDS_TOPIC,
      type: 'update',
      filters: JSON.stringify({ symbol: CHAINLINK_SYMBOLS[symbol] }),
    }));
    rtdsSocket.send(JSON.stringify({ action: 'subscribe', subscriptions }));
    console.log(`CHAINLINK RTDS CONNECTED topic=${RTDS_TOPIC} symbols=${SYMBOLS.join(',')}`);
  });

  rtdsSocket.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data || ''));
      if (message?.message) {
        console.warn(`CHAINLINK RTDS MESSAGE: ${message.message}`);
        return;
      }
      if (message?.topic !== RTDS_TOPIC) return;
      const payload = message?.payload || {};
      const symbol = SYMBOLS.find(item => CHAINLINK_SYMBOLS[item] === String(payload.symbol || '').toLowerCase());
      if (!symbol) return;
      const rawValue = payload.full_accuracy_value ?? payload.value;
      const price = Number(rawValue);
      if (!Number.isFinite(price) || price <= 0) return;
      chainlinkPrices[symbol] = price;
      console.log(`CHAINLINK TWAP60 ${symbol}=${price} ts=${payload.timestamp || message.timestamp || 'NA'}`);
    } catch (error) {
      console.warn(`CHAINLINK RTDS PARSE FAILED: ${error.message}`);
    }
  });

  rtdsSocket.addEventListener('error', event => {
    console.warn(`CHAINLINK RTDS ERROR: ${event?.message || 'socket error'}`);
  });

  rtdsSocket.addEventListener('close', () => {
    rtdsReady = false;
    rtdsSocket = null;
    console.warn('CHAINLINK RTDS CLOSED; reconnecting');
    scheduleRtdsReconnect();
  });
}

function scheduleRtdsReconnect() {
  if (rtdsReconnectTimer) return;
  rtdsReconnectTimer = setTimeout(() => {
    rtdsReconnectTimer = null;
    startRtds();
  }, 2000);
}

function getCurrentPrices() {
  const prices = {};
  for (const symbol of SYMBOLS) {
    const price = Number(chainlinkPrices[symbol]);
    if (!Number.isFinite(price) || price <= 0) return null;
    prices[symbol] = price;
  }
  return prices;
}

function persistState() {
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      strategy: 'polymarket-5m-momentum',
      priceSource: 'polymarket-rtds-chainlink-twap-60s',
      symbols: SYMBOLS,
      periodStart: state.periodStart,
      baselinePrices: state.baselinePrices,
      signalChecked: state.signalChecked,
      periodAlreadyAlerted: state.periodAlreadyAlerted,
      lastAlertAt: state.lastAlertAt,
      lastAlertSymbol: state.lastAlertSymbol,
      lastAlertPeriodStart: state.lastAlertPeriodStart,
      lastOutcomeCheckedPeriod: state.lastOutcomeCheckedPeriod,
      lastAlertDirection: state.lastAlertDirection,
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
    state.lastAlertPeriodStart = Number.isFinite(Number(saved.lastAlertPeriodStart)) ? Number(saved.lastAlertPeriodStart) : null;
    state.lastOutcomeCheckedPeriod = Number.isFinite(Number(saved.lastOutcomeCheckedPeriod)) ? Number(saved.lastOutcomeCheckedPeriod) : null;
    state.lastAlertDirection = saved.lastAlertDirection ?? null;
    state.initialized = Boolean(saved.initialized);
    console.log(`STATE RESTORED momentum period=${new Date(state.periodStart).toISOString()} source=${saved.priceSource || 'legacy'} baseline=${JSON.stringify(state.baselinePrices)} alerted=${state.periodAlreadyAlerted}`);
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

async function recordPreviousAlertOutcome(currentPeriod) {
  const alertPeriod = Number(state.lastAlertPeriodStart);
  const symbol = state.lastAlertSymbol;
  if (!Number.isFinite(alertPeriod) || !symbol) return;
  if (state.lastOutcomeCheckedPeriod === alertPeriod) return;
  if (alertPeriod >= currentPeriod) return;

  try {
    const market = await findMarketByEpoch(symbol, alertPeriod, '5m');
    if (!market) {
      console.log(`5m MARKET OUTCOME ${symbol} period=${new Date(alertPeriod).toISOString()} unavailable`);
      return;
    }

    const winner = market.winner || null;
    const resolved = Boolean(market.resolved);
    const closed = Boolean(market.closed);
    console.log(`5m MARKET OUTCOME ${symbol} period=${new Date(alertPeriod).toISOString()} closed=${closed} resolved=${resolved} winner=${winner || 'NA'} prices=${JSON.stringify(market.outcomePrices || [])}`);

    if (!closed && !resolved) return;

    state.lastOutcomeCheckedPeriod = alertPeriod;
    persistState();
    appendHistory({
      type: 'polymarket_5m_outcome',
      timeframe: '5m',
      symbol,
      periodStart: alertPeriod,
      expectedDirection: state.lastAlertDirection,
      marketUrl: market.url || null,
      closed,
      resolved,
      winner,
      outcomes: market.outcomes || [],
      outcomePrices: market.outcomePrices || [],
      closedTime: market.closedTime || null,
      signalResult: winner && state.lastAlertDirection ? (winner === state.lastAlertDirection ? 'WIN' : 'LOSS') : 'UNDETERMINED',
    });
  } catch (error) {
    console.warn(`5m MARKET OUTCOME CHECK FAILED ${symbol}: ${error.message}`);
  }
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
      if (signalType) candidates.push({ symbol, direction, movePct, marketSide, signalType });
    } catch (error) {
      console.warn(`5m MARKET CHECK FAILED ${symbol}: ${error.message}`);
    }
  }

  state.signalChecked = true;
  persistState();

  if (!candidates.length) {
    console.log(`5m NO SIGNAL period=${new Date(state.periodStart).toISOString()} after=60s source=chainlink-twap-60s`);
    return;
  }

  // One alert globally per 5m period. Prefer the largest absolute price move.
  candidates.sort((a, b) => Math.abs(b.movePct) - Math.abs(a.movePct));
  const signal = candidates[0];
  state.periodAlreadyAlerted = true;
  state.lastAlertSymbol = signal.symbol;
  state.lastAlertPeriodStart = state.periodStart;
  state.lastAlertDirection = signal.direction;
  persistState();
  enqueueAlert(signal, state.periodStart);
}

function enqueueAlert(signal, currentPeriod) {
  alertSendChain = alertSendChain.then(async () => {
    const wait = Math.max(0, ALERT_MIN_GAP_MS - (Date.now() - lastAlertSentAt));
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));

    try {
      const market = signal.marketSide.market;
      const message = [
        `🔥 ${signal.symbol} · 5M`,
        signal.signalType === 'MOMENTUM' ? 'MOMENTUM SIGNAL' : 'PRICE / POLYMARKET DIVERGENCE',
        `Direction: ${signal.direction}`,
        `Chainlink TWAP60 move: ${signal.movePct >= 0 ? '+' : ''}${signal.movePct.toFixed(3)}%`,
        `Polymarket ${signal.direction}: ${signal.marketSide.pricePct.toFixed(2)}%`,
        `Period: ${new Date(currentPeriod).toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour12: false })} UTC+3`,
        market?.url ? `➡️ CURRENT · Polymarket 5M\n${market.url}` : null,
      ].filter(Boolean).join('\n');

      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      state.lastAlertAt = new Date(lastAlertSentAt).toISOString();
      state.lastAlertSymbol = signal.symbol;
      state.lastAlertPeriodStart = currentPeriod;
      state.lastAlertDirection = signal.direction;
      persistState();
      appendHistory({
        type: 'polymarket_5m_momentum',
        timeframe: '5m',
        symbol: signal.symbol,
        direction: signal.direction,
        signalType: signal.signalType,
        priceSource: 'polymarket-rtds-chainlink-twap-60s',
        spotMovePct: signal.movePct,
        polymarketPricePct: signal.marketSide.pricePct,
        currentPeriod,
        marketUrl: market?.url || null,
        expectedOutcome: signal.direction,
      });
      console.log(`5m MOMENTUM ALERT SENT symbol=${signal.symbol} type=${signal.signalType} direction=${signal.direction} move=${signal.movePct.toFixed(3)}% polymarket=${signal.marketSide.pricePct.toFixed(2)}% market=${market?.url || 'NONE'}`);
    } catch (error) {
      console.warn(`5m MOMENTUM ALERT FAILED ${signal.symbol}: ${error.message}`);
    }
  }).catch(error => console.warn(`5m ALERT QUEUE FAILED: ${error.message}`));
}

async function processPeriod(now) {
  const current = periodStart(now);
  const changedPeriod = state.periodStart !== current;

  if (changedPeriod) await recordPreviousAlertOutcome(current);
  resetPeriod(current);

  const prices = getCurrentPrices();
  if (!prices) {
    console.log(`5m WAITING FOR CHAINLINK TWAP60 symbols=${SYMBOLS.filter(symbol => !Number.isFinite(Number(chainlinkPrices[symbol]))).join(',') || 'none'} rtds=${rtdsReady ? 'connected' : 'disconnected'}`);
    return;
  }

  if (!Object.keys(state.baselinePrices).length) {
    state.baselinePrices = prices;
    persistState();
    console.log(`5m BASELINE SNAPSHOT source=chainlink-twap-60s period=${new Date(current).toISOString()} prices=${JSON.stringify(prices)}`);
  }

  if (!state.initialized) {
    state.initialized = true;
    persistState();
    console.log(`INITIAL 5m MOMENTUM BASELINE READY source=chainlink-twap-60s symbols=${SYMBOLS.join(',')}`);
  }

  await evaluateSignals(prices, now);
}

function main() {
  restoreState();
  startRtds();
  console.log(`5m POLYMARKET MOMENTUM MONITOR STARTED; symbols=${SYMBOLS.join(',')}; price_source=Polymarket RTDS Chainlink 60s TWAP; baseline=period-start; evaluation=+60s; momentum=0.10% + Polymarket 51-55%; divergence=0.15% + Polymarket <=52%; one alert per 5m period; previous alert outcome recorded after close.`);

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
