const { bucketStart, findMarketByEpoch } = require('../src/polymarket');

const PERIOD = 300000;
const DATA_API = 'https://data-api.polymarket.com/trades';
const saved = new Set();
const start = () => bucketStart(Date.now(), '5m');

async function convexPost(data) {
  const base = process.env.CONVEX_URL;
  const token = process.env.CONVEX_INGEST_TOKEN;
  if (!base || !token) throw new Error('Convex environment variables missing');
  const response = await fetch(`${base.replace(/\/$/, '')}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'crowdFlow.period', data })
  });
  if (!response.ok) throw new Error(`Convex ${response.status}`);
}

async function fetchFullPeriodTrades(market, periodStart) {
  if (!market?.conditionId) return null;
  const startSec = Math.floor(periodStart / 1000);
  const endSec = startSec + 300;
  const rows = [], seenRows = new Set();
  let offset = 0;
  const limit = 10000;
  while (true) {
    const url = new URL(DATA_API);
    url.searchParams.set('market', market.conditionId);
    url.searchParams.set('start', String(startSec));
    url.searchParams.set('end', String(endSec));
    url.searchParams.set('takerOnly', 'true');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('offset', String(offset));
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Data API ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Data API invalid response');
    for (const trade of page) {
      const ts = Number(trade.timestamp);
      if (!Number.isFinite(ts) || ts < startSec || ts >= endSec) continue;
      const id = `${trade.transactionHash || ''}:${trade.asset || ''}:${trade.timestamp}:${trade.price}:${trade.size}`;
      if (seenRows.has(id)) continue;
      seenRows.add(id);
      rows.push(trade);
    }
    if (page.length < limit) break;
    offset += limit;
    if (offset > 10000) throw new Error('Data API pagination cap reached inside 5m period');
  }
  return rows;
}

async function saveCompletedPeriod(periodStart) {
  const key = String(periodStart);
  if (saved.has(key)) return;
  const market = await findMarketByEpoch('BTC', periodStart, '5m');
  if (!market?.tokenIds?.UP || !market?.tokenIds?.DOWN) return;
  const trades = await fetchFullPeriodTrades(market, periodStart);
  if (trades === null) return;
  let closeUp = null, closeDown = null;
  let closeUpTs = -Infinity, closeDownTs = -Infinity;
  const upToken = String(market.tokenIds.UP);
  const downToken = String(market.tokenIds.DOWN);
  for (const trade of trades) {
    const asset = String(trade.asset || '');
    const price = Number(trade.price);
    const ts = Number(trade.timestamp);
    if (!Number.isFinite(price) || !Number.isFinite(ts)) continue;
    if (asset === upToken && ts >= closeUpTs) { closeUp = price; closeUpTs = ts; }
    if (asset === downToken && ts >= closeDownTs) { closeDown = price; closeDownTs = ts; }
  }
  await convexPost({
    symbol: 'BTC',
    periodStart,
    periodEnd: periodStart + PERIOD,
    trades: trades.length,
    closeUp: closeUp ?? undefined,
    closeDown: closeDown ?? undefined,
    recordedAt: Date.now()
  });
  saved.add(key);
  console.log(`[crowd-flow] SAVED BTC period=${periodStart} trades=${trades.length}`);
}

async function tick() {
  const completedStart = start() - PERIOD;
  try { await saveCompletedPeriod(completedStart); }
  catch (e) { console.error(`[crowd-flow] SAVE FAILED period=${completedStart}: ${e.message}`); }
}

(async () => {
  console.log('[crowd-flow] start BTC continuous trade stats');
  await tick();
  setInterval(tick, 30000);
})();
