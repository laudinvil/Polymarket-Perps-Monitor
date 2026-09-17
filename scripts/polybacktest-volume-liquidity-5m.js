const { env } = require('node:process');
const API = 'https://api.polybacktest.com/v4';
const COIN = 'btc';
const PERIOD = 300000;
const GAP = 1600;
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
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,disable_web_page_preview:false})
      });
      const raw = await r.text();
      let d;
      try { d = JSON.parse(raw); } catch { throw new Error(`invalid JSON response: ${raw}`); }
      const messageId = d.result?.message_id;
      const actualChatId = d.result?.chat?.id;
      console.log(`[polybacktest] Telegram attempt=${attempt} status=${r.status} ok=${d.ok} message_id=${messageId ?? 'none'} chat_id=${actualChatId ?? 'none'}`);
      const expected = String(env.TELEGRAM_CHAT_ID);
      const chatMatches = !/^-?\d+$/.test(expected) || String(actualChatId ?? '') === expected;
      if (r.ok && d.ok === true && messageId && chatMatches) {
        console.log(`[polybacktest] TELEGRAM CONFIRMED message_id=${messageId} chat_id=${actualChatId}`);
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

async function main() {
  const boundary = nextBoundary();
  console.log(`[polybacktest] liquidity-only BTC 5m watcher`);
  console.log(`[polybacktest] waiting for ${new Date(boundary).toISOString()}`);
  while (Date.now() < boundary) await sleep(Math.min(1000,boundary-Date.now()));

  const completedStart = boundary - PERIOD;
  const previousStart = boundary - 2*PERIOD;
  const completedSlug = slug(completedStart);
  const previousSlug = slug(previousStart);
  const nextSlug = slug(boundary);
  console.log(`[polybacktest] completed=${completedSlug} previous=${previousSlug} next=${nextSlug}`);

  const completed = await market(completedSlug);
  const previous = await market(previousSlug);
  console.log(`[polybacktest] ids ${previous.id} -> ${completed.id}`);

  const previousLiq = await snapshotLiquidity(previous.id, completedStart);
  const completedLiq = await snapshotLiquidity(completed.id, boundary);
  const delta = completedLiq - previousLiq;
  const pct = previousLiq === 0 ? null : (delta / previousLiq) * 100;
  const direction = delta > 0 ? '↑' : delta < 0 ? '↓' : '→';
  const change = pct == null ? 'N/A' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;

  const text = [
    '🔥 BTC · 5M',
    `PREVIOUS: $${previousLiq.toFixed(2)}`,
    `LAST 5M: $${completedLiq.toFixed(2)}`,
    `LIQUIDITY ${direction}: $${Math.abs(delta).toFixed(2)} · ${change}`,
    '➡️ NEXT · Polymarket 5M',
    `https://polymarket.com/event/${nextSlug}`
  ].join('\n');

  console.log('[polybacktest] sending Telegram now');
  await send(text);
  console.log(`[polybacktest] period complete ${nextSlug}`);
}
main().catch(e=>{console.error('[polybacktest] FAILED',e);process.exit(1);});
