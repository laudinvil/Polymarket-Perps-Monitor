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
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${env.POLYBACKTEST_API_KEY}` } });
  const t = await r.text();
  if (!r.ok) throw new Error(`PolyBackTest ${r.status}: ${t}`);
  return JSON.parse(t);
}

function unwrapMarket(d, fallbackSlug) {
  const candidates = [d?.market, d?.data?.market, d?.result?.market, d?.result, Array.isArray(d) ? d[0] : null, d];
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
  if (volume == null) throw new Error(`Volume is unavailable for completed market ${s}`);
  return { id, slug: x.slug || s, volume: num(volume) };
}

async function send(text) {
  const r = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: false })
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${t}`);
  return JSON.parse(t);
}

function formatUsd(value) {
  const n = num(value);
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function percentChange(previous, completed) {
  if (previous === 0) return completed === 0 ? 0 : null;
  return ((completed - previous) / previous) * 100;
}

async function main() {
  const boundary = nextBoundary();
  console.log('[polybacktest] BTC 5m VOLUME watcher');
  console.log(`[polybacktest] waiting for ${new Date(boundary).toISOString()}`);
  while (Date.now() < boundary) await sleep(Math.min(1000, boundary - Date.now()));

  const completedStart = boundary - PERIOD;
  const previousStart = boundary - 2 * PERIOD;
  const completedSlug = slug(completedStart);
  const previousSlug = slug(previousStart);
  const nextSlug = slug(boundary);

  console.log(`[polybacktest] completed=${completedSlug} previous=${previousSlug} next=${nextSlug}`);
  const completed = await market(completedSlug);
  const previous = await market(previousSlug);

  const delta = completed.volume - previous.volume;
  const pct = percentChange(previous.volume, completed.volume);
  const direction = delta > 0 ? 'VOLUME ↑' : delta < 0 ? 'VOLUME ↓' : 'VOLUME →';
  const changeText = pct == null ? 'N/A' : `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;

  const text = [
    '🔥 BTC · 5M VOLUME',
    `PREVIOUS: ${formatUsd(previous.volume)}`,
    `LAST 5M: ${formatUsd(completed.volume)}`,
    `${direction}: ${formatUsd(Math.abs(delta))} · ${changeText}`,
    `PERIOD: ${completedSlug}`,
    '➡️ NEXT · POLYMARKET 5M',
    `https://polymarket.com/event/${nextSlug}`
  ].join('\n');

  console.log(`[polybacktest] volume ${previous.volume} -> ${completed.volume} delta=${delta} pct=${pct ?? 'N/A'}`);
  console.log('[polybacktest] sending Telegram now');
  const sent = await send(text);
  if (!sent?.ok) throw new Error('Telegram response was not ok');
  console.log(`[polybacktest] TELEGRAM SENT ${nextSlug}`);
}

main().catch(e => {
  console.error('[polybacktest] FAILED', e);
  process.exit(1);
});
