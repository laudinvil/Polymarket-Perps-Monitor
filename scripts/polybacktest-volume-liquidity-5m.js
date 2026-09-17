// Continuous 5m watcher: scheduling is handled by the workflow.
const { env } = require('node:process');
const API = 'https://api.polybacktest.com/v4';
const COIN = 'btc';
const PERIOD = 300000;
const GAP = 1600;
const RUN_MS = 358 * 60 * 1000;
const MIN_CHANGE_PCT = 3;
let lastApi = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = v => Number.isFinite(Number(v)) ? Number(v) : 0;
const nextBoundary = () => Math.floor(Date.now() / PERIOD + 1) * PERIOD;
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
  const d = await api(`/markets/by-slug/${encodeURIComponent(s)}?coin=${COIN}`);
  const x = unwrapMarket(d, s);
  const id = x.id ?? x.market_id;
  console.log(`[polybacktest] market ${s} id=${id}`);
  return {id, slug:x.slug || s};
}

async function snapshotLiquidity(id, endMs) {
  const candidates = [endMs - 2000,endMs - 5000,endMs - 10000,endMs - 15000,endMs - 30000,endMs - 60000,endMs - 120000];
  for (const ts of candidates) {
    try {
      console.log(`[polybacktest] snapshot ${id} ts=${new Date(ts).toISOString()}`);
      const d = await api(`/markets/${encodeURIComponent(id)}/snapshot-at/${ts}?coin=${COIN}`);
      const s = Array.isArray(d.snapshots) ? d.snapshots[0] : (d.snapshot || d.data?.snapshot);
      if (!s) continue;
      const sum = b => [...(b?.bids || []),...(b?.asks || [])].reduce((a,l)=>a+num(l.price)*num(l.size),0);
      const liquidity = sum(s.orderbook_up) + sum(s.orderbook_down);
      console.log(`[polybacktest] snapshot OK ${id} time=${s.time} liquidity=${liquidity.toFixed(2)}`);
      return liquidity;
    } catch (e) {
      console.log(`[polybacktest] snapshot miss ${id}: ${e.message}`);
    }
  }
  throw new Error(`No usable snapshot for market ${id}`);
}

async function send(text) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,disable_web_page_preview:false})
      });
      const raw = await r.text();
      let d;
      try { d = JSON.parse(raw); } catch { throw new Error(`invalid JSON response: ${raw}`); }
      const messageId = d.result?.message_id;
      const actualChatId = d.result?.chat?.id;
      const chatType = d.result?.chat?.type ?? 'unknown';
      const chatIdText = String(actualChatId ?? '');
      const chatSuffix = chatIdText ? chatIdText.slice(-4) : 'none';
      console.log(`[polybacktest] Telegram attempt=${attempt} status=${r.status} ok=${d.ok} message_id=${messageId ?? 'none'} chat_type=${chatType} chat_id_suffix=${chatSuffix}`);
      const expected = String(env.TELEGRAM_CHAT_ID);
      const chatMatches = !/^-?\d+$/.test(expected) || String(actualChatId ?? '') === expected;
      if (r.ok && d.ok === true && messageId && chatMatches) {
        console.log(`[polybacktest] TELEGRAM CONFIRMED message_id=${messageId} chat_type=${chatType} chat_id_suffix=${chatSuffix}`);
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

async function processPeriod(boundary, previousLiq, streak) {
  const completedStart = boundary - PERIOD;
  const previousStart = boundary - 2*PERIOD;
  const completedSlug = slug(completedStart);
  const previousSlug = slug(previousStart);
  const nextSlug = slug(boundary);
  console.log(`[polybacktest] completed=${completedSlug} previous=${previousSlug} next=${nextSlug}`);

  const completed = await market(completedSlug);
  let previousValue = previousLiq;
  if (previousValue == null) {
    const previous = await market(previousSlug);
    console.log(`[polybacktest] ids ${previous.id} -> ${completed.id}`);
    previousValue = await snapshotLiquidity(previous.id, completedStart);
  } else {
    console.log(`[polybacktest] previous liquidity carried forward=${previousValue.toFixed(2)}`);
    console.log(`[polybacktest] completed id=${completed.id}`);
  }

  const completedLiq = await snapshotLiquidity(completed.id, boundary);
  const delta = completedLiq - previousValue;
  const pct = previousValue === 0 ? null : (delta / previousValue) * 100;
  const direction = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  const change = pct == null ? 'N/A' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;

  let nextStreak;
  if (delta > 0) nextStreak = streak.direction === '↑' ? streak.count + 1 : 1;
  else if (delta < 0) nextStreak = streak.direction === '↓' ? streak.count + 1 : 1;
  else nextStreak = 0;
  const nextDirection = delta > 0 ? '↑' : delta < 0 ? '↓' : null;

  console.log(`[polybacktest] direction=${direction} delta=${delta.toFixed(2)} pct=${change} streak=${nextStreak}${nextDirection ? ` ${nextDirection}` : ''}`);

  if (pct == null || Math.abs(pct) < MIN_CHANGE_PCT) {
    console.log(`[polybacktest] no alert: liquidity change ${change} is below ${MIN_CHANGE_PCT}% threshold`);
    return { liquidity: completedLiq, streak: {direction: nextDirection, count: nextStreak} };
  }

  if (nextStreak < 2) {
    console.log(`[polybacktest] no alert: streak=${nextStreak}, minimum is 2`);
    return { liquidity: completedLiq, streak: {direction: nextDirection, count: nextStreak} };
  }

  const text = [
    '🔥 BTC · 5M',
    `PREVIOUS: $${previousValue.toFixed(2)}`,
    `LAST 5M: $${completedLiq.toFixed(2)}`,
    `LIQUIDITY ${direction}: $${Math.abs(delta).toFixed(2)} · ${change}`,
    `STREAK: ${nextStreak}× ${nextDirection}`,
    '➡️ NEXT · Polymarket 5M',
    `https://polymarket.com/event/${nextSlug}`
  ].join('\n');

  console.log(`[polybacktest] alert qualified: streak=${nextStreak} direction=${nextDirection}`);
  console.log('[polybacktest] sending Telegram now');
  await send(text);
  console.log(`[polybacktest] period complete ${nextSlug}`);
  return { liquidity: completedLiq, streak: {direction: nextDirection, count: nextStreak} };
}

async function main() {
  const stopAt = Date.now() + RUN_MS;
  let boundary = nextBoundary();
  let previousLiq = null;
  let streak = {direction: null, count: 0};
  console.log('[polybacktest] liquidity-only BTC 5m continuous watcher');
  console.log('[polybacktest] alert rule: 2+ consecutive moves, each with absolute liquidity change >= 3%');
  console.log(`[polybacktest] run window until ${new Date(stopAt).toISOString()}`);

  while (Date.now() < stopAt) {
    const wait = boundary - Date.now();
    if (wait > 0) await sleep(wait);
    if (Date.now() >= stopAt) break;
    try {
      const result = await processPeriod(boundary, previousLiq, streak);
      previousLiq = result.liquidity;
      streak = result.streak;
    } catch (e) {
      console.error(`[polybacktest] PERIOD FAILED boundary=${new Date(boundary).toISOString()}: ${e.message}`);
    }
    boundary += PERIOD;
  }
  console.log('[polybacktest] watcher window complete');
}

main().catch(e=>{console.error('[polybacktest] FAILED',e);process.exit(1);});