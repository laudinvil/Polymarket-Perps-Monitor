const API_KEY = String(process.env.POLYBACKTEST_API_KEY || '').trim();
const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '').trim();
const BASE = 'https://api.polybacktest.com/v4';
const COIN = 'btc';
const TYPE = '5m';
const POLL_MS = 60_000;

if (!API_KEY) throw new Error('POLYBACKTEST_API_KEY is required');
if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Telegram secrets are required');

const headers = { 'X-API-Key': API_KEY };
const seen = new Set();
let previous = null;

async function getMarkets() {
  const u = new URL(`${BASE}/markets`);
  u.searchParams.set('coin', COIN);
  u.searchParams.set('market_type', TYPE);
  u.searchParams.set('resolved', 'true');
  u.searchParams.set('limit', '100');
  u.searchParams.set('offset', '0');
  const r = await fetch(u, { headers });
  if (!r.ok) throw new Error(`PolyBackTest ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return Array.isArray(j.markets) ? j.markets : [];
}

async function getMarket(id) {
  const u = new URL(`${BASE}/markets/${id}`);
  u.searchParams.set('coin', COIN);
  const r = await fetch(u, { headers });
  if (!r.ok) throw new Error(`PolyBackTest market ${r.status}: ${await r.text()}`);
  return r.json();
}

function direction(a, b) {
  if (b > a) return 'UP';
  if (b < a) return 'DOWN';
  return 'FLAT';
}

function pct(a, b) {
  if (!Number.isFinite(a) || a === 0 || !Number.isFinite(b)) return null;
  return ((b / a) - 1) * 100;
}

function money(v) {
  return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function polymarketUrl(slug) {
  return slug ? `https://polymarket.com/event/${slug}` : null;
}

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
  });
  if (!r.ok) throw new Error(`Telegram ${r.status}: ${await r.text()}`);
}

function record(m, prev) {
  const volume = Number(m.final_volume);
  const liquidity = Number(m.final_liquidity);
  if (!Number.isFinite(volume) || !Number.isFinite(liquidity) || !prev) return null;
  const volumeChange = pct(prev.volume, volume);
  const liquidityChange = pct(prev.liquidity, liquidity);
  return {
    type: 'volume_liquidity_5m',
    period: Number(m.start_time),
    periodEnd: Number(m.end_time),
    slug: m.slug,
    symbol: 'BTC',
    volume,
    liquidity,
    previousVolume: prev.volume,
    previousLiquidity: prev.liquidity,
    volumeDirection: direction(prev.volume, volume),
    liquidityDirection: direction(prev.liquidity, liquidity),
    volumeChangePct: volumeChange,
    liquidityChangePct: liquidityChange,
    combination: `${direction(prev.volume, volume)}_${direction(prev.liquidity, liquidity)}`,
    winner: String(m.winner || '').toUpperCase(),
    collectedAt: Date.now()
  };
}

async function process() {
  const markets = (await getMarkets())
    .filter(m => Number.isFinite(Number(m.end_time)))
    .sort((a, b) => Number(a.end_time) - Number(b.end_time));

  for (const raw of markets) {
    const id = raw.market_id;
    if (seen.has(String(id))) continue;
    const m = await getMarket(id);
    const row = record(m, previous);
    const current = {
      period: Number(m.start_time),
      volume: Number(m.final_volume),
      liquidity: Number(m.final_liquidity)
    };

    if (row) {
      console.log(JSON.stringify(row));
      process.stdout.write(`STRATEGY ${row.slug} ${row.combination} V=${row.volumeChangePct.toFixed(2)}% L=${row.liquidityChangePct.toFixed(2)}% WINNER=${row.winner}\n`);

      const lines = [
        `🔥 BTC · POLYBACKTEST 5M`,
        `VOLUME: ${row.volumeDirection} ${row.volumeChangePct >= 0 ? '+' : ''}${row.volumeChangePct.toFixed(2)}%`,
        `LIQUIDITY: ${row.liquidityDirection} ${row.liquidityChangePct >= 0 ? '+' : ''}${row.liquidityChangePct.toFixed(2)}%`,
        `VOLUME: $${money(row.previousVolume)} → $${money(row.volume)}`,
        `LIQUIDITY: $${money(row.previousLiquidity)} → $${money(row.liquidity)}`,
        `COMBINATION: ${row.combination}`,
        `WINNER: ${row.winner || 'N/A'}`,
        `PERIOD: ${new Date(row.period).toISOString()} → ${new Date(row.periodEnd).toISOString()}`
      ];
      const url = polymarketUrl(row.slug);
      if (url) lines.push(`\n➡️ POLYMARKET 5M\n${url}`);
      const text = lines.join('\n');

      try {
        await sendTelegram(text);
        console.log(`TELEGRAM SENT ${row.slug}`);
      } catch (e) {
        console.error(`TELEGRAM FAILED ${row.slug}: ${e.stack || e.message}`);
      }
    }

    previous = current;
    seen.add(String(id));
  }
}

console.log('POLYBACKTEST BTC 5M VOLUME/LIQUIDITY STRATEGY STARTED');
(async () => {
  while (true) {
    try { await process(); }
    catch (e) { console.error(`LOOP FAILED: ${e.stack || e.message}`); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
