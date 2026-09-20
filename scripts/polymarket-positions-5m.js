const { env } = require('node:process');

const CONVEX_SITE_URL = env.CONVEX_SITE_URL || 'https://brainy-canary-207.eu-west-1.convex.site';
const CONVEX_INGEST_TOKEN = env.CONVEX_INGEST_TOKEN || '';
const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';

const PERIOD = 300000;
const ALERT_LEAD_MS = 20000;
const COINS = ['BTC'];
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
      if (!Array.isArray(outcomes) || outcomes.length < 2) outcomes = ['UP', 'DOWN'];

      const normalized = outcomes.map(value => String(value).trim().toUpperCase());
      const upIndex = normalized.findIndex(value => value === 'UP');
      const downIndex = normalized.findIndex(value => value === 'DOWN');

      return {
        conditionId,
        upTokenId: String(tokenIds[upIndex >= 0 ? upIndex : 0]),
        downTokenId: String(tokenIds[downIndex >= 0 ? downIndex : 1])
      };
    } catch (error) {
      lastError = error;
      console.log('[positions-5m] market retry ' + attempt + '/' + MARKET_RETRIES + ': ' + error.message);
      if (attempt < MARKET_RETRIES) await sleep(MARKET_RETRY_MS);
    }
  }
  throw lastError;
}

async function holderStats(conditionId, slug) {
  const pageSize = 1000;
  let cursor = null;
  const stats = {
    UP: { holders: 0 },
    DOWN: { holders: 0 }
  };
  const holdersByOutcome = { UP: new Map(), DOWN: new Map() };

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

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const position = rows[rowIndex];
      const outcome = String(position.outcome || '').trim().toUpperCase();
      if (outcome !== 'UP' && outcome !== 'DOWN') continue;

      const shares = Number(position.current_size ?? 0);
      if (!Number.isFinite(shares) || shares <= 0) continue;


      const wallet = String(
        position.proxyWallet ??
        position.proxy_wallet ??
        position.user ??
        position.owner ??
        position.address ??
        ''
      ).trim().toLowerCase();

      const holderKey = wallet || ('row:' + outcome + ':' + page + ':' + rowIndex);
      const holder = holdersByOutcome[outcome].get(holderKey) || { shares: 0 };
      holder.shares += shares;
            holdersByOutcome[outcome].set(holderKey, holder);
    }

    if (!pagination.has_more || !pagination.next_cursor) {
      for (const outcome of ['UP', 'DOWN']) {
        const holders = holdersByOutcome[outcome];
        stats[outcome].holders = holders.size;


      }
      return stats;
    }

    cursor = pagination.next_cursor;
  }

  throw new Error('Positions pagination incomplete for ' + slug);
}

async function getReliableHolderStats(conditionId, slug) {
  let lastError;
  for (let attempt = 1; attempt <= POSITIONS_RETRIES; attempt++) {
    try {
      const stats = await holderStats(conditionId, slug);
      console.log('[positions-5m] ' + slug + ' UP holders=' + stats.UP.holders + ' DOWN holders=' + stats.DOWN.holders);
      return stats;
    } catch (error) {
      lastError = error;
      console.log('[positions-5m] holders retry ' + attempt + '/' + POSITIONS_RETRIES + ': ' + error.message);
      if (attempt < POSITIONS_RETRIES) await sleep(POSITIONS_RETRY_MS);
    }
  }
  throw new Error('Holder data unavailable after retries for ' + slug + ': ' + lastError.message);
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
  const previousStart = activeStart - PERIOD;
  const activeSlug = marketSlug(coin, activeStart);
  const previousSlug = marketSlug(coin, previousStart);
  const nextSlug = marketSlug(coin, boundary);

  console.log(
    '[positions-5m] evaluating ' + coin +
    ' active=' + activeSlug +
    ' previous=' + previousSlug +
    ' at 4:40; boundary=' + new Date(boundary).toISOString()
  );

  const activeMarket = await findMarket(activeSlug);
  const previousMarket = await findMarket(previousSlug);

  const [stats, previousStats] = await Promise.all([
    getReliableHolderStats(activeMarket.conditionId, activeSlug),
    getReliableHolderStats(previousMarket.conditionId, previousSlug)
  ]);

  const currentTotal = stats.UP.holders + stats.DOWN.holders;
  const previousTotal = previousStats.UP.holders + previousStats.DOWN.holders;

  const change = current => current > 0 ? current : 0;
  const arrow = (current, previous) => current > previous ? '↑' : current < previous ? '↓' : '→';
  const signed = (current, previous) => {
    const delta = current - previous;
    return delta > 0 ? '+' + delta : String(delta);
  };

  const message = [
    '🔥 ' + coin + ' · 5M',
    '',
    'TOTAL HOLDERS: ' + currentTotal + ' ' + arrow(currentTotal, previousTotal) + ' (' + signed(currentTotal, previousTotal) + ')',
    'UP HOLDERS: ' + stats.UP.holders + ' ' + arrow(stats.UP.holders, previousStats.UP.holders) + ' (' + signed(stats.UP.holders, previousStats.UP.holders) + ')',
    'DOWN HOLDERS: ' + stats.DOWN.holders + ' ' + arrow(stats.DOWN.holders, previousStats.DOWN.holders) + ' (' + signed(stats.DOWN.holders, previousStats.DOWN.holders) + ')',
    '',
    '➡️ NEXT · Polymarket 5M',
    'https://polymarket.com/event/' + nextSlug
  ].join('\\n');

  await sendTelegram(message);
  console.log(
    '[positions-5m] ' + activeSlug +
    ' alert sent: total=' + currentTotal + ' previous=' + previousTotal +
    ', UP=' + stats.UP.holders + '/' + previousStats.UP.holders +
    ', DOWN=' + stats.DOWN.holders + '/' + previousStats.DOWN.holders
  );
  return true;
}

async function main() {
  const stopAt = Date.now() + RUN_MS;
  let boundary = boundaryNow() + PERIOD;

  const initialWait = boundary - ALERT_LEAD_MS - Date.now();
  if (initialWait > 0) await sleep(initialWait);

  console.log('[positions-5m] 5m holder monitor started: ' + COINS.join(', '));
  console.log('[positions-5m] first evaluation (4:40)=' + new Date(boundary - ALERT_LEAD_MS).toISOString());

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
        if (result.value) console.log('[positions-5m] ' + coin + ' holder snapshot sent');
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