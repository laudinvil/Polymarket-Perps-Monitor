// Continuous BTC 5m liquidity watcher.
// Sends one alert for every completed 5m market using PolyBackTest final_liquidity.
// No streaks, no comparisons, no percentage thresholds.

const { env } = require('node:process');

const API = 'https://api.polybacktest.com';
const PERIOD = 300000;
const RETRY_MS = 15000;
const RETRIES = 8;
const RUN_MS = 358 * 60 * 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const currentBoundary = () => Math.floor(Date.now() / PERIOD) * PERIOD;
const slug = start => `btc-updown-5m-${Math.floor(start / 1000)}`;

async function marketBySlug(marketSlug) {
  let lastError;

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const url = API + '/v1/markets/by-slug/' + encodeURIComponent(marketSlug);
      const r = await fetch(url, {
        headers: { 'X-API-Key': env.POLYBACKTEST_API_KEY }
      });
      const t = await r.text();

      if (!r.ok) throw new Error('PolyBackTest ' + r.status + ': ' + t);

      const d = JSON.parse(t);
      if (!d || d.slug !== marketSlug) {
        throw new Error('Unexpected market response for ' + marketSlug);
      }

      return d;
    } catch (e) {
      lastError = e;
      if (attempt < RETRIES) {
        console.log(
          '[liquidity-5m] market ' + marketSlug +
          ' not ready (attempt ' + attempt + '/' + RETRIES + '): ' + e.message
        );
        await sleep(RETRY_MS);
      }
    }
  }

  throw lastError;
}

async function send(text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
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

      console.log(
        `[liquidity-5m] Telegram attempt=${attempt} status=${r.status} ok=${d.ok} message_id=${d.result?.message_id ?? 'none'}`
      );

      if (r.ok && d.ok === true && d.result?.message_id) {
        console.log('[liquidity-5m] TELEGRAM CONFIRMED message_id=' + d.result.message_id);
        return true;
      }

      throw new Error('Telegram API did not confirm delivery: ' + raw);
    } catch (e) {
      console.log('[liquidity-5m] Telegram attempt=' + attempt + ' failed: ' + e.message);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }

  console.log('[liquidity-5m] WARNING: Telegram delivery not confirmed');
  return false;
}

async function processPeriod(boundary) {
  const completedSlug = slug(boundary - PERIOD);
  const nextSlug = slug(boundary);

  console.log('[liquidity-5m] completed=' + completedSlug + ' next=' + nextSlug);

  const market = await marketBySlug(completedSlug);
  const liquidity = Number(market.final_liquidity);

  if (!Number.isFinite(liquidity) || liquidity < 0) {
    throw new Error('FINAL_LIQUIDITY_NOT_READY:' + completedSlug);
  }

  console.log(
    '[liquidity-5m] LIQUIDITY market=' + completedSlug +
    ' final_liquidity=' + liquidity.toFixed(2)
  );

  const text = [
    '🔥 BTC · 5M',
    `LIQUIDITY: $${liquidity.toFixed(2)}`,
    '➡️ NEXT · Polymarket 5M',
    `https://polymarket.com/event/${nextSlug}`
  ].join('\n');

  await send(text);
}

async function main() {
  const stopAt = Date.now() + RUN_MS;
  let boundary = currentBoundary();

  console.log('[liquidity-5m] BTC-only 5m liquidity watcher');
  console.log('[liquidity-5m] source: PolyBackTest final_liquidity');
  console.log('[liquidity-5m] rule: latest completed period only; no streaks; no comparisons');

  while (Date.now() < stopAt) {
    const wait = boundary - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= stopAt) break;

    try {
      await processPeriod(boundary);
      console.log('[liquidity-5m] PERIOD COMPLETE boundary=' + new Date(boundary).toISOString());
      boundary += PERIOD;
    } catch (e) {
      if (e.message.startsWith('FINAL_LIQUIDITY_NOT_READY:')) {
        console.log('[liquidity-5m] final liquidity not ready; retry SAME boundary in 15s');
        await sleep(RETRY_MS);
        continue;
      }

      console.error(
        '[liquidity-5m] PERIOD FAILED boundary=' +
        new Date(boundary).toISOString() + ': ' + e.message
      );
      boundary += PERIOD;
    }
  }

  console.log('[liquidity-5m] watcher window complete');
}

main().catch(e => {
  console.error('[liquidity-5m] FAILED', e);
  process.exit(1);
});
