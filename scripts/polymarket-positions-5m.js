const { env } = require('node:process');

const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';

const PERIOD = 300000;
const ALERT_LEAD_MS = 30000;
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'DOGE', 'BNB'];
const POLYMARKET_GAP = 1000;
const FETCH_TIMEOUT_MS = 5000;
const RUN_MS = 358 * 60 * 1000;
const MARKET_RETRIES = 8;
const MARKET_RETRY_MS = 15000;
const POSITIONS_RETRIES = 4;
const POSITIONS_RETRY_MS = 500;

let lastPolymarketApi = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const boundaryNow = () => Math.floor(Date.now() / PERIOD) * PERIOD;
const marketSlug = (coin, start) => coin.toLowerCase() + '-updown-5m-' + Math.floor(start / 1000);

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

async function findMarket(slug) {
  let lastError;

  for (let attempt = 1; attempt <= MARKET_RETRIES; attempt++) {
    try {
      const data = await polymarket('/events?slug=' + encodeURIComponent(slug));
      const event = Array.isArray(data) ? data.find(item => item && item.slug === slug) : null;
      const markets = Array.isArray(event?.markets) ? event.markets : [];
      const market = markets.find(item => item && item.slug === slug) || markets[0];

      if (!market) throw new Error('Event ' + slug + ' has no market');

      const conditionId = market.conditionId ?? market.condition_id;
      if (!conditionId) throw new Error('Market ' + slug + ' has no conditionId');

      return { conditionId };
    } catch (error) {
      lastError = error;
      console.log('[positions-5m] market retry ' + attempt + '/' + MARKET_RETRIES + ': ' + error.message);
      if (attempt < MARKET_RETRIES) await sleep(MARKET_RETRY_MS);
    }
  }

  throw lastError;
}

async function positionStats(conditionId, slug) {
  const pageSize = 1000;
  let cursor = null;
  const stats = {
    UP: { wallets: new Set() },
    DOWN: { wallets: new Set() }
  };

  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({
      condition: conditionId,
      status: 'OPEN',
      limit: String(pageSize)
    });
    if (cursor) params.set('cursor', cursor);

    const response = await fetchTimeout(DATA_API + '/v2/positions?' + params.toString());
    const body = await response.text();
    if (!response.ok) {
      throw new Error('Polymarket Data API positions ' + response.status + ': ' + body);
    }

    const payload = JSON.parse(body);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const pagination = payload?.pagination || {};

    for (const position of rows) {
      const outcome = String(position.outcome || '').trim().toUpperCase();
      if (outcome !== 'UP' && outcome !== 'DOWN') continue;

      const wallet = String(position.proxyWallet ?? position.proxy_wallet ?? '').trim();
      if (!wallet) continue;

      stats[outcome].wallets.add(wallet);
    }

    if (!pagination.has_more || !pagination.next_cursor) {
      return {
        UP: stats.UP.wallets.size,
        DOWN: stats.DOWN.wallets.size
      };
    }

    cursor = pagination.next_cursor;
  }

  throw new Error('Positions pagination incomplete for ' + slug);
}

async function getReliablePositions(conditionId, slug) {
  let lastError;

  for (let attempt = 1; attempt <= POSITIONS_RETRIES; attempt++) {
    try {
      const stats = await positionStats(conditionId, slug);
      console.log(
        '[positions-5m] ' + slug +
        ' UP wallets=' + stats.UP +
        ' DOWN wallets=' + stats.DOWN
      );
      return stats;
    } catch (error) {
      lastError = error;
      console.log('[positions-5m] positions retry ' + attempt + '/' + POSITIONS_RETRIES + ': ' + error.message);
      if (attempt < POSITIONS_RETRIES) await sleep(POSITIONS_RETRY_MS);
    }
  }

  throw new Error('Positions unavailable after retries for ' + slug + ': ' + lastError.message);
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
      console.log('[positions-5m] Telegram attempt ' + attempt + ': ' + error.message);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }

  throw new Error('Telegram delivery failed');
}

async function processPeriod(coin, boundary) {
  const activeStart = boundary - PERIOD;
  const activeSlug = marketSlug(coin, activeStart);
  const nextSlug = marketSlug(coin, boundary);

  console.log(
    '[positions-5m] evaluating ' + coin +
    ' active=' + activeSlug +
    ' at 4:30; boundary=' + new Date(boundary).toISOString()
  );

  const activeMarket = await findMarket(activeSlug);
  const stats = await getReliablePositions(activeMarket.conditionId, activeSlug);

  const totalWallets = stats.UP + stats.DOWN;
  const imbalance = totalWallets > 0
    ? (stats.DOWN - stats.UP) / totalWallets * 100
    : 0;

  if (stats.DOWN <= stats.UP) {
    console.log('[positions-5m] IGNORE ' + activeSlug + ' DOWN wallets=' + stats.DOWN + ' <= UP wallets=' + stats.UP);
    return false;
  }

  const message = [
    '🔥 ' + coin + ' · 5M',
    'UP: ' + stats.UP + ' wallets',
    'DOWN: ' + stats.DOWN + ' wallets 🔥',
    'WALLETS IMBALANCE: ' + imbalance.toFixed(2) + '%',
    '➡️ NEXT · Polymarket 5M',
    '<https://polymarket.com/event/' + nextSlug + '>'
  ].join('\n');

  await sendTelegram(message);
  return true;
}

async function main() {
  const stopAt = Date.now() + RUN_MS;
  let boundary = boundaryNow() + PERIOD;

  const initialWait = boundary - ALERT_LEAD_MS - Date.now();
  if (initialWait > 0) await sleep(initialWait);

  console.log('[positions-5m] 5m positions monitor started: ' + COINS.join(', '));
  console.log('[positions-5m] first evaluation (4:30)=' + new Date(boundary - ALERT_LEAD_MS).toISOString());

  while (Date.now() < stopAt) {
    const wait = boundary - ALERT_LEAD_MS - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= stopAt) break;

    const results = await Promise.allSettled(
      COINS.map(coin => processPeriod(coin, boundary))
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const coin = COINS[i];

      if (result.status === 'fulfilled') {
        if (result.value) console.log('[positions-5m] ' + coin + ' DOWN imbalance alert sent');
      } else {
        console.error('[positions-5m] ' + coin + ' PERIOD FAILED ' + new Date(boundary).toISOString() + ': ' + result.reason.message);
      }
    }

    boundary += PERIOD;
  }
}

main().catch(error => {
  console.error('[positions-5m] FAILED', error);
  process.exit(1);
});
