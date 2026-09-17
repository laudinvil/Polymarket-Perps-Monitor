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

function marketSlug(startMs) {
  return `btc-updown-5m-${Math.floor(startMs / 1000)}`;
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

async function getEndLiquidity(market, endMs) {
  // Use a snapshot just before the market ends. The exact end timestamp can
  // have no stored snapshot because the market is no longer active then.
  const candidates = [endMs - 2000, endMs - 1000];
  let lastError;
  for (const ts of candidates) {
    try {
      const path = `/markets/${encodeURIComponent(market.id)}/snapshot-at/${ts}?coin=${COIN}`;
      console.log(`[polybacktest] GET ${path}`);
      const d = await api(path);
      const snapshots = Array.isArray(d?.snapshots) ? d.snapshots : [];
      if (!snapshots.length) throw new Error('empty snapshot response');
      const s = snapshots[0];
      const liquidity = sumBook(s.orderbook_up) + sumBook(s.orderbook_down);
      console.log(`[polybacktest] end snapshot ${market.id} requested=${ts} actual=${s.time} liquidity=${liquidity.toFixed(2)}`);
      if (liquidity > 0) return { liquidity, snapshotTime: s.time };
      lastError = new Error('zero liquidity');
    } catch (err) {
      lastError = err;
      console.log(`[polybacktest] end snapshot miss ${market.id} at ${ts}: ${err.message}`);
    }
  }
  throw lastError || new Error(`No usable end snapshot for ${market.id}`);
}

function alertText(previous, completed, nextMarket, completedEndMs) {
  const volumeAvailable = previous.volume != null && completed.volume != null && previous.volume > 0;
  const vd = volumeAvailable ? pct(previous.volume, completed.volume) : null;
  const ld = pct(previous.liquidity, completed.liquidity);
  const combination = volumeAvailable
    ? (vd >= 0 && ld >= 0 ? 'VOLUME ↑ + LIQUIDITY ↑' : vd < 0 && ld < 0 ? 'VOLUME ↓ + LIQUIDITY ↓' : 'MIXED')
    : 'LIQUIDITY ONLY (VOLUME NOT YET PUBLISHED)';
  const winner = volumeAvailable ? (vd > ld ? 'VOLUME' : ld > vd ? 'LIQUIDITY' : 'TIE') : 'LIQUIDITY';

  return [
    `🔥 BTC · POLYBACKTEST 5M`,
    volumeAvailable ? `VOLUME: ${vd >= 0 ? 'UP' : 'DOWN'} ${fmtPct(vd)}` : `VOLUME: NOT YET PUBLISHED`,
    `LIQUIDITY: ${ld >= 0 ? 'UP' : 'DOWN'} ${fmtPct(ld)}`,
    volumeAvailable ? `VOLUME: ${fmtUsd(previous.volume)} → ${fmtUsd(completed.volume)}` : `VOLUME: ${previous.volume == null ? 'N/A' : fmtUsd(previous.volume)} → N/A`,
    `LIQUIDITY: ${fmtUsd(previous.liquidity)} → ${fmtUsd(completed.liquidity)}`,
    `COMBINATION: ${combination}`,
    `WINNER: ${winner}`,
    `COMPLETED: ${new Date(completedEndMs - 300000).toISOString()} → ${new Date(completedEndMs).toISOString()}`,
    '',
    '➡️ NEXT · POLYMARKET 5M', `https://polymarket.com/event/${nextMarket.slug}`,
  ].join('\n');
}

async function main() {
  console.log('[polybacktest] boundary BTC 5m watcher (completed-period metrics)');

  const boundary = nextBoundary();
  const wait = Math.max(0, boundary - Date.now());
  console.log(`[polybacktest] boundary=${new Date(boundary).toISOString()} wait=${Math.ceil(wait / 1000)}s`);
  if (wait) await sleep(wait);

  // At the boundary, the market ending now is the completed period.
  // Compare it with the immediately preceding completed period.
  const completedStart = boundary - 300000;
  const previousStart = boundary - 600000;
  const completedSlug = marketSlug(completedStart);
  const previousSlug = marketSlug(previousStart);
  const nextSlug = marketSlug(boundary);
  console.log(`[polybacktest] completed=${completedSlug} previous=${previousSlug} next=${nextSlug}`);

  const completed = await getMarketBySlug(completedSlug);
  const previous = await getMarketBySlug(previousSlug);
  const nextMarket = await getMarketBySlug(nextSlug);

  completed.boundary = await getEndLiquidity(completed, boundary);
  previous.boundary = await getEndLiquidity(previous, completedStart);
  completed.liquidity = completed.boundary.liquidity;
  previous.liquidity = previous.boundary.liquidity;

  console.log(`[polybacktest] values volume=${previous.volume ?? 'N/A'}->${completed.volume ?? 'N/A'} liquidity=${previous.liquidity}->${completed.liquidity}`);
  await sendTelegram(alertText(previous, completed, nextMarket, boundary));
  console.log(`[polybacktest] TELEGRAM SENT next=${nextMarket.id}`);
}

main().catch(err => {
  console.error(`[polybacktest] FAILED ${err.stack || err.message}`);
  require('node:process').exitCode = 1;
});
