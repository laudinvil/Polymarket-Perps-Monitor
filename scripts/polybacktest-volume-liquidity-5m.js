const { env } = require('node:process');

const API = 'https://api.polybacktest.com/v4';
const COIN = 'btc';
const PERIOD = 5 * 60 * 1000;
const POLL_MS = 2000;
const MAX_WAIT_MS = 30000;
const MIN_API_GAP_MS = 1600;
let lastApi = 0;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function nextBoundary(now = Date.now()) {
  return Math.floor(now / PERIOD + 1) * PERIOD;
}

function slug(startMs) {
  return `btc-updown-5m-${Math.floor(startMs / 1000)}`;
}

async function api(path) {
  const wait = MIN_API_GAP_MS - (Date.now() - lastApi);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastApi = Date.now();
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${env.POLYBACKTEST_API_KEY}` } });
  const text = await r.text();
  if (!r.ok) throw new Error(`PolyBackTest ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function marketBySlug(s) {
  const d = await api(`/markets/by-slug/${encodeURIComponent(s)}?coin=${COIN}`);
  const x = d.market || d;
  return { id: x.id, slug: x.slug || s, volume: x.final_volume ?? x.volume ?? x.total_volume ?? x.current_volume ?? null };
}

async function liquidityAt(id, ts) {
  const d = await api(`/markets/${id}/snapshot-at/${ts}?coin=${COIN}`);
  const s = Array.isArray(d.snapshots) ? d.snapshots[0] : d.snapshot;
  if (!s) throw new Error(`No snapshot for ${id}`);
  const book = b => [...(b?.bids || []), ...(b?.asks || [])]
    .reduce((a, l) => a + num(l.price) * num(l.size), 0);
  return book(s.orderbook_up) + book(s.orderbook_down);
}

async function waitForMarket(s, deadline) {
  let lastErr;
  while (Date.now() < deadline) {
    try { return await marketBySlug(s); } catch (e) { lastErr = e; }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
  throw lastErr || new Error(`Market unavailable: ${s}`);
}

function fmt(v) { return v == null ? 'NOT PUBLISHED' : `$${num(v).toFixed(2)}`; }

async function sendTelegram(text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chat = env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error('Telegram secrets missing');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${body}`);
}

async function main() {
  console.log('[polybacktest] boundary alert: completed market -> next market');
  const boundary = nextBoundary();
  console.log(`[polybacktest] boundary=${new Date(boundary).toISOString()} wait=${Math.max(0, boundary-Date.now())}ms`);
  while (Date.now() < boundary) await new Promise(r => setTimeout(r, Math.min(1000, boundary - Date.now())));

  const completedStart = boundary - PERIOD;
  const previousStart = boundary - 2 * PERIOD;
  const completedSlug = slug(completedStart);
  const previousSlug = slug(previousStart);
  const nextSlug = slug(boundary);
  console.log(`[polybacktest] completed=${completedSlug} previous=${previousSlug} next=${nextSlug}`);

  const deadline = Date.now() + MAX_WAIT_MS;
  const completed = await waitForMarket(completedSlug, deadline);
  const previous = await waitForMarket(previousSlug, deadline);

  // Read the last snapshots of the two already-completed markets.
  const completedLiq = await liquidityAt(completed.id, boundary - 2000);
  const previousLiq = await liquidityAt(previous.id, completedStart - 2000);

  const cv = num(completed.volume);
  const pv = num(previous.volume);
  const volumeAvailable = completed.volume != null && previous.volume != null;
  const volumeDelta = cv - pv;
  const liqDelta = completedLiq - previousLiq;

  let combination;
  if (volumeDelta >= 0 && liqDelta >= 0) combination = 'VOLUME ↑ + LIQUIDITY ↑';
  else if (volumeDelta < 0 && liqDelta < 0) combination = 'VOLUME ↓ + LIQUIDITY ↓';
  else combination = 'MIXED';

  const alert = [
    `🔥 BTC · POLYBACKTEST 5M`,
    `VOLUME: ${volumeAvailable ? `${fmt(pv)} → ${fmt(cv)}` : 'NOT YET PUBLISHED'}`,
    `LIQUIDITY: $${previousLiq.toFixed(2)} → $${completedLiq.toFixed(2)}`,
    `COMBINATION: ${combination}`,
    `COMPLETED: ${completedSlug}`,
    `➡️ NEXT · POLYMARKET 5M`,
    `https://polymarket.com/event/${nextSlug}`
  ].join('\n');

  console.log(`[polybacktest] volume=${previous.volume} -> ${completed.volume}`);
  console.log(`[polybacktest] liquidity=${previousLiq.toFixed(2)} -> ${completedLiq.toFixed(2)}`);
  console.log(`[polybacktest] sending Telegram for ${nextSlug}`);
  await sendTelegram(alert);
  console.log(`[polybacktest] TELEGRAM SENT ${nextSlug}`);
}

main().catch(e => { console.error('[polybacktest] FAILED', e); process.exit(1); });
