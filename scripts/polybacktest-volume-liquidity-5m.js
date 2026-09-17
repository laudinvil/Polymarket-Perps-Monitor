const { env, exitCode } = require('node:process');
const nodeProcess = require('node:process');

const API = 'https://api.polybacktest.com/v4';
const COIN = 'BTC';
const TYPE = '5m';

const apiKey = env.POLYBACKTEST_API_KEY;
const tgToken = env.TELEGRAM_BOT_TOKEN;
const tgChatId = env.TELEGRAM_CHAT_ID;

if (!apiKey) throw new Error('POLYBACKTEST_API_KEY is required');
if (!tgToken || !tgChatId) throw new Error('TELEGRAM secrets are required');

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`PolyBackTest ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
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
  const path = `/markets?coin=${encodeURIComponent(COIN.toLowerCase())}&market_type=${encodeURIComponent(TYPE)}&status=resolved`;
  console.log(`[polybacktest] GET ${path}`);
  const data = await api(path);
  const markets = Array.isArray(data) ? data : data.markets || data.data || data.results || [];
  console.log(`[polybacktest] API markets=${markets.length}`);
  return markets.map(m => ({
    id: m.id ?? m.market_id ?? m.slug,
    slug: m.slug ?? m.event_slug ?? m.polymarket_slug,
    end: m.end_time ?? m.endTime ?? m.end ?? m.resolved_at ?? 0,
    raw: m,
  })).filter(m => m.id != null)
    .sort((a, b) => new Date(a.end).getTime() - new Date(b.end).getTime());
}

async function getDetails(market) {
  const d = await api(`/markets/${encodeURIComponent(market.id)}`);
  const x = d.market || d.data || d;
  return {
    ...market,
    volume: num(x.final_volume ?? x.volume ?? x.total_volume),
    liquidity: num(x.final_liquidity ?? x.liquidity),
    period: x.period ?? x.end_time ?? x.endTime ?? market.end,
  };
}

async function main() {
  console.log('[polybacktest] single-shot BTC 5m');
  const markets = await getMarkets();
  if (markets.length < 2) throw new Error(`Need 2 resolved markets, got ${markets.length}`);

  const prevMarket = markets[markets.length - 2];
  const currMarket = markets[markets.length - 1];
  console.log(`[polybacktest] comparing ${prevMarket.id} -> ${currMarket.id}`);

  const [prev, curr] = await Promise.all([getDetails(prevMarket), getDetails(currMarket)]);
  console.log(`[polybacktest] values volume=${prev.volume}->${curr.volume} liquidity=${prev.liquidity}->${curr.liquidity}`);

  await sendTelegram(formatAlert(prev, curr));
  console.log(`[polybacktest] TELEGRAM SENT ${curr.id}`);
}

main().catch(err => {
  console.error(`[polybacktest] FAILED ${err.stack || err.message}`);
  nodeProcess.exitCode = 1;
});
