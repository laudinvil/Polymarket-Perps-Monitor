const API = 'https://api.polybacktest.com/v4';
const COIN = 'BTC';
const TYPE = '5m';
const POLL_MS = 60_000;

const apiKey = process.env.POLYBACKTEST_API_KEY;
const tgToken = process.env.TELEGRAM_BOT_TOKEN;
const tgChatId = process.env.TELEGRAM_CHAT_ID;

if (!apiKey) throw new Error('POLYBACKTEST_API_KEY is required');
if (!tgToken || !tgChatId) throw new Error('TELEGRAM secrets are required');

let previous = null;
let lastAlertId = null;

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

async function process() {
  const markets = await getMarkets();
  if (!markets.length) return;
  const market = markets[markets.length - 1];
  const current = await getDetails(market);
  console.log(`[polybacktest] latest id=${current.id} volume=${current.volume} liquidity=${current.liquidity}`);

  if (!previous) {
    previous = current;
    console.log('[polybacktest] baseline established');
    return;
  }
  if (current.id === previous.id || current.id === lastAlertId) return;

  const alert = formatAlert(previous, current);
  try {
    await sendTelegram(alert);
    lastAlertId = current.id;
    console.log(`[polybacktest] TELEGRAM SENT ${current.id}`);
    previous = current;
  } catch (err) {
    console.error(`[polybacktest] TELEGRAM FAILED ${err.message}`);
  }
}

console.log('[polybacktest] start BTC 5m');

async function loop() {
  try { await process(); }
  catch (err) { console.error(`[polybacktest] LOOP FAILED ${err.stack || err.message}`); }
  setTimeout(loop, POLL_MS);
}
loop();
