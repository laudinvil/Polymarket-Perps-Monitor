// Continuous BTC 5m liquidity watcher.
// Sends one alert for every completed 5m period.
// Uses PolyBackTest snapshot-at. No comparisons, streaks, or percentage thresholds.

const { env } = require('node:process');

const API = 'https://api.polybacktest.com/v4';
const COIN = 'btc';
const PERIOD = 300000;
const GAP = 1600;
const RUN_MS = 358 * 60 * 1000;

let lastApi = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const nextBoundary = () => Math.floor(Date.now() / PERIOD + 1) * PERIOD;
const slug = start => 'btc-updown-5m-' + Math.floor(start / 1000);

async function api(path) {
  const wait = GAP - (Date.now() - lastApi);
  if (wait > 0) await sleep(wait);
  lastApi = Date.now();

  const r = await fetch(API + path, {
    headers: { Authorization: 'Bearer ' + env.POLYBACKTEST_API_KEY }
  });
  const t = await r.text();

  if (!r.ok) throw new Error('PolyBackTest ' + r.status + ': ' + t);
  return JSON.parse(t);
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

  const x = candidates.find(
    v => v && typeof v === 'object' && !Array.isArray(v) &&
      (v.id != null || v.market_id != null || v.slug != null)
  );

  if (!x) throw new Error('PolyBackTest market payload has no id for ' + fallbackSlug);
  return x;
}

async function market(s) {
  const d = await api('/markets/by-slug/' + encodeURIComponent(s) + '?coin=' + COIN);
  const x = unwrapMarket(d, s);
  const id = x.id ?? x.market_id;

  console.log('[liquidity-5m] market ' + s + ' id=' + id);
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
      console.log('[liquidity-5m] snapshot id=' + id + ' ts=' + new Date(ts).toISOString());

      const d = await api(
        '/markets/' + encodeURIComponent(id) + '/snapshot-at/' + ts + '?coin=' + COIN
      );

      const s = Array.isArray(d.snapshots)
        ? d.snapshots[0]
        : (d.snapshot || d.data?.snapshot);

      if (!s) continue;

      const sum = b =>
        [...(b?.bids || []), ...(b?.asks || [])]
          .reduce((a, l) => a + num(l.price) * num(l.size), 0);

      const liquidity = sum(s.orderbook_up) + sum(s.orderbook_down);

      console.log(
        '[liquidity-5m] snapshot OK id=' + id +
        ' time=' + s.time +
        ' liquidity=' + liquidity.toFixed(2)
      );

      return liquidity;
    } catch (e) {
      console.log('[liquidity-5m] snapshot miss id=' + id + ': ' + e.message);
    }
  }

  throw new Error('No usable snapshot for market ' + id);
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

      console.log(
        '[liquidity-5m] Telegram attempt=' + attempt +
        ' status=' + r.status +
        ' ok=' + d.ok +
        ' message_id=' + (messageId ?? 'none')
      );

      if (r.ok && d.ok === true && messageId) {
        console.log('[liquidity-5m] TELEGRAM CONFIRMED message_id=' + messageId);
        return true;
      }

      throw new Error('Telegram API did not confirm delivery: ' + raw);
    } catch (e) {
      console.log('[liquidity-5m] Telegram attempt=' + attempt + ' failed: ' + e.message);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }

  throw new Error('Telegram delivery was not confirmed');
}

async function processPeriod(boundary) {
  const completedSlug = slug(boundary - PERIOD);
  const nextSlug = slug(boundary);

  console.log('[liquidity-5m] completed=' + completedSlug + ' next=' + nextSlug);

  const completed = await market(completedSlug);
  const liquidity = await snapshotLiquidity(completed.id, boundary);

  const text = [
    '🔥 BTC · 5M',
    'LIQUIDITY: $' + liquidity.toFixed(2),
    '➡️ NEXT · Polymarket 5M',
    'https://polymarket.com/event/' + nextSlug
  ].join('\n');

  console.log('[liquidity-5m] sending Telegram now');
  await send(text);

  console.log(
    '[liquidity-5m] PERIOD COMPLETE completed=' + completedSlug +
    ' next=' + nextSlug
  );
}

async function main() {
  const stopAt = Date.now() + RUN_MS;
  let boundary = nextBoundary();

  console.log('[liquidity-5m] BTC-only 5m liquidity watcher');
  console.log('[liquidity-5m] source: PolyBackTest snapshot-at');
  console.log('[liquidity-5m] rule: one alert for every completed period; no comparisons; no streaks');

  while (Date.now() < stopAt) {
    const wait = boundary - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= stopAt) break;

    try {
      await processPeriod(boundary);
      boundary += PERIOD;
    } catch (e) {
      console.error(
        '[liquidity-5m] PERIOD FAILED boundary=' +
        new Date(boundary).toISOString() + ': ' + e.message
      );
      // Do not skip the period after a data/API failure.
      await sleep(1000);
    }
  }

  console.log('[liquidity-5m] watcher window complete');
}

main().catch(e => {
  console.error('[liquidity-5m] FAILED', e);
  process.exit(1);
});
