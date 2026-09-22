const { env } = require('node:process');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const PERIOD_MS = 300000;

const AUTO_TRADE_ENABLED =
  String(env.POLYMARKET_AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true';

const TRADE_SIDE = String(env.POLYMARKET_TRADE_SIDE || 'up').trim().toLowerCase();
if (!['up', 'down', 'both'].includes(TRADE_SIDE)) {
  throw new Error('POLYMARKET_TRADE_SIDE must be up, down, or both');
}

const ORDER_AMOUNT_USD = Number(env.POLYMARKET_ORDER_AMOUNT_USD || 1);
const DCA_BUYS_PER_PERIOD = Math.max(1, Math.floor(Number(env.POLYMARKET_DCA_BUYS_PER_PERIOD || 1)));
const RECOVERY_MODE =
  String(env.POLYMARKET_RECOVERY_MODE || 'false').toLowerCase() === 'true';
const RECOVERY_INITIAL_BET = Number(env.POLYMARKET_RECOVERY_INITIAL_BET || ORDER_AMOUNT_USD);
const RECOVERY_MAX_STEPS = Math.max(0, Math.floor(Number(env.POLYMARKET_RECOVERY_MAX_STEPS || 5)));
const RECOVERY_MULTIPLIER = Number(env.POLYMARKET_RECOVERY_MULTIPLIER || 2);
const RETRY_MS = Math.max(1000, Number(env.POLYMARKET_TRADE_RETRY_MS || 3000));
const SETTLEMENT_POLL_MS = Math.max(5000, Number(env.POLYMARKET_SETTLEMENT_POLL_MS || 10000));
const SETTLEMENT_TIMEOUT_MS = Math.max(60000, Number(env.POLYMARKET_SETTLEMENT_TIMEOUT_MS || 900000));

function requireEnv(name) {
  const value = env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

function convexUrl(path) {
  return requireEnv('CONVEX_SITE_URL').replace(/\/$/, '') + path;
}

async function convexRequest(path, options = {}) {
  const headers = {
    authorization: 'Bearer ' + requireEnv('CONVEX_INGEST_TOKEN'),
    'content-type': 'application/json',
    ...(options.headers || {})
  };
  const response = await fetch(convexUrl(path), { ...options, headers });
  const body = await response.text();
  if (!response.ok) throw new Error('Convex ' + response.status + ': ' + body);
  return body ? JSON.parse(body) : null;
}

let publicClient;

async function getPublicClient() {
  if (!publicClient) {
    const { createPublicClient } = await import('@polymarket/client');
    publicClient = createPublicClient();
  }
  return publicClient;
}

async function gammaEvent(slug) {
  const sdkClient = await getPublicClient();
  const market = await sdkClient.fetchMarket({ slug });

  const yes = market?.outcomes?.yes;
  const no = market?.outcomes?.no;

  if (!yes || !no) {
    throw new Error('SDK market has no binary outcomes: ' + slug);
  }

  const yesLabel = String(yes.label || '').trim().toUpperCase();
  const noLabel = String(no.label || '').trim().toUpperCase();

  let upOutcome;
  let downOutcome;

  if (yesLabel === 'UP' && noLabel === 'DOWN') {
    upOutcome = yes;
    downOutcome = no;
  } else if (yesLabel === 'DOWN' && noLabel === 'UP') {
    upOutcome = no;
    downOutcome = yes;
  } else {
    throw new Error(
      'SDK market outcomes are not UP/DOWN: ' +
      slug +
      ' (' +
      yesLabel +
      '/' +
      noLabel +
      ')'
    );
  }

  const upAssetId = upOutcome.positionId;
  const downAssetId = downOutcome.positionId;

  if (!upAssetId || !downAssetId) {
    throw new Error(
      'V2 positionId unavailable for UP/DOWN market: ' + slug
    );
  }

  const minimumOrderSize = Number(market?.trading?.minimumOrderSize);
  if (!Number.isFinite(minimumOrderSize) || minimumOrderSize <= 0) {
    throw new Error('SDK minimumOrderSize unavailable: ' + slug);
  }

  let winningOutcome = null;

  try {
    const response = await fetch(
      GAMMA_API + '/events?slug=' + encodeURIComponent(slug)
    );
    const body = await response.text();
    if (!response.ok) throw new Error('Gamma ' + response.status + ': ' + body);

    const data = JSON.parse(body);
    const event = Array.isArray(data)
      ? data.find(item => item && item.slug === slug)
      : null;
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    const gammaMarket =
      markets.find(item => item && item.slug === slug) || markets[0];

    if (gammaMarket?.winner) {
      winningOutcome = String(gammaMarket.winner).trim().toUpperCase();
    } else {
      let outcomePrices =
        gammaMarket?.outcomePrices ?? gammaMarket?.outcome_prices;
      if (typeof outcomePrices === 'string') {
        outcomePrices = JSON.parse(outcomePrices);
      }

      let outcomes = gammaMarket?.outcomes;
      if (typeof outcomes === 'string') {
        outcomes = JSON.parse(outcomes);
      }

      if (Array.isArray(outcomePrices) && Array.isArray(outcomes)) {
        const normalized = outcomes.map(value =>
          String(value).trim().toUpperCase()
        );
        const upIndex = normalized.findIndex(value => value === 'UP');
        const downIndex = normalized.findIndex(value => value === 'DOWN');

        if (upIndex >= 0 && Number(outcomePrices[upIndex]) >= 0.99) {
          winningOutcome = 'UP';
        } else if (
          downIndex >= 0 &&
          Number(outcomePrices[downIndex]) >= 0.99
        ) {
          winningOutcome = 'DOWN';
        }
      }
    }
  } catch (error) {
    console.error(
      '[auto-trade] Gamma settlement metadata check failed ' +
      slug +
      ': ' +
      error.message
    );
  }

  return {
    slug,
    upAssetId: String(upAssetId),
    downAssetId: String(downAssetId),
    minimumOrderSize,
    winningOutcome
  };
}
async function positionSnapshot(assetId) {
  const response = await fetch(
    DATA_API + '/positions?user=' + encodeURIComponent(requireEnv('POLYMARKET_DEPOSIT_WALLET'))
  );
  const body = await response.text();
  if (!response.ok) throw new Error('Positions API ' + response.status + ': ' + body);

  const rows = JSON.parse(body);
  const position = Array.isArray(rows)
    ? rows.find(item => String(item.asset ?? item.assetId ?? '') === String(assetId))
    : null;

  return {
    shares: Number(position?.size ?? 0),
    avgPrice: Number(position?.avgPrice ?? position?.avg_price ?? 0)
  };
}

async function waitForPositionIncrease(assetId, beforeShares, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let latest = await positionSnapshot(assetId);

  while (latest.shares <= beforeShares && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    latest = await positionSnapshot(assetId);
  }

  if (latest.shares <= beforeShares) {
    throw new Error('Market BUY accepted but position increase was not confirmed');
  }
  return latest;
}

async function getClient() {
  const { createSecureClient } = await import('@polymarket/client');
  const { privateKey } = await import('@polymarket/client/viem');

  return createSecureClient({
    wallet: requireEnv('POLYMARKET_DEPOSIT_WALLET'),
    signer: privateKey(requireEnv('POLYMARKET_PRIVATE_KEY'))
  });
}

async function sendTelegram(message) {
  const response = await fetch(
    'https://api.telegram.org/bot' + requireEnv('TELEGRAM_BOT_TOKEN') + '/sendMessage',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: requireEnv('TELEGRAM_CHAT_ID'),
        text: message,
        disable_web_page_preview: false
      })
    }
  );
  const body = await response.text();
  if (!response.ok) throw new Error('Telegram ' + response.status + ': ' + body);
  return JSON.parse(body);
}

async function recoveryState(symbol) {
  return convexRequest('/trading/recovery?symbol=' + encodeURIComponent(symbol));
}

async function saveTrade(data) {
  return convexRequest('/ingest', {
    method: 'POST',
    body: JSON.stringify({ type: 'liveTrade.upsert', data })
  });
}

async function saveRecovery(data) {
  return convexRequest('/ingest', {
    method: 'POST',
    body: JSON.stringify({ type: 'recovery.set', data })
  });
}

function initialRecovery(symbol, existing) {
  if (existing) return existing;
  return {
    symbol,
    enabled: RECOVERY_MODE,
    initialBetUsd: RECOVERY_INITIAL_BET,
    step: 0,
    maxSteps: RECOVERY_MAX_STEPS,
    multiplier: RECOVERY_MULTIPLIER,
    nextBetUsd: RECOVERY_INITIAL_BET,
    updatedAt: Date.now()
  };
}

function tradeId(symbol, marketStart) {
  return symbol + ':' + marketStart;
}

async function submitMarketBuy(client, assetId, amount, minimumOrderSize) {
  const { OrderSide, OrderType, OrderPostStatus } = await import('@polymarket/client');

  if (amount < minimumOrderSize) {
    throw new Error(
      'BUY amount below market minimum: ' + amount + ' < ' + minimumOrderSize
    );
  }

  const order = await client.createMarketOrder({
    assetId,
    side: OrderSide.BUY,
    amount,
    orderType: OrderType.FAK
  });

  const matched = order?.ok === true && order?.status === OrderPostStatus.MATCHED;
  if (!matched) {
    throw new Error('Market BUY not matched: ' + JSON.stringify({
      ok: order?.ok,
      status: order?.status,
      error: order?.error,
      orderId: order?.orderId
    }));
  }

  return order;
}

async function buyWithRetry(client, market, side, amount, trade, slot) {
  const assetId = side === 'UP' ? market.upAssetId : market.downAssetId;
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      const order = await submitMarketBuy(
        client,
        assetId,
        amount,
        market.minimumOrderSize
      );

      console.log(
        '[auto-trade] FILLED ' + trade.slug +
        ' SIDE=' + side +
        ' DCA=' + slot + '/' + DCA_BUYS_PER_PERIOD +
        ' attempt=' + attempt +
        ' amount=$' + amount
      );
      return order;
    } catch (error) {
      console.error(
        '[auto-trade] BUY RETRY ' + trade.slug +
        ' SIDE=' + side +
        ' DCA=' + slot + '/' + DCA_BUYS_PER_PERIOD +
        ' attempt=' + attempt + ': ' + error.message
      );
      await new Promise(resolve => setTimeout(resolve, RETRY_MS));
    }
  }
}

async function settleTrade(trade) {
  const deadline = Date.now() + SETTLEMENT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const latest = await gammaEvent(trade.slug);
      if (latest.winningOutcome === 'UP') return 'UP';
      if (latest.winningOutcome === 'DOWN') return 'DOWN';
    } catch (error) {
      console.error('[auto-trade] settlement check failed ' + trade.slug + ': ' + error.message);
    }
    await new Promise(resolve => setTimeout(resolve, SETTLEMENT_POLL_MS));
  }

  throw new Error('Settlement timeout: ' + trade.slug);
}

async function runTrade(symbol, slug, marketStart, marketEnd, strategySide = null) {
  const tradeSide = strategySide ? String(strategySide).trim().toLowerCase() : TRADE_SIDE;
  if (!['up', 'down', 'both'].includes(tradeSide)) throw new Error('Invalid strategy trade side: ' + strategySide);
  const existingRecovery = await recoveryState(symbol);
  const recovery = initialRecovery(symbol, existingRecovery);
  const targetBetUsd = recovery.enabled ? recovery.nextBetUsd : ORDER_AMOUNT_USD;
  const market = await gammaEvent(slug);

  if (!Number.isFinite(market.minimumOrderSize) || market.minimumOrderSize <= 0) {
    throw new Error('Market minimum order size unavailable: ' + slug);
  }

  const trade = {
    tradeId: tradeId(symbol, marketStart),
    symbol,
    marketStart,
    marketEnd,
    slug,
    outcome: tradeSide.toUpperCase(),
    baseOrderUsd: ORDER_AMOUNT_USD,
    targetBetUsd,
    dcaBuys: DCA_BUYS_PER_PERIOD,
    recoveryEnabled: recovery.enabled,
    recoveryStep: recovery.step,
    buysAttempted: 0,
    buysFilled: 0,
    spentUsd: 0,
    shares: 0,
    avgPrice: undefined,
    status: 'running',
    startedAt: Date.now(),
    updatedAt: Date.now()
  };

  await saveTrade(trade);

  if (!AUTO_TRADE_ENABLED) {
    console.log(
      '[auto-trade] DISABLED: would BUY ' + tradeSide.toUpperCase() +
      ' ' + slug +
      ' total=$' + targetBetUsd +
      ' DCA=' + DCA_BUYS_PER_PERIOD
    );
    trade.status = 'disabled';
    trade.updatedAt = Date.now();
    await saveTrade(trade);
    return;
  }

  const client = await getClient();
  const slotAmount = targetBetUsd / DCA_BUYS_PER_PERIOD;
  const orderAmounts = tradeSide === 'both'
    ? { UP: slotAmount / 2, DOWN: slotAmount / 2 }
    : { [tradeSide.toUpperCase()]: slotAmount };

  for (const [side, amount] of Object.entries(orderAmounts)) {
    if (amount < market.minimumOrderSize) {
      throw new Error(
        'DCA ' + side + ' slot amount below market minimum: $' +
        amount + ' < ' + market.minimumOrderSize
      );
    }
  }

  const position = {
    UP: { shares: 0, avgPrice: 0 },
    DOWN: { shares: 0, avgPrice: 0 }
  };

  const interval = PERIOD_MS / DCA_BUYS_PER_PERIOD;

  for (let slot = 1; slot <= DCA_BUYS_PER_PERIOD; slot++) {
    const dueAt = marketStart + (slot - 1) * interval;
    const wait = dueAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));

    for (const [side, amount] of Object.entries(orderAmounts)) {
      trade.buysAttempted++;
      trade.updatedAt = Date.now();
      await saveTrade(trade);

      const assetId = side === 'UP' ? market.upAssetId : market.downAssetId;
      const before = await positionSnapshot(assetId);

      await buyWithRetry(client, market, side, amount, trade, slot);

      // A matched FAK is not retried here. We only wait for position confirmation,
      // preventing a delayed Data API update from causing a duplicate BUY.
      const after = await waitForPositionIncrease(assetId, before.shares);

      const beforeCost = before.shares * before.avgPrice;
      const afterCost = after.shares * after.avgPrice;
      const incrementalCost = Math.max(0, afterCost - beforeCost);

      position[side] = {
        shares: after.shares,
        avgPrice: after.avgPrice
      };

      trade.buysFilled++;
      trade.spentUsd += incrementalCost > 0 ? incrementalCost : amount;
      trade.shares = position.UP.shares + position.DOWN.shares;
      trade.avgPrice = trade.shares > 0
        ? (
            position.UP.shares * position.UP.avgPrice +
            position.DOWN.shares * position.DOWN.avgPrice
          ) / trade.shares
        : 0;
      trade.updatedAt = Date.now();
      await saveTrade(trade);
    }
  }

  const winningOutcome = await settleTrade(trade);
  const winningShares = position[winningOutcome].shares;
  const payout = winningShares;
  const result = winningOutcome === tradeSide.toUpperCase() || tradeSide === 'both'
    ? 'WIN'
    : 'LOSS';
  const pnl = payout - trade.spentUsd;

  trade.status = result === 'WIN' ? 'won' : 'lost';
  trade.result = result;
  trade.payout = payout;
  trade.pnl = pnl;
  trade.settledAt = Date.now();
  trade.updatedAt = Date.now();
  await saveTrade(trade);

  const nextStep = result === 'WIN'
    ? 0
    : Math.min(recovery.step + 1, recovery.maxSteps);

  const nextBetUsd = recovery.enabled
    ? (result === 'WIN'
      ? recovery.initialBetUsd
      : recovery.step < recovery.maxSteps
        ? recovery.nextBetUsd * recovery.multiplier
        : recovery.nextBetUsd)
    : recovery.initialBetUsd;

  await saveRecovery({
    symbol,
    enabled: recovery.enabled,
    initialBetUsd: recovery.initialBetUsd,
    step: nextStep,
    maxSteps: recovery.maxSteps,
    multiplier: recovery.multiplier,
    nextBetUsd,
    updatedAt: Date.now()
  });

  const recoveryText = recovery.enabled
    ? result === 'WIN'
      ? 'RECOVERY: RESET → $' + recovery.initialBetUsd.toFixed(2)
      : recovery.step < recovery.maxSteps
        ? 'RECOVERY: STEP ' + nextStep + ' → NEXT BET $' + nextBetUsd.toFixed(2)
        : 'RECOVERY: MAX STEP REACHED → $' + nextBetUsd.toFixed(2)
    : 'RECOVERY: OFF';

  const message = [
    '🔥 BTC · 5M',
    '',
    'BET: ' + tradeSide.toUpperCase(),
    'DCA BUYS: ' + trade.buysFilled,
    'TOTAL BET: $' + trade.spentUsd.toFixed(2),
    'AVG PRICE: ' + (trade.avgPrice || 0).toFixed(4),
    '',
    'RESULT: ' + result,
    'WINNER: ' + winningOutcome,
    'PAYOUT: $' + payout.toFixed(2),
    'P&L: ' + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2),
    '',
    recoveryText,
    '',
    'MARKET: ' + slug
  ].join('\n');

  await sendTelegram(message);
}

function executeTrade(symbol, slug, marketStart, marketEnd, strategySide = null) {
  if (!AUTO_TRADE_ENABLED) {
    console.log(
      '[auto-trade] DISABLED: signal received for ' + slug +
      '; side=' + (strategySide || TRADE_SIDE) +
      ' amount=$' + ORDER_AMOUNT_USD +
      ' DCA=' + DCA_BUYS_PER_PERIOD +
      ' recovery=' + RECOVERY_MODE
    );
    return Promise.resolve({ enabled: false });
  }

  return runTrade(symbol, slug, marketStart, marketEnd).catch(async error => {
    console.error('[auto-trade] FAILED ' + slug + ': ' + error.stack);
    try {
      await sendTelegram([
        '⚠️ BTC · 5M',
        '',
        'AUTO TRADE ERROR',
        'MARKET: ' + slug,
        'ERROR: ' + error.message
      ].join('\n'));
    } catch (telegramError) {
      console.error('[auto-trade] error notification failed: ' + telegramError.message);
    }
    throw error;
  });
}

module.exports = { executeTrade, executeDownBuy: executeTrade };
