const { env } = require('node:process');

const GAMMA_API = 'https://gamma-api.polymarket.com';

const AUTO_TRADE_ENABLED = String(env.POLYMARKET_AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true';
const ORDER_AMOUNT_USD = env.POLYMARKET_ORDER_AMOUNT_USD
  ? Number(env.POLYMARKET_ORDER_AMOUNT_USD)
  : null;

function requireEnv(name) {
  const value = env[name];
  if (!value) throw new Error(name + ' is required');
  return value;
}

async function gammaEvent(slug) {
  const response = await fetch(
    GAMMA_API + '/events?slug=' + encodeURIComponent(slug)
  );
  const body = await response.text();
  if (!response.ok) throw new Error('Gamma ' + response.status + ': ' + body);

  const data = JSON.parse(body);
  const event = Array.isArray(data)
    ? data.find(item => item && item.slug === slug)
    : null;
  if (!event) throw new Error('Event not found: ' + slug);

  const markets = Array.isArray(event.markets) ? event.markets : [];
  const market = markets.find(item => item && item.slug === slug) || markets[0];
  if (!market) throw new Error('Market not found: ' + slug);

  let tokenIds = market.clobTokenIds ?? market.clob_token_ids;
  let outcomes = market.outcomes;
  if (typeof tokenIds === 'string') tokenIds = JSON.parse(tokenIds);
  if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);

  if (!Array.isArray(tokenIds) || !Array.isArray(outcomes)) {
    throw new Error('Market has no CLOB token metadata: ' + slug);
  }

  const normalized = outcomes.map(value => String(value).trim().toUpperCase());
  const downIndex = normalized.findIndex(value => value === 'DOWN');
  if (downIndex < 0) throw new Error('DOWN token not found: ' + slug);

  const minimumOrderSize = Number(
    market.minimumOrderSize ??
    market.minimum_order_size ??
    market.orderMinSize ??
    market.order_min_size ??
    0
  );

  if (!Number.isFinite(minimumOrderSize) || minimumOrderSize <= 0) {
    throw new Error('Market minimum order size unavailable: ' + slug);
  }

  return {
    slug,
    assetId: String(tokenIds[downIndex]),
    minimumOrderSize
  };
}

async function getClient() {
  const { createSecureClient } = await import('@polymarket/client');
  const { privateKey } = await import('@polymarket/client/viem');

  return createSecureClient({
    wallet: requireEnv('POLYMARKET_DEPOSIT_WALLET'),
    signer: privateKey(requireEnv('POLYMARKET_PRIVATE_KEY'))
  });
}

async function executeDownBuy(slug) {
  const market = await gammaEvent(slug);
  const amount = ORDER_AMOUNT_USD ?? market.minimumOrderSize;

  if (!AUTO_TRADE_ENABLED) {
    console.log(
      '[auto-trade] DISABLED: would BUY DOWN ' + slug + ' amount=$' + amount
    );
    return { enabled: false, market };
  }

  if (!Number.isFinite(amount) || amount < market.minimumOrderSize) {
    throw new Error(
      'POLYMARKET_ORDER_AMOUNT_USD is below market minimum: ' +
      amount + ' < ' + market.minimumOrderSize
    );
  }

  const client = await getClient();
  const { OrderSide, OrderType } = await import('@polymarket/client');

  console.log(
    '[auto-trade] BUY DOWN ' + slug +
    ' amount=$' + amount +
    ' minimum=$' + market.minimumOrderSize
  );

  const order = await client.createMarketOrder({
    assetId: market.assetId,
    side: OrderSide.BUY,
    amount,
    orderType: OrderType.FAK
  });

  console.log('[auto-trade] BUY DOWN submitted: ' + JSON.stringify(order));
  return { enabled: true, market, order };
}

module.exports = { executeDownBuy };
