const API_KEY = String(process.env.POLYBACKTEST_API_KEY || '').trim();
const BASE = 'https://api.polybacktest.com/v4';
const COIN = 'btc';
const TYPE = '5m';
const POLL_MS = 60_000;

if (!API_KEY) throw new Error('POLYBACKTEST_API_KEY is required');

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
