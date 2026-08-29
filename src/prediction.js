const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

const ASSET_ALIASES = {
  BTC: ['btc', 'bitcoin'],
  ETH: ['eth', 'ethereum'],
  SOL: ['sol', 'solana'],
  XRP: ['xrp'],
  DOGE: ['doge', 'dogecoin'],
};

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function parseJson(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function assetSymbol(name) {
  const upper = String(name).toUpperCase();
  for (const [symbol, aliases] of Object.entries(ASSET_ALIASES)) {
    if (aliases.some(alias => upper.includes(alias.toUpperCase()))) return symbol;
  }
  return null;
}

function marketForAsset(symbol, now = Date.now()) {
  const aliases = ASSET_ALIASES[symbol] ?? [symbol.toLowerCase()];
  const bucket = Math.floor(now / 300000) * 300;
  return aliases.map(alias => `${alias}-updown-5m-${bucket}`);
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  return response.json();
}

async function getOutcomePrice(tokenId) {
  const url = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  const data = await getJson(url);
  const price = Number(data?.price);
  return Number.isFinite(price) ? price : null;
}

export async function findPredictionMarket(perpsName, now = Date.now()) {
  const symbol = assetSymbol(perpsName);
  if (!symbol) return null;

  for (const slug of marketForAsset(symbol, now)) {
    const market = await getJson(`${GAMMA_BASE}/markets/slug/${encodeURIComponent(slug)}`);
    if (!market || market.active === false || market.closed === true) continue;

    const outcomes = parseJson(market.outcomes);
    const tokenIds = parseJson(market.clobTokenIds);
    const prices = parseJson(market.outcomePrices);
    const outcomeMap = new Map(outcomes.map((x, i) => [String(x).toLowerCase(), { tokenId: tokenIds[i], price: Number(prices[i]) }]));

    const up = outcomeMap.get('up');
    const down = outcomeMap.get('down');
    if (!up || !down || !up.tokenId || !down.tokenId) continue;

    // One CLOB request for the outcome that matches the Perps direction.
    const upAsk = await getOutcomePrice(up.tokenId);
    const downAsk = await getOutcomePrice(down.tokenId);

    return {
      symbol,
      slug,
      url: `https://polymarket.com/event/${slug}`,
      question: market.question ?? `Polymarket ${symbol} Up or Down 5m`,
      upPrice: upAsk ?? up.price,
      downPrice: downAsk ?? down.price,
      endDate: market.endDate ?? null,
    };
  }

  return null;
}

export function predictionDirectionPrice(market, direction) {
  if (!market) return null;
  return direction === 'LONGS ENTERING' ? market.upPrice : market.downPrice;
}

export { sleep };
