// Continuous BTC 5m monitor: volume vs liquidity imbalance.
// One alert per completed 5m period.
// Volume: exact Polymarket trades. Liquidity: PolyBackTest snapshot-at.

const { env } = require('node:process');

const POLYMARKET_API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const POLYBACKTEST_API = 'https://api.polybacktest.com/v4';
const PERIOD = 300000;
const POLYMARKET_GAP = 1000;
const POLYBACKTEST_GAP = 1600;
const MARKET_RETRY_MS = 15000;
const MARKET_RETRIES = 8;
const FETCH_TIMEOUT_MS = 5000;
const RUN_MS = 358 * 60 * 1000;

let lastPolymarketApi = 0;
let lastPolyBackTestApi = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const currentBoundary = () => Math.floor(Date.now() / PERIOD) * PERIOD;
const slug = start => 'btc-updown-5m-' + Math.floor(start / 1000);
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function polymarketApi(path) {
  const wait = POLYMARKET_GAP - (Date.now() - lastPolymarketApi);
  if (wait > 0) await sleep(wait);
  lastPolymarketApi = Date.now();

  const r = await fetchWithTimeout(POLYMARKET_API + path);
  const t = await r.text();
  if (!r.ok) throw new Error('Polymarket ' + r.status + ': ' + t);
  return JSON.parse(t);
}

async function polybacktestApi(path) {
  const wait = POLYBACKTEST_GAP - (Date.now() - lastPolyBackTestApi);
  if (wait > 0) await sleep(wait);
  lastPolyBackTestApi = Date.now();

  const r = await fetchWithTimeout(POLYBACKTEST_API + path, {
    headers: { Authorization: 'Bearer ' + env.POLYBACKTEST_API_KEY }
  });
  const t = await r.text();
  if (!r.ok) throw new Error('PolyBackTest ' + r.status + ': ' + t);
  return JSON.parse(t);
}

async function market(s) {
  let lastError;

  for (let attempt = 1; attempt <= MARKET_RETRIES; attempt++) {
    try {
      const d = await polymarketApi('/markets?slug=' + encodeURIComponent(s));
      const x = Array.isArray(d) ? d.find(v => v && v.slug === s) : null;
      if (!x) throw new Error('Market ' + s + ' not found in Polymarket Gamma');

      const id = x.id ?? x.market_id;
      const conditionId = x.conditionId ?? x.condition_id;
      if (!conditionId) throw new Error('Market ' + s + ' has no conditionId');

      return { id, slug: x.slug || s, conditionId };
    } catch (err) {
      lastError = err;
      if (attempt < MARKET_RETRIES) {
        console.log('[combined-5m] market ' + s + ' not ready (attempt ' + attempt + '/' + MARKET_RETRIES + '): ' + err.message);
        await sleep(MARKET_RETRY_MS);
      }
    }
  }

  throw lastError;
}

async function tradeVolume(conditionId, marketSlug) {
  const start = Number(marketSlug.match(/-(\d+)$/)?.[1]);
  if (!Number.isFinite(start)) throw new Error('Invalid 5m slug timestamp: ' + marketSlug);

  const end = start + 300;
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 1000;
  let volume = 0;
  let totalRows = 0;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const url = DATA_API + '/trades?market=' + encodeURIComponent(conditionId) +
      '&limit=' + PAGE_SIZE + '&offset=' + offset +
      '&takerOnly=false&sortBy=timestamp&sortDirection=desc';

    console.log('[combined-5m] VOLUME request page=' + page + ' offset=' + offset);
    const r = await fetchWithTimeout(url);
    const t = await r.text();
    if (!r.ok) throw new Error('Polymarket Data API ' + r.status + ': ' + t);

    const trades = JSON.parse(t);
    if (!Array.isArray(trades)) throw new Error('Unexpected trades response for ' + marketSlug);

    totalRows += trades.length;
    let reachedWindowStart = false;

    for (const tr of trades) {
      let ts = Number(tr.timestamp);
      if (Number.isFinite(ts) && ts > 1e12) ts /= 1000;
      if (!Number.isFinite(ts) && typeof tr.timestamp === 'string') {
        const parsed = Date.parse(tr.timestamp);
        if (Number.isFinite(parsed)) ts = parsed / 1000;
      }
      const size = Number(tr.size);
      const price = Number(tr.price);

      if (ts < start) {
        reachedWindowStart = true;
        break;
      }

      if (ts >= start && ts < end && Number.isFinite(size) && Number.isFinite(price)) {
        volume += size * price;
      }
    }

    if (reachedWindowStart || trades.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (!complete) {
    throw new Error('Volume window incomplete for ' + marketSlug + ' rows=' + totalRows);
  }

  console.log('[combined-5m] VOLUME market=' + marketSlug + ' rows=' + totalRows + ' value=' + volume.toFixed(2));
  return volume;
}

function unwrapMarket(d, fallbackSlug) {
  const candidates = [
    d?.market,
    d?.data?.market,
    d?.result?.market,
    d?.result,
    Array.isArray(d) ? d[0] : null,
    d
  ];

  const x = candidates.find(v => v && typeof v === 'object' && !Array.isArray(v) &&
    (v.id != null || v.market_id != null || v.slug != null));

  if (!x) throw new Error('PolyBackTest market payload has no id for ' + fallbackSlug);
  return x;
}

async function polybacktestMarket(s) {
  const d = await polybacktestApi('/markets/by-slug/' + encodeURIComponent(s) + '?coin=btc');
  const x = unwrapMarket(d, s);
  const id = x.id ?? x.market_id;
  console.log('[combined-5m] LIQUIDITY market=' + s + ' id=' + id);
  return { id, slug: x.slug || s };
}

async function snapshotLiquidity(id, endMs) {
  const candidates = [
    endMs - 2000,
    endMs - 5000,
    endMs - 10000,
    endMs - 15000,
    endMs - 30000,
    endMs - 60000,
    endMs - 120000
  ];

  for (const ts of candidates) {
    try {
      const d = await polybacktestApi(
        '/markets/' + encodeURIComponent(id) + '/snapshot-at/' + ts + '?coin=btc'
      );

      const s = Array.isArray(d.snapshots) ? d.snapshots[0] : (d.snapshot || d.data?.snapshot);
      if (!s) continue;

      const sum = book => [...(book?.bids || []), ...(book?.asks || [])]
        .reduce((a, l) => a + num(l.price) * num(l.size), 0);

      const liquidity = sum(s.orderbook_up) + sum(s.orderbook_down);
      console.log('[combined-5m] LIQUIDITY id=' + id + ' snapshot=' + s.time + ' value=' + liquidity.toFixed(2));
      return liquidity;
    } catch (e) {
      console.log('[combined-5m] snapshot miss id=' + id + ' ts=' + ts + ': ' + e.message);
    }
  }

  throw new Error('No usable liquidity snapshot for market ' + id);
}

async function send(text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(
        'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text,
            disable_web_page_preview: false
          })
        }
      );

      const raw = await r.text();
      const d = JSON.parse(raw);
      const messageId = d.result?.message_id;

      console.log('[combined-5m] Telegram attempt=' + attempt + ' status=' + r.status + ' ok=' + d.ok + ' message_id=' + (messageId ?? 'none'));

      if (r.ok && d.ok === true && messageId) return true;
      throw new Error('Telegram API did not confirm delivery: ' + raw);
    } catch (e) {
      console.log('[combined-5m] Telegram attempt=' + attempt + ' failed: ' + e.message);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }

  throw new Error('Telegram delivery was not confirmed');
}

async function processPeriod(boundary) {
  const completedStart = boundary - PERIOD;
  console.log('[combined-5m] PROCESS boundary=' + new Date(boundary).toISOString());
  const completedSlug = slug(completedStart);
  const nextSlug = slug(boundary);

  console.log('[combined-5m] completed=' + completedSlug + ' next=' + nextSlug);

  console.log('[combined-5m] STEP 1/4 Polymarket market ' + completedSlug);
  const pmMarket = await market(completedSlug);
  console.log('[combined-5m] STEP 2/4 Polymarket volume');
  const volume = await tradeVolume(pmMarket.conditionId, completedSlug);

  console.log('[combined-5m] STEP 3/4 PolyBackTest market');
  const pbMarket = await polybacktestMarket(completedSlug);
  console.log('[combined-5m] STEP 4/4 PolyBackTest liquidity snapshot');
  const liquidity = await snapshotLiquidity(pbMarket.id, boundary);

  const imbalancePct = liquidity > 0 ? (volume / liquidity) * 100 : null;
  const imbalanceArrow = volume > liquidity ? '↑' : volume < liquidity ? '↓' : '→';

  const text = [
    '🔥 BTC · 5M',
    'LAST VOLUME: $' + volume.toFixed(2),
    'LAST LIQUIDITY: $' + liquidity.toFixed(2),
    'IMBALANCE: ' + imbalanceArrow + ' ' + (imbalancePct == null ? 'N/A' : imbalancePct.toFixed(2) + '%'),
    '➡️ NEXT · Polymarket 5M',
    'https://polymarket.com/event/' + nextSlug
  ].join('\n');

  console.log('[combined-5m] alert lastVolume=' + volume.toFixed(2) + ' lastLiquidity=' + liquidity.toFixed(2) + ' imbalance=' + imbalanceArrow + ' ' + (imbalancePct == null ? 'N/A' : imbalancePct.toFixed(2) + '%'));
  await send(text);
}

async function main() {
  const stopAt = Date.now() + RUN_MS;
  let boundary = currentBoundary();

  console.log('[combined-5m] BTC-only combined 5m monitor');
  console.log('[combined-5m] volume source: Polymarket Data API trades');
  console.log('[combined-5m] liquidity source: PolyBackTest snapshot-at');
  console.log('[combined-5m] rule: one alert for every completed period; no threshold, streak, percentage, or comparison filter');

  while (Date.now() < stopAt) {
    const wait = boundary - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= stopAt) break;

    try {
      await processPeriod(boundary);
      boundary += PERIOD;
    } catch (e) {
      console.error('[combined-5m] PERIOD FAILED boundary=' + new Date(boundary).toISOString() + ': ' + e.message);
      await sleep(1000);
    }
  }

  console.log('[combined-5m] watcher window complete');
}

main().catch(e => {
  console.error('[combined-5m] FAILED', e);
  process.exit(1);
});
