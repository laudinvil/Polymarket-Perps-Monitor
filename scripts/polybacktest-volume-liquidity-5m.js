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
  const volume = x.final_volume ?? x.volume ?? x.total_volume ?? x.current_volume ?? null;
  console.log(`[polybacktest] market ${s} id=${id} volume=${volume ?? 'missing'}`);
  return {id, slug:x.slug || s, volume};
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
      console.log(`[polybacktest] snapshot ${id} ts=${new Date(ts).toISOString()}`);
      const d = await api(`/markets/${encodeURIComponent(id)}/snapshot-at/${ts}?coin=${COIN}`);
      const s = Array.isArray(d.snapshots) ? d.snapshots[0] : (d.snapshot || d.data?.snapshot);
      if (!s) continue;
      const sum = b => [...(b?.bids || []), ...(b?.asks || [])].reduce((a,l)=>a+num(l.price)*num(l.size),0);
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
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,disable_web_page_preview:false})});
  const t = await r.text();
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${t}`);
}

async function main() {
  const boundary = nextBoundary();
  console.log(`[polybacktest] boundary BTC 5m watcher`);
  console.log(`[polybacktest] waiting for ${new Date(boundary).toISOString()}`);
  while (Date.now() < boundary) await sleep(Math.min(1000, boundary-Date.now()));

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

  const volumeText = previous.volume != null && completed.volume != null
    ? `$${num(previous.volume).toFixed(2)} → $${num(completed.volume).toFixed(2)}`
    : 'NOT YET PUBLISHED';
  const dv = previous.volume != null && completed.volume != null ? num(completed.volume)-num(previous.volume) : null;
  const dl = completedLiq-previousLiq;
  const combination = dv == null ? (dl >= 0 ? 'LIQUIDITY ↑' : 'LIQUIDITY ↓') : dv >= 0 && dl >= 0 ? 'VOLUME ↑ + LIQUIDITY ↑' : dv < 0 && dl < 0 ? 'VOLUME ↓ + LIQUIDITY ↓' : 'MIXED';

  const text = [
    '🔥 BTC · POLYBACKTEST 5M',
    `VOLUME: ${volumeText}`,
    `LIQUIDITY: $${previousLiq.toFixed(2)} → $${completedLiq.toFixed(2)}`,
    `COMBINATION: ${combination}`,
    `COMPLETED: ${completedSlug}`,
    '➡️ NEXT · POLYMARKET 5M',
    `https://polymarket.com/event/${nextSlug}`
  ].join('\n');
  console.log('[polybacktest] sending Telegram now');
  await send(text);
  console.log(`[polybacktest] TELEGRAM SENT ${nextSlug}`);
}
main().catch(e=>{console.error('[polybacktest] FAILED',e);process.exit(1);});
