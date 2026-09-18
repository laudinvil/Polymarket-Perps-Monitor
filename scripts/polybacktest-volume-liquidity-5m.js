const { env } = require('node:process');

const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const POLYBACKTEST_API = 'https://api.polybacktest.com/v4';

const PERIOD = 300000;
const ALERT_LEAD_MS = 0;
const POLYMARKET_GAP = 1000;
const POLYBACKTEST_GAP = 1600;
const FETCH_TIMEOUT_MS = 5000;
const RUN_MS = 358 * 60 * 1000;
const MARKET_RETRIES = 8;
const MARKET_RETRY_MS = 15000;
const TRADES_RETRIES = 6;
const TRADES_RETRY_MS = 1000;

let lastPolymarketApi = 0;
let lastPolyBackTestApi = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const boundaryNow = () => Math.floor(Date.now() / PERIOD) * PERIOD;
const marketSlug = start => 'btc-updown-5m-' + Math.floor(start / 1000);
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;

async function fetchTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function polymarket(path) {
  const wait = POLYMARKET_GAP - (Date.now() - lastPolymarketApi);
  if (wait > 0) await sleep(wait);
  lastPolymarketApi = Date.now();

  const response = await fetchTimeout(POLYMARKET_API + path);
  const body = await response.text();
  if (!response.ok) throw new Error('Polymarket ' + response.status + ': ' + body);
  return JSON.parse(body);
}

async function polybacktest(path) {
  const wait = POLYBACKTEST_GAP - (Date.now() - lastPolyBackTestApi);
  if (wait > 0) await sleep(wait);
  lastPolyBackTestApi = Date.now();

  const response = await fetchTimeout(POLYBACKTEST_API + path, {
    headers: { Authorization: 'Bearer ' + env.POLYBACKTEST_API_KEY }
  });
  const body = await response.text();
  if (!response.ok) throw new Error('PolyBackTest ' + response.status + ': ' + body);
  return JSON.parse(body);
}

async function findMarket(slug) {
  let lastError;

  for (let attempt = 1; attempt <= MARKET_RETRIES; attempt++) {
    try {
      const data = await polymarket('/events?slug=' + encodeURIComponent(slug));
      const event = Array.isArray(data) ? data.find(item => item && item.slug === slug) : null;
      const markets = Array.isArray(event?.markets) ? event.markets : [];
      const market = markets.find(item => item && (item.slug === slug || item.conditionId || item.condition_id)) || markets[0];

      if (!market) throw new Error('Event ' + slug + ' has no market');

      const conditionId = market.conditionId ?? market.condition_id;
      if (!conditionId) throw new Error('Market ' + slug + ' has no conditionId');

      return {
        id: market.id ?? market.market_id,
        conditionId
      };
    } catch (error) {
      lastError = error;
      console.log('[combined-5m] market retry ' + attempt + '/' + MARKET_RETRIES + ': ' + error.message);
      if (attempt < MARKET_RETRIES) await sleep(MARKET_RETRY_MS);
    }
  }

  throw lastError;
}

async function tradeCount(conditionId, start, slug) {
  if (!Number.isFinite(start)) throw new Error('Invalid period start: ' + start);

  const end = start + 300;
  const pageSize = 1000;
  let tradesInWindow = 0;

  for (let page = 0; page < 1000; page++) {
    const offset = page * pageSize;
    const url = DATA_API + '/trades?market=' + encodeURIComponent(conditionId) +
      '&limit=' + pageSize + '&offset=' + offset +
      '&takerOnly=false&sortBy=timestamp&sortDirection=desc';

    const response = await fetchTimeout(url);
    const body = await response.text();
    if (!response.ok) throw new Error('Polymarket Data API ' + response.status + ': ' + body);

    const trades = JSON.parse(body);
    if (!Array.isArray(trades)) throw new Error('Invalid trades response for ' + slug);

    let reachedStart = false;

    for (const trade of trades) {
      let timestamp = Number(trade.timestamp);
      if (Number.isFinite(timestamp) && timestamp > 1e12) timestamp /= 1000;
      if (!Number.isFinite(timestamp) && typeof trade.timestamp === 'string') {
        const parsed = Date.parse(trade.timestamp);
        if (Number.isFinite(parsed)) timestamp = parsed / 1000;
      }

      if (timestamp < start) {
        reachedStart = true;
        break;
      }

      if (timestamp >= start && timestamp < end) {
        tradesInWindow++;
      }
    }

    if (reachedStart || trades.length < pageSize) return tradesInWindow;
  }

  throw new Error('Trades window incomplete for ' + slug);
}

function unwrapMarket(data, slug) {
  const candidates = [
    data?.market,
    data?.data?.market,
    data?.result?.market,
    data?.result,
    Array.isArray(data) ? data[0] : null,
    data
  ];

  const market = candidates.find(value =>
    value && typeof value === 'object' && !Array.isArray(value) &&
    (value.id != null || value.market_id != null || value.slug != null)
  );

  if (!market) throw new Error('PolyBackTest market has no id for ' + slug);
  return market;
}

async function polybacktestMarket(slug) {
  const data = await polybacktest('/markets/by-slug/' + encodeURIComponent(slug) + '?coin=btc');
  const market = unwrapMarket(data, slug);
  return market.id ?? market.market_id;
}

async function liquiditySnapshot(id, endMs) {
  const timestamp = endMs - 1000;

  const data = await polybacktest(
    '/markets/' + encodeURIComponent(id) + '/snapshot-at/' + timestamp + '?coin=btc'
  );

  const snapshot = Array.isArray(data.snapshots)
    ? data.snapshots[0]
    : (data.snapshot || data.data?.snapshot);

  if (!snapshot) {
    throw new Error(
      'No snapshot at completed-period boundary for market ' + id +
      ' requested=' + new Date(timestamp).toISOString()
    );
  }

  const bookValue = book =>
    [...(book?.bids || []), ...(book?.asks || [])]
      .reduce((sum, level) => sum + number(level.price) * number(level.size), 0);

  const up = bookValue(snapshot.orderbook_up);
  const down = bookValue(snapshot.orderbook_down);
  const liquidity = up + down;

  console.log(
    '[combined-5m] liquidity snapshot requested=' + new Date(timestamp).toISOString() +
    ' actual=' + (snapshot.time || 'unknown') +
    ' up=' + up.toFixed(2) +
    ' down=' + down.toFixed(2) +
    ' total=' + liquidity.toFixed(2)
  );

  return liquidity;
}

async function sendTelegram(message) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(
        'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: message,
            disable_web_page_preview: false
          })
        }
      );

      const body = await response.text();
      const data = JSON.parse(body);

      if (response.ok && data.ok === true && data.result?.message_id) return;
      throw new Error('Telegram delivery not confirmed: ' + body);
    } catch (error) {
      console.log('[combined-5m] Telegram attempt ' + attempt + ': ' + error.message);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }

  throw new Error('Telegram delivery failed');
}

async function getReliableTrades(conditionId, start, slug) {
  let lastError;

  for (let attempt = 1; attempt <= TRADES_RETRIES; attempt++) {
    try {
      const trades = await tradeCount(conditionId, start, slug);

      if (trades > 0) {
        console.log('[combined-5m] trades attempt ' + attempt + '/' + TRADES_RETRIES +
          ' count=' + trades);
        return trades;
      }

      throw new Error('Trades API returned 0 trades for completed period');
    } catch (error) {
      lastError = error;
      console.log('[combined-5m] trades retry ' + attempt + '/' + TRADES_RETRIES + ': ' + error.message);
      if (attempt < TRADES_RETRIES) await sleep(TRADES_RETRY_MS);
    }
  }

  throw new Error('Trades unavailable after retries for ' + slug + ': ' + lastError.message);
}

async function processPeriod(boundary) {
  const completedStart = boundary - PERIOD;
  const completedSlug = marketSlug(completedStart);
  const nextSlug = marketSlug(boundary);

  const [polymarketMarket, polybacktestId] = await Promise.all([
    findMarket(completedSlug),
    polybacktestMarket(completedSlug)
  ]);

  const [trades, liquidity] = await Promise.all([
    getReliableTrades(polymarketMarket.conditionId, completedStart / 1000, completedSlug),
    liquiditySnapshot(polybacktestId, boundary)
  ]);

  const ratio = liquidity > 0 ? (trades / liquidity) * 100 : 0;
  const liquidityMark = liquidity > trades ? ' ⚠️' : '';
  const tradesMark = trades > liquidity ? ' ⚠️' : '';

  const message = [
    '🔥 BTC · 5M',
    'TRADES: ' + trades + tradesMark,
    'LIQUIDITY: $' + liquidity.toFixed(2) + liquidityMark,
    'TRADES/LIQUIDITY: ' + ratio.toFixed(4) + '%',
    '➡️ NEXT · Polymarket 5M',
    'https://polymarket.com/event/' + nextSlug
  ].join('\n');

  await sendTelegram(message);
}

async function main() {
  const stopAt = Date.now() + RUN_MS;
  let boundary = boundaryNow();

  const initialWait = boundary - ALERT_LEAD_MS - Date.now();
  if (initialWait > 0) await sleep(initialWait);

  console.log('[combined-5m] BTC-only 5m trades monitor started');

  while (Date.now() < stopAt) {
    const wait = boundary - ALERT_LEAD_MS - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= stopAt) break;

    try {
      await processPeriod(boundary);
      boundary += PERIOD;
    } catch (error) {
      console.error(
        '[combined-5m] PERIOD FAILED ' +
        new Date(boundary).toISOString() + ': ' + error.message
      );
      await sleep(1000);
    }
  }
}

main().catch(error => {
  console.error('[combined-5m] FAILED', error);
  process.exit(1);
});
