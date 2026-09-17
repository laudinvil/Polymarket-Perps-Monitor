const { env } = require('node:process');

const API = 'https://api.polybacktest.com/v4';
const COIN = 'BTC';
const TYPE = '5m';
const POLL_MS = 3000;
const WATCH_MS = 120000;
const DETAIL_RETRY_MS = 2500;

const apiKey = env.POLYBACKTEST_API_KEY;
const tgToken = env.TELEGRAM_BOT_TOKEN;
const tgChatId = env.TELEGRAM_CHAT_ID;

if (!apiKey) throw new Error('POLYBACKTEST_API_KEY is required');
if (!tgToken || !tgChatId) throw new Error('TELEGRAM secrets are required');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let lastPolyBackTestRequest = 0;

async function api(path) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = Math.max(0, 1600 - (Date.now() - lastPolyBackTestRequest));
    if (wait) await sleep(wait);
    lastPolyBackTestRequest = Date.now();

    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);

    if (res.status === 429 && attempt < 4) {
      let retryMs = 1600;
      try {
        const body = JSON.parse(text);
        retryMs = Math.max(1600, Number(body?.details?.retry_after || 1) * 1000 + 300);
      } catch {}
      console.log(`[polybacktest] rate limited, retry ${attempt + 1}/4 after ${retryMs}ms`);
      await sleep(retryMs);
      continue;
    }
    throw new Error(`PolyBackTest ${res.status}: ${text.slice(0, 500)}`);
  }
  throw new Error('PolyBackTest request failed after retries');
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: tgChatId, text, disable_web_page_preview: false }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 500)}`);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function marketEndMs(market) {
  const raw = market?.end;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const parsed = Date.parse(String(raw || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function pct(prev, curr) { return prev ? ((curr - prev) / prev) * 100 : 0; }
function polymarketUrl(slug) { return slug ? `https://polymarket.com/event/${slug}` : null; }
function formatPct(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`; }
function formatUsd(v) { return `$${Math.round(v).toLocaleString('en-US')}`; }

function formatAlert(prev, curr) {
  const volumeDelta = pct(prev.volume, curr.volume);
  const liquidityDelta = pct(prev.liquidity, curr.liquidity);
  const combination = volumeDelta >= 0 && liquidityDelta >= 0 ? 'VOLUME ↑ + LIQUIDITY ↑'
    : volumeDelta < 0 && liquidityDelta < 0 ? 'VOLUME ↓ + LIQUIDITY ↓' : 'MIXED';
  const winner = volumeDelta > liquidityDelta ? 'VOLUME' : liquidityDelta > volumeDelta ? 'LIQUIDITY' : 'TIE';
  const url = polymarketUrl(curr.slug);
  return [
    `🔥 ${COIN} · POLYBACKTEST 5M`,
    `VOLUME: ${volumeDelta >= 0 ? 'UP' : 'DOWN'} ${formatPct(volumeDelta)}`,
    `LIQUIDITY: ${liquidityDelta >= 0 ? 'UP' : 'DOWN'} ${formatPct(liquidityDelta)}`,
    `VOLUME: ${formatUsd(prev.volume)} → ${formatUsd(curr.volume)}`,
    `LIQUIDITY: ${formatUsd(prev.liquidity)} → ${formatUsd(curr.liquidity)}`,
    `COMBINATION: ${combination}`,
    `WINNER: ${winner}`,
    `PERIOD: ${curr.period ?? curr.end ?? 'unknown'}`,
    '', ...(url ? ['➡️ POLYMARKET 5M', url] : []),
  ].join('\n');
}

async function getMarkets(resolved) {
  const suffix = resolved === true ? '&resolved=true' : '';
  const path = `/markets?coin=${encodeURIComponent(COIN.toLowerCase())}&market_type=${encodeURIComponent(TYPE)}${suffix}`;
  console.log(`[polybacktest] GET ${path}`);
  const data = await api(path);
  const markets = Array.isArray(data) ? data : data.markets || data.data?.markets || data.data || data.results || [];
  console.log(`[polybacktest] API markets=${markets.length} resolved=${resolved === true}`);
  return markets.map(m => ({
    id: m.id ?? m.market_id ?? m.slug,
    slug: m.slug ?? m.event_slug ?? m.polymarket_slug,
    start: m.start_time ?? m.startTime ?? m.start ?? 0,
    end: m.end_time ?? m.endTime ?? m.end ?? m.resolved_at ?? 0,
    raw: m,
  })).filter(m => m.id != null).sort((a, b) => marketEndMs(a) - marketEndMs(b));
}

async function getDetails(market, allowMissing = false) {
  const coin = String(COIN).toLowerCase();
  const d = await api(`/markets/${encodeURIComponent(market.id)}?coin=${encodeURIComponent(coin)}`);
  const x = d.market || d.data?.market || d.data || d;
  const finalVolume = x.final_volume;
  console.log(`[polybacktest] detail ${market.id} volume=${finalVolume ?? 'missing'} liquidity=${x.final_liquidity ?? 'missing'}`);
  if (finalVolume == null && !allowMissing) return null;
  return {
    ...market,
    slug: x.slug ?? x.event_slug ?? x.polymarket_slug ?? market.slug,
    volume: num(finalVolume),
    liquidity: num(x.final_liquidity),
    period: x.period ?? x.end_time ?? x.endTime ?? x.end ?? market.end,
  };
}

function sumBook(book) {
  if (!book || typeof book !== 'object') return 0;
  const levels = [...(Array.isArray(book.bids) ? book.bids : []), ...(Array.isArray(book.asks) ? book.asks : [])];
  return levels.reduce((sum, level) => sum + num(level.price) * num(level.size), 0);
}

async function getOrderbookLiquidity(market) {
  const coin = String(COIN).toLowerCase();
  const data = await api(`/markets/${encodeURIComponent(market.id)}/snapshots?coin=${encodeURIComponent(coin)}&limit=1&include_orderbook=true`);
  const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
  if (!snapshots.length) throw new Error(`PolyBackTest market ${market.id} has no snapshots`);
  const liquidity = sumBook(snapshots[0].orderbook_up) + sumBook(snapshots[0].orderbook_down);
  console.log(`[polybacktest] orderbook ${market.id} liquidity=${liquidity.toFixed(2)}`);
  if (!liquidity) throw new Error(`PolyBackTest market ${market.id} orderbook liquidity is zero`);
  return liquidity;
}

async function processTarget(markets, targetIndex) {
  if (targetIndex < 1) throw new Error(`No previous 5m market for target ${markets[targetIndex]?.id}`);
  const prevMarket = markets[targetIndex - 1];
  const currMarket = markets[targetIndex];
  console.log(`[polybacktest] boundary target ${currMarket.id}; comparing ${prevMarket.id} -> ${currMarket.id}`);

  let curr = null;
  const detailDeadline = Date.now() + 45000;
  while (Date.now() < detailDeadline) {
    curr = await getDetails(currMarket);
    if (curr) break;
    console.log(`[polybacktest] target ${currMarket.id} not finalized yet; retrying`);
    await sleep(DETAIL_RETRY_MS);
  }
  if (!curr) throw new Error(`Target ${currMarket.id} did not expose final_volume within 45s`);

  const prev = await getDetails(prevMarket);
  if (!prev) throw new Error(`Previous market ${prevMarket.id} has no final_volume`);
  prev.liquidity = await getOrderbookLiquidity(prevMarket);
  curr.liquidity = await getOrderbookLiquidity(currMarket);
  console.log(`[polybacktest] values volume=${prev.volume}->${curr.volume} liquidity=${prev.liquidity}->${curr.liquidity}`);

  await sendTelegram(formatAlert(prev, curr));
  console.log(`[polybacktest] TELEGRAM SENT ${curr.id}`);
}

function nextFiveMinuteBoundaryMs(now = Date.now()) {
  const d = new Date(now); d.setSeconds(0, 0);
  const minute = d.getMinutes();
  const add = 5 - (minute % 5 || 5);
  d.setMinutes(minute + add);
  return d.getTime();
}

async function main() {
  console.log('[polybacktest] direct-boundary BTC 5m watcher');
  const boundary = nextFiveMinuteBoundaryMs();
  const waitMs = Math.max(0, boundary - Date.now());

  // Fetch all 5m markets, including unresolved, BEFORE the boundary.
  // The market ending at the boundary is the one we must report.
  let markets = await getMarkets(false);
  console.log(`[polybacktest] pre-boundary markets=${markets.length}`);
  console.log(`[polybacktest] waiting ${Math.ceil(waitMs / 1000)}s for boundary ${new Date(boundary).toISOString()}`);
  if (waitMs > 0) await sleep(waitMs);

  const deadline = Date.now() + WATCH_MS;
  while (Date.now() < deadline) {
    markets = await getMarkets(false);
    const ended = markets.filter(m => {
      const end = marketEndMs(m);
      return end > 0 && end <= Date.now() + 2000;
    });
    if (ended.length >= 2) {
      const targetIndex = markets.indexOf(ended[ended.length - 1]);
      console.log(`[polybacktest] ended markets=${ended.length}; target=${markets[targetIndex].id}`);
      try {
        await processTarget(markets, targetIndex);
        return;
      } catch (err) {
        console.log(`[polybacktest] target processing retry: ${err.message}`);
      }
    } else {
      console.log('[polybacktest] waiting for market list containing ended 5m period');
    }
    await sleep(POLL_MS);
  }
  throw new Error('No completed 5m target market became available during boundary watch');
}

main().catch(err => {
  console.error(`[polybacktest] FAILED ${err.stack || err.message}`);
  require('node:process').exitCode = 1;
});