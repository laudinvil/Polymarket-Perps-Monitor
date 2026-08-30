const DEFAULT_MAX_TRADE_USD = 20;
const DEFAULT_MAX_PRICE = 0.55;

const num = (v) => Number.isFinite(Number(v)) ? Number(v) : NaN;

export function buildPaperOrder({ market, side, maxTradeUsd = DEFAULT_MAX_TRADE_USD, maxPrice = DEFAULT_MAX_PRICE }) {
  if (!market) throw new Error('Market is required');
  if (side !== 'UP' && side !== 'DOWN') throw new Error(`Unsupported side: ${side}`);

  const tokenId = side === 'UP' ? market.upTokenId : market.downTokenId;
  const ask = side === 'UP' ? num(market.upAsk) : num(market.downAsk);

  if (!tokenId) throw new Error(`${side} tokenId is missing`);
  if (!Number.isFinite(ask) || ask <= 0 || ask >= 1) throw new Error(`${side} ask is unavailable`);
  if (ask > maxPrice) return { ok: false, reason: 'PRICE_TOO_HIGH', side, ask, maxPrice };
  if (!(maxTradeUsd > 0)) throw new Error('maxTradeUsd must be positive');

  const shares = maxTradeUsd / ask;
  return {
    ok: true,
    mode: 'PAPER',
    action: 'BUY',
    side,
    tokenId,
    price: ask,
    usd: maxTradeUsd,
    shares,
    market: {
      asset: market.asset,
      period: market.period,
      startMs: market.startMs,
      endMs: market.endMs,
      conditionId: market.conditionId,
      slug: market.slug
    }
  };
}

export function formatPaperOrder(order) {
  if (!order?.ok) return `PAPER BUY SKIPPED: ${order?.reason ?? 'UNKNOWN'}`;
  return [
    '🧪 PAPER BUY',
    `${order.market.asset} ${order.market.period} ${order.side}`,
    `Price: ${order.price.toFixed(4)}`,
    `Size: $${order.usd.toFixed(2)}`,
    `Shares: ${order.shares.toFixed(4)}`,
    `Token: ${order.tokenId}`,
    `Market: ${order.market.slug ?? order.market.conditionId ?? 'unknown'}`
  ].join('\n');
}
