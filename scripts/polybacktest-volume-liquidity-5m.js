// Continuous 5m watcher: scheduling is handled by the workflow.
const { env } = require('node:process');
const API = 'https://api.polybacktest.com/v1';
const COIN = 'btc';
const PERIOD = 300000;
const GAP = 1600;
const MARKET_RETRY_MS = 15000;
const MARKET_RETRIES = 8;
const RUN_MS = 358 * 60 * 1000;
const MIN_CHANGE_PCT = 0;
const MIN_STREAK = 2;
let lastApi = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const currentBoundary = () => Math.floor(Date.now() / PERIOD) * PERIOD;
const nextBoundary = () => currentBoundary() + PERIOD;
const slug = start => `btc-updown-5m-${Math.floor(start / 1000)}`;

async function api(path) {
  const wait = GAP - (Date.now() - lastApi);
  if (wait > 0) await sleep(wait);
  lastApi = Date.now();
  const r = await fetch(`${API}${path}`, {headers:{Authorization:`Bearer ${env.POLYBACKTEST_API_KEY}`}});
  const t = await r.text();
  if (!r.ok) throw new Error(`PolyBackTest ${r.status}: ${t}`);
  return JSON.parse(t);
}

function unwrapMarket(d, fallbackSlug) {
  const candidates = [d?.market,d?.data?.market,d?.result?.market,d?.result,Array.isArray(d)?d[0]:null,d];
  const x = candidates.find(v => v && typeof v === 'object' && !Array.isArray(v) && (v.id != null || v.market_id != null || v.slug != null));
  if (!x) throw new Error(`PolyBackTest market payload has no id for ${fallbackSlug}`);
  return x;
}

async function market(s) {
  let lastError;
  for (let attempt = 1; attempt <= MARKET_RETRIES; attempt++) {
    try {
      const d = await api(`/markets/by-slug/${encodeURIComponent(s)}?coin=${COIN}`);
      const x = unwrapMarket(d, s);
      const id = x.id ?? x.market_id;
      const finalVolume = Number(x.final_volume ?? x.finalVolume);
      if (!Number.isFinite(finalVolume)) throw new Error(`Market ${s} id=${id} has no final_volume yet`);
      console.log(`[polybacktest] market ${s} id=${id} final_volume=${finalVolume.toFixed(2)} attempt=${attempt}`);
      return {id, slug:x.slug || s, finalVolume};
    } catch (e) {
      lastError = e;
      if (attempt < MARKET_RETRIES) {
        console.log(`[polybacktest] market ${s} not ready (attempt ${attempt}/${MARKET_RETRIES}): ${e.message}`);
        await sleep(MARKET_RETRY_MS);
      }
    }
  }
  throw lastError;
}

async function send(text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,disable_web_page_preview:false})
      });
      const raw = await r.text();
      const d = JSON.parse(raw);
      const messageId = d.result?.message_id;
      const actualChatId = d.result?.chat?.id;
      const chatType = d.result?.chat?.type ?? 'unknown';
      const chatIdText = String(actualChatId ?? '');
      const chatSuffix = chatIdText ? chatIdText.slice(-4) : 'none';
      console.log(`[polybacktest] Telegram attempt=${attempt} status=${r.status} ok=${d.ok} message_id=${messageId ?? 'none'} chat_type=${chatType} chat_id_suffix=${chatSuffix}`);
      const expected = String(env.TELEGRAM_CHAT_ID);
      const chatMatches = !/^-?\\d+$/.test(expected) || String(actualChatId ?? '') === expected;
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

async function processPeriod(boundary, previousVolume, streak) {
  const completedStart = boundary - PERIOD;
  const previousStart = boundary - 2*PERIOD;
  const completedSlug = slug(completedStart);
  const previousSlug = slug(previousStart);
  const nextSlug = slug(boundary);
  console.log(`[polybacktest] completed=${completedSlug} previous=${previousSlug} next=${nextSlug}`);

  const completed = await market(completedSlug);
  let previousValue = previousVolume;
  if (previousValue == null) {
    const previous = await market(previousSlug);
    console.log(`[polybacktest] ids ${previous.id} -> ${completed.id}`);
    previousValue = previous.finalVolume;
  }

  const completedVolume = completed.finalVolume;
  const delta = completedVolume - previousValue;
  const pct = previousValue === 0 ? null : (delta / previousValue) * 100;
  const direction = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  const change = pct == null ? 'N/A' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;

  if (pct == null) {
    console.log(`[polybacktest] no alert: previous volume is zero; streak preserved (${streak.count} ${streak.direction || 'none'})`);
    return { volume: completedVolume, streak };
  }

  let nextStreak;
  if (delta > 0) nextStreak = streak.direction === '↑' ? streak.count + 1 : 1;
  else if (delta < 0) nextStreak = streak.direction === '↓' ? streak.count + 1 : 1;
  else nextStreak = streak.count;
  const nextDirection = delta > 0 ? '↑' : delta < 0 ? '↓' : streak.direction;

  console.log(`[polybacktest] direction=${direction} delta=${delta.toFixed(2)} pct=${change} streak=${nextStreak}${nextDirection ? ` ${nextDirection}` : ''}`);

  if (nextStreak < MIN_STREAK) {
    console.log(`[polybacktest] no alert: streak=${nextStreak}, minimum is ${MIN_STREAK}`);
    return { volume: completedVolume, streak: {direction: nextDirection, count: nextStreak} };
  }

  const text = [
    '🔥 BTC · 5M',
    `PREVIOUS: $${previousValue.toFixed(2)}`,
    `LAST 5M: $${completedVolume.toFixed(2)}`,
    `VOLUME ${direction}: $${Math.abs(delta).toFixed(2)} · ${change}`,
    `STREAK: ${nextStreak}× ${nextDirection}`,
    '➡️ NEXT · Polymarket 5M',
    `https://polymarket.com/event/${nextSlug}`
  ].join('\\n');

  console.log(`[polybacktest] alert qualified: streak=${nextStreak} direction=${nextDirection}`);
  await send(text);
  return { volume: completedVolume, streak: {direction: nextDirection, count: nextStreak} };
}

async function restoreHistory(firstBoundary) {
  const periods = [];
  for (let i = 3; i >= 1; i--) {
    const start = firstBoundary - i * PERIOD;
    periods.push(await market(slug(start)));
  }
  let streak = {direction: null, count: 0};
  for (let i = 1; i < periods.length; i++) {
    const delta = periods[i].finalVolume - periods[i - 1].finalVolume;
    if (delta > 0) streak = {direction: '↑', count: streak.direction === '↑' ? streak.count + 1 : 1};
    else if (delta < 0) streak = {direction: '↓', count: streak.direction === '↓' ? streak.count + 1 : 1};
  }
  console.log(`[polybacktest] restored history: ${periods.map(x => x.slug + '=' + x.finalVolume.toFixed(2)).join(' | ')}`);
  console.log(`[polybacktest] restored streak=${streak.count} ${streak.direction || 'none'}`);
  return {previousVolume: periods[periods.length - 1].finalVolume, streak};
}

async function main() {
  const stopAt = Date.now() + RUN_MS;
  let boundary = currentBoundary();
  console.log('[polybacktest] volume-only BTC 5m continuous watcher');
  console.log('[polybacktest] first processing boundary=' + new Date(boundary).toISOString() + ' (last completed period)');
  console.log('[polybacktest] source: PolyBackTest v1 market final_volume');
  console.log('[polybacktest] alert rule: every non-zero change counts; alert on 2+ consecutive same-direction changes');
  console.log(`[polybacktest] run window until ${new Date(stopAt).toISOString()}`);

  let previousVolume = null;
  let streak = {direction: null, count: 0};

  try {
    const restored = await restoreHistory(boundary);
    previousVolume = restored.previousVolume;
    streak = restored.streak;
  } catch (e) {
    console.error(`[polybacktest] HISTORY RESTORE FAILED: ${e.message}`);
  }

  while (Date.now() < stopAt) {
    const wait = boundary - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= stopAt) break;
    try {
      const result = await processPeriod(boundary, previousVolume, streak);
      previousVolume = result.volume;
      streak = result.streak;
      console.log('[polybacktest] PERIOD COMPLETE boundary=' + new Date(boundary).toISOString() + ' volume=' + previousVolume.toFixed(2) + ' streak=' + streak.count + ' ' + (streak.direction || 'none'));
    } catch (e) {
      console.error(`[polybacktest] PERIOD FAILED boundary=${new Date(boundary).toISOString()}: ${e.message}`);
    }
    boundary += PERIOD;
  }
  console.log('[polybacktest] watcher window complete');
}

main().catch(e=>{console.error('[polybacktest] FAILED',e);process.exit(1);});
