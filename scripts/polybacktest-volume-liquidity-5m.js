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
const TRADES_RETRIES = 4;
const TRADES_RETRY_MS = 500;

let lastPolymarketApi = 0;

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

      return { conditionId };
    } catch (error) {
      lastError = error;
      console.log('[combined-5m] market retry ' + attempt + '/' + MARKET_RETRIES + ': ' + error.message);
      if (attempt < MARKET_RETRIES) await sleep(MARKET_RETRY_MS);
    }
  }

  throw lastError;
}

async function tradeStats(conditionId, start, end, slug) {
  const pageSize = 1000;
  let cursor = null;
  let volume = 0;

  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({
      condition: conditionId,
      limit: String(pageSize)
    });
    if (cursor) params.set('cursor', cursor);

    const response = await fetchTimeout(DATA_API + '/v2/trades?' + params.toString());
    const body = await response.text();
    if (!response.ok) throw new Error('Polymarket Data API v2 ' + response.status + ': ' + body);

    const payload = JSON.parse(body);
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const pagination = payload?.pagination || {};

    let reachedStart = false;

    for (const trade of rows) {
      let timestamp = Number(trade.timestamp ?? trade.ts ?? trade.created_at ?? trade.createdAt);
      if (Number.isFinite(timestamp) && timestamp > 1e12) timestamp /= 1000;

      if (!Number.isFinite(timestamp) && typeof trade.timestamp === 'string') {
        const parsed = Date.parse(trade.timestamp);
        if (Number.isFinite(parsed)) timestamp = parsed / 1000;
      }

      if (!Number.isFinite(timestamp)) continue;
      if (timestamp < start) {
        reachedStart = true;
        break;
      }

      if (timestamp >= start && timestamp < end) {
        const size = number(trade.size ?? trade.amount ?? trade.quantity);
        const price = number(trade.price ?? trade.execution_price);
        volume += size * price;
      }
    }

    if (reachedStart || !pagination.has_more || !pagination.next_cursor) {
      if (volume <= 0) throw new Error('Trades API returned 0 volume for active period');
      return { volume };
    }

    cursor = pagination.next_cursor;
  }

  throw new Error('Trades window incomplete for ' + slug);
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

async function getReliableTradeStats(conditionId, start, end, slug) {
  let lastError;

  for (let attempt = 1; attempt <= TRADES_RETRIES; attempt++) {
    try {
      const stats = await tradeStats(conditionId, start, end, slug);
      console.log('[combined-5m] volume attempt ' + attempt + '/' + TRADES_RETRIES +
        ' volume=$' + stats.volume.toFixed(2));
      return stats;
    } catch (error) {
      lastError = error;
      console.log('[combined-5m] volume retry ' + attempt + '/' + TRADES_RETRIES + ': ' + error.message);
      if (attempt < TRADES_RETRIES) await sleep(TRADES_RETRY_MS);
    }
  }

  throw new Error('Volume unavailable after retries for ' + slug + ': ' + lastError.message);
}

async function processPeriod(boundary) {
  const activeStart = boundary - PERIOD;
  const evaluationEndMs = Math.min(Date.now(), boundary - 1000);
  const activeSlug = marketSlug(activeStart);
  const nextSlug = marketSlug(boundary);
  const previousStart = activeStart - PERIOD;
  const previousSlug = marketSlug(previousStart);

  console.log('[combined-5m] evaluating active=' + activeSlug +
    ' end=' + new Date(evaluationEndMs).toISOString() +
    ' boundary=' + new Date(boundary).toISOString());

  const polymarketMarket = await findMarket(activeSlug);
  const { volume } = await getReliableTradeStats(
    polymarketMarket.conditionId,
    activeStart / 1000,
    evaluationEndMs / 1000,
    activeSlug
  );

  const previousMarket = await findMarket(previousSlug);
  const { volume: previousVolume } = await getReliableTradeStats(
    previousMarket.conditionId,
    previousStart / 1000,
    activeStart / 1000,
    previousSlug
  );

  const change = previousVolume > 0
    ? ((volume - previousVolume) / previousVolume) * 100
    : 0;

  console.log('[combined-5m] current volume=$' + volume.toFixed(2) +
    ' previous volume=$' + previousVolume.toFixed(2) +
    ' change=' + change.toFixed(2) + '%');

  const message = [
    '🔥 BTC · 5M',
    'VOLUME: $' + volume.toFixed(2),
    'CHANGE: ' + (change >= 0 ? '+' : '') + change.toFixed(2) + '%',
    '➡️ NEXT · Polymarket 5M',
    'https://polymarket.com/event/' + nextSlug
  ].join('\n');

  await sendTelegram(message);
}

async function main() {
  const stopAt = Date.now() + RUN_MS;

  // On every workflow restart, never replay an already completed 5M period.
  // Start from the next period boundary and evaluate it 60s before it ends.
  let boundary = boundaryNow() + PERIOD;

  const initialWait = boundary - ALERT_LEAD_MS - Date.now();
  if (initialWait > 0) await sleep(initialWait);

  console.log('[combined-5m] BTC-only 5m trades monitor started');
  console.log('[combined-5m] first new period boundary=' + new Date(boundary).toISOString());

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
      // Keep the same boundary on failure so the period can be retried,
      // but never advance into a different period after a failed attempt.
      await sleep(1000);
    }
  }
}

main().catch(error => {
  console.error('[combined-5m] FAILED', error);
  process.exit(1);
});
