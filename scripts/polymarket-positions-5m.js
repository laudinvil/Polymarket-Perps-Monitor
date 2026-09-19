const { env } = require('node:process');

const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';

const PERIOD = 300000;
const ALERT_LEAD_MS = 60000;
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
const marketSlug = start => 'btc-updown-5m-' + Math.floor(start / 1000);

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
    UP: { wallets: new Set(), currentValue: 0, currentSize: 0, entryCost: 0, totalCost: 0 },
    DOWN: { wallets: new Set(), currentValue: 0, currentSize: 0, entryCost: 0, totalCost: 0 }
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

      const wallet = String(position.proxy_wallet || '').trim();
      if (!wallet) continue;

      const s = stats[outcome];
      s.wallets.add(wallet);

      const currentValue = Number(position.current_value);
      const currentSize = Number(position.current_size);
      const entryCost = Number(position.entry_cost_usdc);
      const totalCost = Number(position.total_cost_usdc);

      if (Number.isFinite(currentValue) && currentValue > 0) s.currentValue += currentValue;
      if (Number.isFinite(currentSize) && currentSize > 0) s.currentSize += currentSize;
      if (Number.isFinite(entryCost) && entryCost > 0) s.entryCost += entryCost;
      if (Number.isFinite(totalCost) && totalCost > 0) s.totalCost += totalCost;
    }

    if (!pagination.has_more || !pagination.next_cursor) {
      return {
        UP: { wallets: stats.UP.wallets.size, ...stats.UP },
        DOWN: { wallets: stats.DOWN.wallets.size, ...stats.DOWN }
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
      for (const side of ['UP', 'DOWN']) {
        const s = stats[side];
        console.log(
          '[positions-5m] ' + slug + ' ' + side +
          ' wallets=' + s.wallets +
          ' currentValue=$' + s.currentValue.toFixed(2) +
          ' currentSize=' + s.currentSize.toFixed(2) +
          ' entryCost=$' + s.entryCost.toFixed(2) +
          ' totalCost=$' + s.totalCost.toFixed(2)
        );
      }
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

async function processPeriod(boundary) {
  const activeStart = boundary - PERIOD;
  const activeSlug = marketSlug(activeStart);
  const nextSlug = marketSlug(boundary);

  console.log(
    '[positions-5m] evaluating active=' + activeSlug +
    ' during 4th minute; boundary=' + new Date(boundary).toISOString()
  );

  const activeMarket = await findMarket(activeSlug);
  const stats = await getReliablePositions(activeMarket.conditionId, activeSlug);

  const upHigher = stats.UP.currentValue > stats.DOWN.currentValue;
  const downHigher = stats.DOWN.currentValue > stats.UP.currentValue;

  const message = [
    '🔥 BTC · 5M',
    'UP: ' + stats.UP.wallets + ' wallets · $' + stats.UP.currentValue.toFixed(2) + (upHigher ? ' ⚠️' : ''),
    'DOWN: ' + stats.DOWN.wallets + ' wallets · $' + stats.DOWN.currentValue.toFixed(2) + (downHigher ? ' ⚠️' : ''),
    '➡️ NEXT · Polymarket 5M',
    'https://polymarket.com/event/' + nextSlug
  ].join('\n');

  await sendTelegram(message);
}

async function main() {
  const stopAt = Date.now() + RUN_MS;
  let boundary = boundaryNow() + PERIOD;

  const initialWait = boundary - ALERT_LEAD_MS - Date.now();
  if (initialWait > 0) await sleep(initialWait);

  console.log('[positions-5m] BTC-only 5m positions monitor started');
  console.log('[positions-5m] first evaluation=' + new Date(boundary - ALERT_LEAD_MS).toISOString());

  while (Date.now() < stopAt) {
    const wait = boundary - ALERT_LEAD_MS - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= stopAt) break;

    try {
      await processPeriod(boundary);
      boundary += PERIOD;
    } catch (error) {
      console.error('[positions-5m] PERIOD FAILED ' + new Date(boundary).toISOString() + ': ' + error.message);
      await sleep(1000);
    }
  }
}

main().catch(error => {
  console.error('[positions-5m] FAILED', error);
  process.exit(1);
});
