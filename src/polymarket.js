const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const MARKET_BASE_URL = 'https://polymarket.com/event';
const WINDOW_MS = 15 * 60 * 1000;

function currentFifteenMinuteTimestamp(now = Date.now()) {
  return Math.floor(now / WINDOW_MS) * WINDOW_MS;
}

function nextFifteenMinuteTimestamp(now = Date.now()) {
  return currentFifteenMinuteTimestamp(now) + WINDOW_MS;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) return null;
  return response.json();
}

async function findMarketByEpoch(symbol, epoch) {
  const asset = String(symbol || '').trim().toLowerCase();
  if (!asset) return null;
  const slug = `${asset}-updown-15m-${epoch}`;
  const url = `${GAMMA_BASE_URL}/markets/slug/${encodeURIComponent(slug)}`;
  const market = await getJson(url);
  if (!market || market.slug !== slug) return null;
  return {
    slug,
    url: `${MARKET_BASE_URL}/${slug}`,
    question: market.question || null,
    startDate: market.startDate || market.startDateIso || null,
    endDate: market.endDate || market.endDateIso || null,
  };
}

async function findCurrentMarket(symbol, now = Date.now()) {
  const epoch = Math.floor(currentFifteenMinuteTimestamp(now) / 1000);
  return findMarketByEpoch(symbol, epoch);
}

async function findNextMarket(symbol, now = Date.now()) {
  const start = nextFifteenMinuteTimestamp(now);
  for (let i = 0; i < 6; i += 1) {
    const epoch = Math.floor((start + i * WINDOW_MS) / 1000);
    const market = await findMarketByEpoch(symbol, epoch);
    if (market) return market;
  }
  return null;
}

module.exports = { findCurrentMarket, findNextMarket, currentFifteenMinuteTimestamp, nextFifteenMinuteTimestamp };
