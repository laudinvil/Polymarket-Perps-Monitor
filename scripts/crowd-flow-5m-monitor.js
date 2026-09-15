const { bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const PERIOD = 300000;
const ALERT_THRESHOLD = 2400;
const DATA_API = 'https://data-api.polymarket.com/trades';
const saved = new Set();
const alertedPeriods = new Set();
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

async function loadPeriod(periodStart) {
  const market = await findMarketByEpoch('BTC', periodStart, '5m');
  if (!market?.tokenIds?.UP || !market?.tokenIds?.DOWN) return null;
  const trades = await fetchFullPeriodTrades(market, periodStart);
  if (trades === null) return null;
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
  return { market, trades: trades.length, closeUp, closeDown };
}

async function saveCompletedPeriod(periodStart, data) {
  const key = String(periodStart);
  if (saved.has(key)) return;
  await convexPost({
    symbol: 'BTC',
    periodStart,
    periodEnd: periodStart + PERIOD,
    trades: data.trades,
    closeUp: data.closeUp ?? undefined,
    closeDown: data.closeDown ?? undefined,
    recordedAt: Date.now()
  });
  saved.add(key);
  console.log(`[crowd-flow] SAVED BTC period=${periodStart} trades=${data.trades}`);
}

async function alertIfNeeded(periodStart, current) {
  if (current.trades < ALERT_THRESHOLD || alertedPeriods.has(String(periodStart))) return;

  const currentStart = periodStart + PERIOD;
  const currentMarket = await findMarketByEpoch('BTC', currentStart, '5m');
  const currentUrl = currentMarket?.url || `https://polymarket.com/event/btc-updown-5m-${Math.floor(currentStart / 1000)}`;

  await sendTelegramMessage([
    '🔥 BTC · 5M',
    `TRADES: ${current.trades}`,
    `THRESHOLD: ${ALERT_THRESHOLD}+`,
    `CLOSE UP: ${current.closeUp ?? 'N/A'}`,
    `CLOSE DOWN: ${current.closeDown ?? 'N/A'}`,
    '',
    '➡️ CURRENT · Polymarket 5M',
    currentUrl
  ].join('\n'));
  alertedPeriods.add(String(periodStart));
  console.log(`[crowd-flow] ALERT BTC period=${periodStart} trades=${current.trades} threshold=${ALERT_THRESHOLD}`);
}

async function tick() {
  const completedStart = start() - PERIOD;
  try {
    const current = await loadPeriod(completedStart);
    if (!current) return;

    try {
      await saveCompletedPeriod(completedStart, current);
    } catch (e) {
      console.error(`[crowd-flow] STATS SAVE FAILED period=${completedStart}: ${e.message}`);
    }

    try {
      await alertIfNeeded(completedStart, current);
    } catch (e) {
      console.error(`[crowd-flow] ALERT FAILED period=${completedStart}: ${e.message}`);
    }
  } catch (e) {
    console.error(`[crowd-flow] PERIOD LOAD FAILED period=${completedStart}: ${e.message}`);
  }
}

(async () => {
  console.log(`[crowd-flow] start BTC continuous trade stats + threshold alerts (${ALERT_THRESHOLD}+)`);
  await tick();
  setInterval(tick, 30000);
})();
