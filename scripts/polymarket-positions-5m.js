const { env } = require('node:process');

const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';

const PERIOD = 300000;
const ALERT_LEAD_MS = 30000;
const COINS = ['BTC'];
const POLYMARKET_GAP = 1000;
const FETCH_TIMEOUT_MS = 5000;
const RUN_MS = 358 * 60 * 1000;
const MARKET_RETRIES = 8;
const MARKET_RETRY_MS = 15000;
const OI_RETRIES = 4;
const OI_RETRY_MS = 500;

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

      let tokenIds = market.clobTokenIds ?? market.clob_token_ids ?? market.tokens;
      let outcomes = market.outcomes;

      if (typeof tokenIds === 'string') {
        try { tokenIds = JSON.parse(tokenIds); } catch { tokenIds = null; }
      }
      if (typeof outcomes === 'string') {
        try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; }
      }

      if (!Array.isArray(tokenIds) || tokenIds.length < 2) {
        throw new Error('Market ' + slug + ' has no two CLOB token ids');
      }

      if (!Array.isArray(outcomes) || outcomes.length < 2) {
        outcomes = ['UP', 'DOWN'];
      }

      const normalized = outcomes.map(value => String(value).trim().toUpperCase());
      const upIndex = normalized.findIndex(value => value === 'UP');
      const downIndex = normalized.findIndex(value => value === 'DOWN');

      const upTokenId = String(tokenIds[upIndex >= 0 ? upIndex : 0]);
      const downTokenId = String(tokenIds[downIndex >= 0 ? downIndex : 1]);

      return { conditionId, upTokenId, downTokenId };
    } catch (error) {
      lastError = error;
      console.log('[positions-5m] market retry ' + attempt + '/' + MARKET_RETRIES + ': ' + error.message);
      if (attempt < MARKET_RETRIES) await sleep(MARKET_RETRY_MS);
    }
  }

  throw lastError;
}

async function fetchOutcomeOI(tokenId, slug, label) {
  const paths = [
    '/v2/oi?market=' + encodeURIComponent(tokenId),
    '/oi?market=' + encodeURIComponent(tokenId)
  ];

  let lastError;

  for (const path of paths) {
    try {
      const response = await fetchTimeout(DATA_API + path);
      const body = await response.text();
      if (!response.ok) {
        throw new Error('Polymarket Data API OI ' + response.status + ': ' + body);
      }

      const payload = JSON.parse(body);
      const candidates = [
        payload?.data?.value,
        payload?.data?.openInterest,
        payload?.value,
        payload?.openInterest
      ];

      const value = candidates.map(Number).find(number => Number.isFinite(number) && number >= 0);
      if (value === undefined) {
        throw new Error('OI response has no numeric value: ' + body);
      }

      return value;
    } catch (error) {
      lastError = error;
      console.log('[positions-5m] ' + label + ' OI path failed for ' + slug + ': ' + error.message);
    }
  }

  throw lastError;
}

async function getReliableOI(market, slug) {
  let lastError;

  for (let attempt = 1; attempt <= OI_RETRIES; attempt++) {
    try {
      const [up, down] = await Promise.all([
        fetchOutcomeOI(market.upTokenId, slug, 'UP'),
        fetchOutcomeOI(market.downTokenId, slug, 'DOWN')
      ]);

      const stats = { UP: up, DOWN: down };

      console.log(
        '[positions-5m] ' + slug +
        ' UP OI=

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
  const stats = await getReliableOI(activeMarket, activeSlug);

  const totalOI = stats.UP + stats.DOWN;
  const imbalance = totalOI > 0
    ? (stats.DOWN - stats.UP) / totalOI * 100
    : 0;

  if (stats.DOWN <= stats.UP) {
    console.log(
      '[positions-5m] IGNORE ' + activeSlug +
      ' DOWN OI=$' + stats.DOWN.toFixed(2) +
      ' <= UP OI=$' + stats.UP.toFixed(2)
    );
    return false;
  }

  const message = [
    '🔥 ' + coin + ' · 5M',
    'UP OI: $' + stats.UP.toFixed(2),
    'DOWN OI: $' + stats.DOWN.toFixed(2) + ' 🔥',
    'OI IMBALANCE: ' + imbalance.toFixed(2) + '% 🔥',
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

  console.log('[positions-5m] 5m OI monitor started: ' + COINS.join(', '));
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
        if (result.value) console.log('[positions-5m] ' + coin + ' DOWN OI alert sent');
      } else {
        console.error(
          '[positions-5m] ' + coin +
          ' PERIOD FAILED ' + new Date(boundary).toISOString() +
          ': ' + result.reason.message
        );
      }
    }

    boundary += PERIOD;
  }
}

main().catch(error => {
  console.error('[positions-5m] FAILED', error);
  process.exit(1);
});
 + stats.UP.toFixed(2) +
        ' DOWN OI=

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

  const totalOI = stats.UP + stats.DOWN;
  const imbalance = totalOI > 0
    ? (stats.DOWN - stats.UP) / totalOI * 100
    : 0;

  if (stats.DOWN <= stats.UP) {
    console.log(
      '[positions-5m] IGNORE ' + activeSlug +
      ' DOWN OI=$' + stats.DOWN.toFixed(2) +
      ' <= UP OI=$' + stats.UP.toFixed(2)
    );
    return false;
  }

  const message = [
    '🔥 ' + coin + ' · 5M',
    'UP OI: $' + stats.UP.toFixed(2),
    'DOWN OI: $' + stats.DOWN.toFixed(2) + ' 🔥',
    'OI IMBALANCE: ' + imbalance.toFixed(2) + '% 🔥',
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

  console.log('[positions-5m] 5m OI monitor started: ' + COINS.join(', '));
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
        if (result.value) console.log('[positions-5m] ' + coin + ' DOWN OI alert sent');
      } else {
        console.error(
          '[positions-5m] ' + coin +
          ' PERIOD FAILED ' + new Date(boundary).toISOString() +
          ': ' + result.reason.message
        );
      }
    }

    boundary += PERIOD;
  }
}

main().catch(error => {
  console.error('[positions-5m] FAILED', error);
  process.exit(1);
});
 + stats.DOWN.toFixed(2)
      );

      return stats;
    } catch (error) {
      lastError = error;
      console.log('[positions-5m] OI retry ' + attempt + '/' + OI_RETRIES + ': ' + error.message);
      if (attempt < OI_RETRIES) await sleep(OI_RETRY_MS);
    }
  }

  throw new Error('OI unavailable after retries for ' + slug + ': ' + lastError.message);
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

  const totalOI = stats.UP + stats.DOWN;
  const imbalance = totalOI > 0
    ? (stats.DOWN - stats.UP) / totalOI * 100
    : 0;

  if (stats.DOWN <= stats.UP) {
    console.log(
      '[positions-5m] IGNORE ' + activeSlug +
      ' DOWN OI=$' + stats.DOWN.toFixed(2) +
      ' <= UP OI=$' + stats.UP.toFixed(2)
    );
    return false;
  }

  const message = [
    '🔥 ' + coin + ' · 5M',
    'UP OI: $' + stats.UP.toFixed(2),
    'DOWN OI: $' + stats.DOWN.toFixed(2) + ' 🔥',
    'OI IMBALANCE: ' + imbalance.toFixed(2) + '% 🔥',
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

  console.log('[positions-5m] 5m OI monitor started: ' + COINS.join(', '));
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
        if (result.value) console.log('[positions-5m] ' + coin + ' DOWN OI alert sent');
      } else {
        console.error(
          '[positions-5m] ' + coin +
          ' PERIOD FAILED ' + new Date(boundary).toISOString() +
          ': ' + result.reason.message
        );
      }
    }

    boundary += PERIOD;
  }
}

main().catch(error => {
  console.error('[positions-5m] FAILED', error);
  process.exit(1);
});
