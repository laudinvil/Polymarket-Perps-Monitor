const API = 'https://api.polybacktest.com/v4';
const COIN = 'BTC';
const TYPE = '5m';
const POLL_MS = 60_000;

const apiKey = process.env.POLYBACKTEST_API_KEY;
const tgToken = process.env.TELEGRAM_BOT_TOKEN;
const tgChatId = process.env.TELEGRAM_CHAT_ID;

if (!apiKey) throw new Error('POLYBACKTEST_API_KEY is required');
if (!tgToken || !tgChatId) throw new Error('TELEGRAM secrets are required');

const seen = new Set();
let previous = null;

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
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
    `PERIOD: ${curr.period ?? curr.end_time ?? curr.endTime ?? 'unknown'}`,
    '',
    ...(url ? [`➡️ POLYMARKET 5M`, url] : []),
  ].join('\n');
}

async function getMarkets() {
  const data = await api(`/markets?coin=${encodeURIComponent(COIN)}&type=${encodeURIComponent(TYPE)}&status=resolved`);
  const markets = Array.isArray(data) ? data : data.markets || data.data || [];
  return markets
    .map(m => ({
      id: m.id ?? m.market_id ?? m.slug,
      slug: m.slug ?? m.event_slug ?? m.polymarket_slug,
      end: m.end_time ?? m.endTime ?? m.end ?? m.resolved_at ?? 0,
      raw: m,
    }))
    .filter(m => m.id != null)
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
  console.log(`[polybacktest] resolved markets=${markets.length}`);
  if (!markets.length) return;

  for (const market of markets) {
    if (seen.has(market.id)) continue;
    const current = await getDetails(market);
    seen.add(market.id);

    if (!previous) {
      previous = current;
      continue;
    }

    console.log(`[polybacktest] ${current.id} volume=${current.volume} liquidity=${current.liquidity}`);
    const alert = formatAlert(previous, current);
    try {
      await sendTelegram(alert);
      console.log(`[polybacktest] TELEGRAM SENT ${current.id}`);
    } catch (err) {
      console.error(`[polybacktest] TELEGRAM FAILED ${err.message}`);
    }
    previous = current;
  }
}

console.log('[polybacktest] start BTC 5m');

async function loop() {
  try {
    await process();
  } catch (err) {
    console.error(`[polybacktest] LOOP FAILED ${err.stack || err.message}`);
  }
  setTimeout(loop, POLL_MS);
}

loop();
