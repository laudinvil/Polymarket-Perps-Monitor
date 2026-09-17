const { env } = require('node:process');

const API = 'https://api.polybacktest.com/v4';
const COIN = 'btc';

const apiKey = env.POLYBACKTEST_API_KEY;
const tgToken = env.TELEGRAM_BOT_TOKEN;
const tgChatId = env.TELEGRAM_CHAT_ID;
if (!apiKey) throw new Error('POLYBACKTEST_API_KEY is required');
if (!tgToken || !tgChatId) throw new Error('TELEGRAM secrets are required');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastRequest = 0;

async function api(path) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = Math.max(0, 1600 - (Date.now() - lastRequest));
    if (wait) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (res.status === 429 && attempt < 4) {
      let retry = 1900;
      try { retry = Math.max(1900, Number(JSON.parse(text)?.details?.retry_after || 1) * 1000 + 300); } catch {}
      console.log(`[polybacktest] rate limited; retrying in ${retry}ms`);
      await sleep(retry);
      continue;
    }
    throw new Error(`PolyBackTest ${res.status}: ${text.slice(0, 500)}`);
  }
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: tgChatId, text, disable_web_page_preview: false }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 500)}`);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function pct(a, b) { return a ? ((b - a) / a) * 100 : 0; }
function fmtPct(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`; }
function fmtUsd(v) { return `$${Math.round(v).toLocaleString('en-US')}`; }

function nextBoundary(now = Date.now()) {
  const d = new Date(now);
  d.setSeconds(0, 0);
  const minute = d.getMinutes();
  d.setMinutes(minute + (5 - (minute % 5 || 5)));
  return d.getTime();
}

function marketSlug(endMs) {
  return `btc-updown-5m-${Math.floor(endMs / 1000) - 300}`;
}

async function getMarketBySlug(slug) {
  const path = `/markets/by-slug/${encodeURIComponent(slug)}?coin=${COIN}`;
  console.log(`[polybacktest] GET ${path}`);
  const d = await api(path);
  const x = d.market || d.data?.market || d.data || d;
  const id = x.market_id ?? x.id;
  if (!id) throw new Error(`Market not found for slug ${slug}`);

  const volumeRaw = x.volume ?? x.total_volume ?? x.current_volume ?? x.final_volume;
  const volume = volumeRaw == null ? null : num(volumeRaw);
  console.log(`[polybacktest] market ${slug} id=${id} volume=${volume == null ? 'missing' : volume} final_volume=${x.final_volume ?? 'missing'}`);

  return { id, slug: x.slug ?? slug, volume };
}

function sumBook(book) {
  if (!book || typeof book !== 'object') return 0;
  return [...(book.bids || []), ...(book.asks || [])]
    .reduce((sum, level) => sum + num(level.price) * num(level.size), 0);
}

async function snapshotRequest(marketId, timestamp) {
  const path = `/markets/${encodeURIComponent(marketId)}/snapshot-at/${timestamp}?coin=${COIN}`;
  console.log(`[polybacktest] GET ${path}`);
  return api(path);
}

async function getBoundarySnapshot(market, boundaryMs, isCurrent) {
  // A newly opened Polymarket market can have its first stored snapshot a few
  // seconds after the boundary. Try the exact boundary first, then +5s.
  const candidates = isCurrent ? [boundaryMs, boundaryMs + 5000] : [boundaryMs, boundaryMs - 2000];
  let lastError;
  for (const ts of candidates) {
    try {
      const d = await snapshotRequest(market.id, ts);
      const snapshots = Array.isArray(d?.snapshots) ? d.snapshots : [];
      if (!snapshots.length) throw new Error(`empty snapshot response`);
      const s = snapshots[0];
      const liquidity = sumBook(s.orderbook_up) + sumBook(s.orderbook_down);
      console.log(`[polybacktest] snapshot ${market.id} requested=${ts} actual=${s.time} liquidity=${liquidity.toFixed(2)} price_up=${s.price_up ?? 'n/a'} price_down=${s.price_down ?? 'n/a'}`);
      if (liquidity > 0) return { liquidity, snapshotTime: s.time };
      lastError = new Error(`zero liquidity`);
    } catch (err) {
      lastError = err;
      console.log(`[polybacktest] snapshot miss ${market.id} at ${ts}: ${err.message}`);
    }
  }
  throw lastError || new Error(`No usable snapshot for ${market.id}`);
}

function alertText(prev, curr, boundaryMs) {
  const volumeAvailable = prev.volume != null && curr.volume != null && prev.volume > 0;
  const vd = volumeAvailable ? pct(prev.volume, curr.volume) : null;
  const ld = pct(prev.liquidity, curr.liquidity);
  const combination = volumeAvailable
    ? (vd >= 0 && ld >= 0 ? 'VOLUME ↑ + LIQUIDITY ↑' : vd < 0 && ld < 0 ? 'VOLUME ↓ + LIQUIDITY ↓' : 'MIXED')
    : 'LIQUIDITY ONLY (VOLUME NOT YET PUBLISHED)';
  const winner = volumeAvailable ? (vd > ld ? 'VOLUME' : ld > vd ? 'LIQUIDITY' : 'TIE') : 'LIQUIDITY';

  return [
    `🔥 BTC · POLYBACKTEST 5M`,
    volumeAvailable ? `VOLUME: ${vd >= 0 ? 'UP' : 'DOWN'} ${fmtPct(vd)}` : `VOLUME: NOT YET PUBLISHED`,
    `LIQUIDITY: ${ld >= 0 ? 'UP' : 'DOWN'} ${fmtPct(ld)}`,
    volumeAvailable ? `VOLUME: ${fmtUsd(prev.volume)} → ${fmtUsd(curr.volume)}` : `VOLUME: ${prev.volume == null ? 'N/A' : fmtUsd(prev.volume)} → N/A`,
    `LIQUIDITY: ${fmtUsd(prev.liquidity)} → ${fmtUsd(curr.liquidity)}`,
    `COMBINATION: ${combination}`,
    `WINNER: ${winner}`,
    `PERIOD: ${new Date(boundaryMs - 300000).toISOString()} → ${new Date(boundaryMs).toISOString()}`,
    '',
    '➡️ POLYMARKET 5M', `https://polymarket.com/event/${curr.slug}`,
  ].join('\n');
}

async function main() {
  console.log('[polybacktest] exact-boundary BTC 5m watcher (snapshot-at)');

  const boundary = nextBoundary();
  const wait = Math.max(0, boundary - Date.now());
  console.log(`[polybacktest] boundary=${new Date(boundary).toISOString()} wait=${Math.ceil(wait / 1000)}s`);
  if (wait) await sleep(wait);

  const currentSlug = marketSlug(boundary);
  const previousEnd = boundary - 300000;
  const previousSlug = marketSlug(previousEnd);
  console.log(`[polybacktest] target=${currentSlug} previous=${previousSlug}`);

  const curr = await getMarketBySlug(currentSlug);
  const prev = await getMarketBySlug(previousSlug);

  curr.boundary = await getBoundarySnapshot(curr, boundary, true);
  prev.boundary = await getBoundarySnapshot(prev, previousEnd, false);
  curr.liquidity = curr.boundary.liquidity;
  prev.liquidity = prev.boundary.liquidity;

  console.log(`[polybacktest] values volume=${prev.volume ?? 'N/A'}->${curr.volume ?? 'N/A'} liquidity=${prev.liquidity}->${curr.liquidity}`);
  await sendTelegram(alertText(prev, curr, boundary));
  console.log(`[polybacktest] TELEGRAM SENT ${curr.id}`);
}

main().catch(err => {
  console.error(`[polybacktest] FAILED ${err.stack || err.message}`);
  require('node:process').exitCode = 1;
});
