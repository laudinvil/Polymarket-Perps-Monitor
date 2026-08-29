const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const CLOB_BASE = 'https://clob.polymarket.com';

const ASSET_ALIASES = {
  BTC: ['btc', 'bitcoin'],
  ETH: ['eth', 'ethereum'],
  SOL: ['sol', 'solana'],
  XRP: ['xrp'],
  DOGE: ['doge', 'dogecoin'],
};

function parseJson(value, fallback = []) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function assetSymbol(name) {
  const upper = String(name).toUpperCase();
  for (const [symbol, aliases] of Object.entries(ASSET_ALIASES)) {
    if (upper === symbol || upper.includes(`${symbol}-`) || upper.includes(`${symbol}/`) || aliases.some(alias => upper.includes(alias.toUpperCase()))) return symbol;
  }
  return null;
}

function nextMarketSlugs(symbol, now = Date.now()) {
  const aliases = ASSET_ALIASES[symbol] ?? [symbol.toLowerCase()];
  const currentBucketSec = Math.floor(now / 300000) * 300;
  const nextBucketSec = currentBucketSec + 300;
  return aliases.map(alias => ({ slug: `${alias}-updown-5m-${nextBucketSec}`, nextBucketSec }));
}

async function getJson(url) {
  try {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function getOutcomePrice(tokenId) {
  const url = `${CLOB_BASE}/price?token_id=${encodeURIComponent(tokenId)}&side=BUY`;
  const data = await getJson(url);
  const p = Number(data?.price);
  return Number.isFinite(p) ? p : null;
}

export async function findPredictionMarket(perpsName, now = Date.now()) {
  const symbol = assetSymbol(perpsName);
  if (!symbol) return null;

  for (const { slug, nextBucketSec } of nextMarketSlugs(symbol, now)) {
    // The timestamp encoded in the slug is the authoritative 5m bucket we want.
    const slugTs = Number(slug.split('-').at(-1));
    if (slugTs !== nextBucketSec) continue;

    const market = await getJson(`${GAMMA_BASE}/markets/slug/${encodeURIComponent(slug)}`);
    if (!market || market.active === false || market.closed === true) continue;

    // Do NOT require Gamma startDate to equal the trading bucket start.
    // Gamma startDate can describe market activation/metadata timing rather than
    // the exact 5m interval, which previously rejected valid next markets.
    const outcomes = parseJson(market.outcomes);
    const tokenIds = parseJson(market.clobTokenIds);
    const prices = parseJson(market.outcomePrices);
    const outcomeMap = new Map(outcomes.map((x, i) => [String(x).toLowerCase(), { tokenId: tokenIds[i], price: Number(prices[i]) }]));
    const up = outcomeMap.get('up');
    const down = outcomeMap.get('down');
    if (!up || !down || !up.tokenId || !down.tokenId) continue;

    const [upAsk, downAsk] = await Promise.all([
      getOutcomePrice(up.tokenId),
      getOutcomePrice(down.tokenId),
    ]);

    return {
      symbol,
      slug,
      bucketStart: new Date(nextBucketSec * 1000).toISOString(),
      url: `https://polymarket.com/event/${slug}`,
      question: market.question ?? `Polymarket ${symbol} Up or Down 5m`,
      upPrice: upAsk ?? up.price,
      downPrice: downAsk ?? down.price,
      startDate: market.startDate ?? null,
      endDate: market.endDate ?? null,
    };
  }

  return null;
}

export function predictionDirectionPrice(market, direction) {
  if (!market) return null;
  return direction === 'LONGS ENTERING' ? market.upPrice : market.downPrice;
}
