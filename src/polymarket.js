const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const MARKET_BASE_URL = 'https://polymarket.com/event';
const WINDOW_MS = 5 * 60 * 1000;

function currentFiveMinuteTimestamp(now = Date.now()) {
  return Math.floor(now / WINDOW_MS) * WINDOW_MS;
}

function nextFiveMinuteTimestamp(now = Date.now()) {
  return currentFiveMinuteTimestamp(now) + WINDOW_MS;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) return null;
  return response.json();
}

async function findMarketByEpoch(symbol, epoch) {
  const asset = String(symbol || '').trim().toLowerCase();
  if (!asset) return null;

  const slug = `${asset}-updown-5m-${epoch}`;
  const url = `${GAMMA_BASE_URL}/markets/slug/${encodeURIComponent(slug)}`;
  const market = await getJson(url);

  if (market && market.slug === slug && market.active === true && market.closed !== true) {
    return {
      slug,
      url: `${MARKET_BASE_URL}/${slug}`,
      question: market.question || null,
      startDate: market.startDate || market.startDateIso || null,
      endDate: market.endDate || market.endDateIso || null,
    };
  }

  return null;
}

async function findCurrentMarket(symbol, now = Date.now()) {
  const epoch = Math.floor(currentFiveMinuteTimestamp(now) / 1000);
  return findMarketByEpoch(symbol, epoch);
}

async function findNextMarket(symbol, now = Date.now()) {
  const start = nextFiveMinuteTimestamp(now);
  // Check a small forward range because the current next market can be missing
  // briefly while Polymarket creates the next interval.
  for (let i = 0; i < 6; i += 1) {
    const epoch = Math.floor((start + i * WINDOW_MS) / 1000);
    const market = await findMarketByEpoch(symbol, epoch);
    if (market) return market;
  }

  return null;
}

module.exports = {
  findCurrentMarket,
  findNextMarket,
  currentFiveMinuteTimestamp,
  nextFiveMinuteTimestamp,
};
