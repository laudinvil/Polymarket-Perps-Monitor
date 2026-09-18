// Continuous 5m watcher: scheduling is handled by the workflow.
const { env } = require('node:process');
const API = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const PERIOD = 300000;
const GAP = 1000;
const MARKET_RETRY_MS = 15000;
const MARKET_RETRIES = 8;
const RUN_MS = 358 * 60 * 1000;
let lastApi = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const currentBoundary = () => Math.floor(Date.now() / PERIOD) * PERIOD;
const slug = start => `btc-updown-5m-${Math.floor(start / 1000)}`;

async function api(path) {
  const wait = GAP - (Date.now() - lastApi);
  if (wait > 0) await sleep(wait);
  lastApi = Date.now();

  const r = await fetch(API + path);
  const t = await r.text();
  if (!r.ok) throw new Error('Polymarket Gamma ' + r.status + ': ' + t);
  return JSON.parse(t);
}

async function market(s) {
  let lastError;
  for (let attempt = 1; attempt <= MARKET_RETRIES; attempt++) {
    try {
      const d = await api('/markets?slug=' + encodeURIComponent(s));
      const x = Array.isArray(d) ? d.find(v => v && v.slug === s) : null;
      if (!x) throw new Error('Market ' + s + ' not found in Polymarket Gamma');

      const id = x.id ?? x.market_id;
      const conditionId = x.conditionId ?? x.condition_id;
      

      if (!conditionId) throw new Error('Market ' + s + ' has no conditionId');

      return { id, slug: x.slug || s, conditionId };
    } catch (err) {
      lastError = err;
      if (attempt < MARKET_RETRIES) {
        console.log('[polybacktest] market ' + s + ' not ready (attempt ' + attempt + '/' + MARKET_RETRIES + '): ' + err.message);
        await sleep(MARKET_RETRY_MS);
      }
    }
  }
  throw lastError;
}
async function tradeVolume(conditionId, marketSlug) {
  const start = Number(marketSlug.match(/-(\d+)$/)?.[1]);
  if (!Number.isFinite(start)) throw new Error('Invalid 5m slug timestamp: ' + marketSlug);

  const startTs = start;
  const endTs = start + 300;
  const PAGE_SIZE = 1000;
  const MAX_PAGES = 1000;
  let volume = 0;
  let totalTrades = 0;
  let reachedWindowEnd = false;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const url = DATA_API + '/trades?market=' + encodeURIComponent(conditionId) +
      '&limit=' + PAGE_SIZE + '&offset=' + offset + '&takerOnly=false&sortBy=timestamp&sortDirection=desc';

    const r = await fetch(url);
    const t = await r.text();
    if (!r.ok) throw new Error('Polymarket Data API ' + r.status + ': ' + t);

    const trades = JSON.parse(t);
    if (!Array.isArray(trades)) throw new Error('Unexpected trades response for ' + marketSlug);

    totalTrades += trades.length;

    for (const tr of trades) {
      const ts = Number(tr.timestamp);
      const size = Number(tr.size);
      const price = Number(tr.price);

      if (ts < startTs) {
        reachedWindowEnd = true;
        break;
      }

      if (ts >= startTs && ts < endTs &&
          Number.isFinite(size) && Number.isFinite(price)) {
        volume += size * price;
      }
    }

    if (reachedWindowEnd || trades.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  if (!complete) {
    console.log(
      '[polybacktest] INCOMPLETE_VOLUME market=' + marketSlug +
      ' window=' + startTs + '-' + endTs +
      ' rows=' + totalTrades +
      ' pages=' + MAX_PAGES +
      ' action=SKIP_ALERT_CONTINUE'
    );
    return { volume: 0, complete: false };
  }

  console.log(
    '[polybacktest] trades market=' + marketSlug +
    ' window=' + startTs + '-' + endTs +
    ' rows=' + totalTrades +
    ' VOLUME_USDC=' + volume.toFixed(2)
  );

  return { volume, complete: true };
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
      const messageId = d.result?.message_id;
      const actualChatId = d.result?.chat?.id;
      const chatType = d.result?.chat?.type ?? 'unknown';
      const chatIdText = String(actualChatId ?? '');
      const chatSuffix = chatIdText ? chatIdText.slice(-4) : 'none';

      console.log(
        `[polybacktest] Telegram attempt=${attempt} status=${r.status} ok=${d.ok} ` +
        `message_id=${messageId ?? 'none'} chat_type=${chatType} chat_id_suffix=${chatSuffix}`
      );

      const expected = String(env.TELEGRAM_CHAT_ID);
      const chatMatches =
        !/^-?\\d+$/.test(expected) || String(actualChatId ?? '') === expected;

      if (r.ok && d.ok === true && messageId && chatMatches) {
        console.log(`[polybacktest] TELEGRAM CONFIRMED message_id=${messageId}`);
        return true;
      }

      throw new Error(`Telegram API did not confirm delivery: ${raw}`);
    } catch (e) {
      console.log(`[polybacktest] Telegram attempt=${attempt} failed: ${e.message}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }

  console.log('[polybacktest] WARNING: Telegram delivery was not confirmed after 3 attempts; continuing without failing workflow');
  return false;
}

async function processPeriod(boundary, previousVolume) {
  const completedStart = boundary - PERIOD;
  const previousStart = boundary - 2 * PERIOD;
  const completedSlug = slug(completedStart);
  const previousSlug = slug(previousStart);
  const nextSlug = slug(boundary);

  console.log(
    `[polybacktest] completed=${completedSlug} previous=${previousSlug} next=${nextSlug}`
  );

  const completed = await market(completedSlug);
  const completedResult = await tradeVolume(completed.conditionId, completedSlug);
  if (!completedResult.complete) {
    console.log('[polybacktest] SKIP alert: incomplete volume for ' + completedSlug);
    return previousVolume;
  }
  const completedVolume = completedResult.volume;

  const delta = completedVolume - previousVolume;
  const pct = previousVolume === 0 ? null : (delta / previousVolume) * 100;
  const direction = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  const change = pct == null ? 'N/A' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;

  console.log(
    `[polybacktest] PERIOD RESULT previous=${previousVolume.toFixed(2)} ` +
    `last5m=${completedVolume.toFixed(2)} delta=${delta.toFixed(2)} ` +
    `pct=${change} direction=${direction}`
  );

  const qualifies = delta !== 0;

  if (!qualifies) {
    console.log('[polybacktest] streak ignored: zero volume change');
    return completedVolume;
  }

  if (streakDirection === direction) {
    streakCount += 1;
  } else {
    streakDirection = direction;
    streakCount = 1;
  }

  console.log('[polybacktest] streak direction=' + streakDirection + ' count=' + streakCount + ' change=' + change);

  if (streakCount < 2) {
    console.log('[polybacktest] no alert: streak requires 2 consecutive qualifying moves');
    return completedVolume;
  }

  const text = [
    '🔥 BTC · 5M',
    `PREVIOUS: $${previousVolume.toFixed(2)}`,
    `LAST 5M: $${completedVolume.toFixed(2)}`,
    `VOLUME ${direction}: $${Math.abs(delta).toFixed(2)} · ${change}`,
    '➡️ NEXT · Polymarket 5M',
    `https://polymarket.com/event/${nextSlug}`
  ].join('\n');

  console.log('[polybacktest] alert qualified: 2+ consecutive same-direction non-zero moves');
  await send(text);

  return completedVolume;
}

async function main() {
  const stopAt = Date.now() + RUN_MS;
  let boundary = currentBoundary();

  console.log('[polybacktest] volume-only BTC 5m continuous watcher');
  console.log('[polybacktest] source: timestamped Polymarket trades for each exact completed 5m market');
  console.log('[polybacktest] alert rule: 2+ consecutive same-direction non-zero volume changes');
  console.log('[polybacktest] streak threshold: none; trigger: 2 consecutive non-zero moves (including from zero baseline)');
  console.log(`[polybacktest] first processing boundary=${new Date(boundary).toISOString()}`);
  console.log(`[polybacktest] run window until ${new Date(stopAt).toISOString()}`);

  let previousVolume;
  let streakDirection = null;
  let streakCount = 0;

  try {
    const previous = await market(slug(boundary - PERIOD));
    const previousResult = await tradeVolume(previous.conditionId, previous.slug);
  if (!previousResult.complete) {
    throw new Error('Initial baseline volume incomplete for ' + previous.slug);
  }
  previousVolume = previousResult.volume;

    console.log(
      `[polybacktest] BASELINE previous completed 5m=${previous.slug} ` +
      `volume=${previousVolume.toFixed(2)}`
    );
  } catch (e) {
    console.error('[polybacktest] BASELINE FAILED: ' + e.message);
  }

  while (Date.now() < stopAt) {
    const wait = boundary - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= stopAt) break;

    try {
      if (previousVolume == null) {
        const previous = await market(slug(boundary - PERIOD));
        const retryBaseline = await tradeVolume(previous.conditionId, previous.slug);
        if (!retryBaseline.complete) {
          console.log('[polybacktest] BASELINE STILL INCOMPLETE: keep watcher alive; retry SAME boundary');
          await sleep(15000);
          continue;
        }
        previousVolume = retryBaseline.volume;
        console.log(`[polybacktest] BASELINE RECOVERED previous completed 5m=${previous.slug} volume=${previousVolume.toFixed(2)}`);
      }

      previousVolume = await processPeriod(boundary, previousVolume);

      console.log(
        `[polybacktest] PERIOD COMPLETE boundary=${new Date(boundary).toISOString()} ` +
        `volume=${previousVolume.toFixed(2)}`
      );
    } catch (e) {
      console.error(
        `[polybacktest] PERIOD FAILED boundary=${new Date(boundary).toISOString()}: ${e.message}`
      );
    }

    boundary += PERIOD;
  }

  console.log('[polybacktest] watcher window complete');
}

main().catch(e => {
  console.error('[polybacktest] FAILED', e);
  process.exit(1);
});
