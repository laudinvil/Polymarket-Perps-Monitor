const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const MARKET_BASE_URL = 'https://polymarket.com/event';
const TIMEFRAMES = {
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};
const LONG_ASSET_SLUG = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  XRP: 'xrp',
  DOGE: 'dogecoin',
  BNB: 'bnb',
  HYPE: 'hyperliquid',
};

function bucketStart(now = Date.now(), timeframe = '5m') {
  return Math.floor(now / TIMEFRAMES[timeframe]) * TIMEFRAMES[timeframe];
}

function nextBucketStart(now = Date.now(), timeframe = '5m') {
  return bucketStart(now, timeframe) + TIMEFRAMES[timeframe];
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  return response.json();
}

async function findMarketBySlug(slug) {
  const market = await getJson(`${GAMMA_BASE_URL}/markets/slug/${encodeURIComponent(slug)}`);
  if (!market || market.slug !== slug) return null;
  return {
    slug,
    url: `${MARKET_BASE_URL}/${slug}`,
    question: market.question || null,
    startDate: market.startDate || market.startDateIso || null,
    endDate: market.endDate || market.endDateIso || null,
  };
}

function easternParts(epoch) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    hour12: true,
  }).formatToParts(new Date(epoch));
  return Object.fromEntries(parts.map(part => [part.type, part.value]));
}

function longTimeframeSlug(symbol, epoch, timeframe) {
  const asset = LONG_ASSET_SLUG[symbol] || symbol.toLowerCase();
  const p = easternParts(epoch);
  if (timeframe === '1d') return `${asset}-up-or-down-on-${p.month.toLowerCase()}-${Number(p.day)}-${p.year}`;
  if (timeframe === '1h') {
    return `${asset}-up-or-down-${p.month.toLowerCase()}-${Number(p.day)}-${p.year}-${Number(p.hour)}${p.dayPeriod.toLowerCase()}-et`;
  }
  return null;
}

async function findMarketByEpoch(symbol, epoch, timeframe = '5m') {
  const asset = String(symbol || '').trim().toUpperCase();
  if (!asset) return null;
  if (timeframe === '1h' || timeframe === '1d') return findMarketBySlug(longTimeframeSlug(asset, epoch, timeframe));
  const slug = `${asset.toLowerCase()}-updown-${timeframe}-${Math.floor(epoch / 1000)}`;
  return findMarketBySlug(slug);
}

async function findNextMarket(symbol, now = Date.now(), timeframe = '5m') {
  const start = nextBucketStart(now, timeframe);
  for (let i = 0; i < 12; i += 1) {
    const market = await findMarketByEpoch(symbol, start + i * TIMEFRAMES[timeframe], timeframe);
    if (market) return market;
  }
  return null;
}

module.exports = { TIMEFRAMES, bucketStart, nextBucketStart, findMarketByEpoch, findNextMarket };
