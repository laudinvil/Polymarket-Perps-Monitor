const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const MARKET_BASE_URL = 'https://polymarket.com/event';
const WINDOW_MS = 5 * 60 * 1000;
const WINDOW_MS_15M = 15 * 60 * 1000;

function currentFiveMinuteTimestamp(now = Date.now()) { return Math.floor(now / WINDOW_MS) * WINDOW_MS; }
function nextFiveMinuteTimestamp(now = Date.now()) { return currentFiveMinuteTimestamp(now) + WINDOW_MS; }
function currentFifteenMinuteTimestamp(now = Date.now()) { return Math.floor(now / WINDOW_MS_15M) * WINDOW_MS_15M; }

async function getJson(url) { const response = await fetch(url, { headers: { accept: 'application/json' } }); if (!response.ok) return null; return response.json(); }

async function findMarketByEpoch(symbol, epoch, timeframe = '5m') {
  const asset = String(symbol || '').trim().toLowerCase(); if (!asset) return null;
  const slug = `${asset}-updown-${timeframe}-${epoch}`;
  const market = await getJson(`${GAMMA_BASE_URL}/markets/slug/${encodeURIComponent(slug)}`);
  if (!market || market.slug !== slug) return null;
  return { slug, url: `${MARKET_BASE_URL}/${slug}`, question: market.question || null, startDate: market.startDate || market.startDateIso || null, endDate: market.endDate || market.endDateIso || null };
}

async function findCurrentMarket(symbol, now = Date.now()) { return findMarketByEpoch(symbol, Math.floor(currentFiveMinuteTimestamp(now) / 1000), '5m'); }
async function findCurrentMarket15m(symbol, now = Date.now()) { return findMarketByEpoch(symbol, Math.floor(currentFifteenMinuteTimestamp(now) / 1000), '15m'); }
async function findNextMarket(symbol, now = Date.now()) { const start = nextFiveMinuteTimestamp(now); for (let i=0;i<6;i+=1) { const market=await findMarketByEpoch(symbol, Math.floor((start+i*WINDOW_MS)/1000), '5m'); if(market)return market; } return null; }

module.exports = { findCurrentMarket, findCurrentMarket15m, findNextMarket, currentFiveMinuteTimestamp, nextFiveMinuteTimestamp, currentFifteenMinuteTimestamp };
