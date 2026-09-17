const { env } = require('node:process');

const API = 'https://api.polybacktest.com/v4';
const COIN = 'BTC';
const TYPE = '5m';
const POLL_MS = 10000;
const WATCH_MS = 290000;
const RECENT_MS = 270000;

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
    method: 'POST',
    headers: { 'content-type': 'application/json' },
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

function pct(prev, curr) {
  if (!prev) return 0;
  return ((curr - prev) / prev) * 100;
}

function polymarketUrl(slug) {
  return slug ? `https://polymarket.com/event/${slug}` : null;
}

function formatPct(v) {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}

function formatUsd(v) {
  return `$${Math.round(v).toLocaleString('en-US')}`;
}

function formatAlert(prev, curr) {
  const volumeDelta = pct(prev.volume, curr.volume);
  const liquidityDelta = pct(prev.liquidity, curr.liquidity);
  const combination = volumeDelta >= 0 && liquidityDelta >= 0 ? 'VOLUME ↑ + LIQUIDITY ↑'
    : volumeDelta < 0 && liquidityDelta < 0 ? 'VOLUME ↓ + LIQUIDITY ↓'
    : 'MIXED';
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
    '',
    ...(url ? ['➡️ POLYMARKET 5M', url] : []),
  ].join('\n');
}

async function getMarkets() {
  const path = `/markets?coin=${encodeURIComponent(COIN.toLowerCase())}&market_type=${encodeURIComponent(TYPE)}&resolved=true`;
  console.log(`[polybacktest] GET ${path}`);
  const data = await api(path);
  const markets = Array.isArray(data) ? data : data.markets || data.data?.markets || data.data || data.results || [];
  console.log(`[polybacktest] API markets=${markets.length}`);
  return markets.map(m => ({
    id: m.id ?? m.market_id ?? m.slug,
    slug: m.slug ?? m.event_slug ?? m.polymarket_slug,
    end: m.end_time ?? m.endTime ?? m.end ?? m.resolved_at ?? 0,
    raw: m,
  })).filter(m => m.id != null)
    .sort((a, b) => marketEndMs(a) - marketEndMs(b));
}

async function getDetails(market) {
  const coin = String(COIN).toLowerCase();
  const d = await api(`/markets/${encodeURIComponent(market.id)}?coin=${encodeURIComponent(coin)}`);
  const x = d.market || d.data?.market || d.data || d;
  console.log(`[polybacktest] detail ${market.id} volume=${x.final_volume ?? 'missing'} liquidity=${x.final_liquidity ?? 'missing'} keys=${Object.keys(x).slice(0, 20).join(',')}`);
  if (x.final_volume == null) {
    throw new Error(`PolyBackTest market ${market.id} has no final_volume`);
  }
  return {
    ...market,
    slug: x.slug ?? x.event_slug ?? x.polymarket_slug ?? market.slug,
    volume: num(x.final_volume),
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
  const path = `/markets/${encodeURIComponent(market.id)}/snapshots?coin=${encodeURIComponent(coin)}&limit=1&include_orderbook=true`;
  const data = await api(path);
  const snapshots = Array.isArray(data?.snapshots) ? data.snapshots : [];
  if (!snapshots.length) throw new Error(`PolyBackTest market ${market.id} has no snapshots`);
  const s = snapshots[0];
  const liquidity = sumBook(s.orderbook_up) + sumBook(s.orderbook_down);
  console.log(`[polybacktest] orderbook ${market.id} snapshots=${snapshots.length} liquidity=${liquidity.toFixed(2)}`);
  if (!liquidity) throw new Error(`PolyBackTest market ${market.id} orderbook liquidity is zero`);
  return liquidity;
}

async function processLatest(markets) {
  if (markets.length < 2) throw new Error(`Need 2 resolved markets, got ${markets.length}`);
  const prevMarket = markets[markets.length - 2];
  const currMarket = markets[markets.length - 1];
  console.log(`[polybacktest] comparing ${prevMarket.id} -> ${currMarket.id}`);

  const prev = await getDetails(prevMarket);
  prev.liquidity = await getOrderbookLiquidity(prevMarket);
  const curr = await getDetails(currMarket);
  curr.liquidity = await getOrderbookLiquidity(currMarket);
  console.log(`[polybacktest] values volume=${prev.volume}->${curr.volume} liquidity=${prev.liquidity}->${curr.liquidity}`);

  await sendTelegram(formatAlert(prev, curr));
  console.log(`[polybacktest] TELEGRAM SENT ${curr.id}`);
  return curr.id;
}

async function main() {
  const startedAt = Date.now();
  const deadline = startedAt + WATCH_MS;
  console.log('[polybacktest] boundary-aware BTC 5m watcher');

  let markets = await getMarkets();
  if (markets.length < 2) throw new Error(`Need 2 resolved markets, got ${markets.length}`);

  let latestId = markets[markets.length - 1].id;
  const latestEnd = marketEndMs(markets[markets.length - 1]);
  const latestAge = Date.now() - latestEnd;

  // If GitHub starts shortly after a 5m boundary, the newest resolved market
  // is the period that just closed and must be alerted immediately.
  if (latestEnd > 0 && latestAge >= 0 && latestAge <= RECENT_MS) {
    console.log(`[polybacktest] recent resolved market ${latestId}, age=${Math.round(latestAge / 1000)}s`);
    await processLatest(markets);
    return;
  }

  console.log(`[polybacktest] waiting for next resolved market after ${latestId}`);
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    markets = await getMarkets();
    if (markets.length < 2) continue;

    const currentLatest = markets[markets.length - 1];
    if (currentLatest.id !== latestId) {
      console.log(`[polybacktest] NEW RESOLVED MARKET ${currentLatest.id}`);
      await processLatest(markets);
      return;
    }
  }

  console.log('[polybacktest] no new resolved market during watch window');
}

main().catch(err => {
  console.error(`[polybacktest] FAILED ${err.stack || err.message}`);
  require('node:process').exitCode = 1;
});
