const { bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const PERIOD = 300000;
const ALERT_THRESHOLD = 2800;
const LOW_TRADE_THRESHOLD = 850;
const DATA_API = 'https://data-api.polymarket.com/trades';
const saved = new Set();
const alertedPeriods = new Set();
let previousTrades = null;
let previousPeriodStart = null;
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

async function saveCompletedPeriod(periodStart, data, previous) {
  const key = String(periodStart);
  if (saved.has(key)) return;
  await convexPost({
    symbol: 'BTC',
    periodStart,
    periodEnd: periodStart + PERIOD,
    trades: data.trades,
    previousTrades: previous ?? undefined,
    change: previous == null ? undefined : data.trades - previous,
    closeUp: data.closeUp ?? undefined,
    closeDown: data.closeDown ?? undefined,
    recordedAt: Date.now()
  });
  saved.add(key);
  console.log(`[crowd-flow] SAVED BTC period=${periodStart} trades=${data.trades} previous=${previous ?? 'N/A'}`);
}

async function alertIfNeeded(periodStart, current, previous) {
  const thresholdHit = current.trades >= ALERT_THRESHOLD;
  const lowTradeHit = current.trades <= LOW_TRADE_THRESHOLD;
  if ((!thresholdHit && !lowTradeHit) || alertedPeriods.has(String(periodStart))) return;

  const currentStart = periodStart + PERIOD;
  const currentMarket = await findMarketByEpoch('BTC', currentStart, '5m');
  const currentUrl = currentMarket?.url || `https://polymarket.com/event/btc-updown-5m-${Math.floor(currentStart / 1000)}`;
  const action = thresholdHit ? 'BUY ⬇️' : 'BUY ⬆️';
  const lines = [
    `🔥 BTC · 5M · ${action}`,
    `TRADES: ${current.trades}`,
    `THRESHOLD: ${thresholdHit ? `${ALERT_THRESHOLD}+` : `${LOW_TRADE_THRESHOLD}-`}`,
    `CLOSE UP: ${current.closeUp ?? 'N/A'}`,
    `CLOSE DOWN: ${current.closeDown ?? 'N/A'}`,
    '',
    '➡️ Polymarket 5M',
    currentUrl
  ];

  await sendTelegramMessage(lines.join('\n'));
  alertedPeriods.add(String(periodStart));
  console.log(`[crowd-flow] ALERT BTC period=${periodStart} trades=${current.trades} thresholdHit=${thresholdHit} lowTradeHit=${lowTradeHit}`);
}

async function tick() {
  const completedStart = start() - PERIOD;
  try {
    const current = await loadPeriod(completedStart);
    if (!current || previousPeriodStart === completedStart) return;

    const priorTrades = previousTrades;

    try {
      await saveCompletedPeriod(completedStart, current, priorTrades);
    } catch (e) {
      console.error(`[crowd-flow] STATS SAVE FAILED period=${completedStart}: ${e.message}`);
    }

    try {
      await alertIfNeeded(completedStart, current, priorTrades);
    } catch (e) {
      console.error(`[crowd-flow] ALERT FAILED period=${completedStart}: ${e.message}`);
    }

    previousTrades = current.trades;
    previousPeriodStart = completedStart;
  } catch (e) {
    console.error(`[crowd-flow] PERIOD LOAD FAILED period=${completedStart}: ${e.message}`);
  }
}

(async () => {
  console.log(`[crowd-flow] start BTC 5m monitor (threshold ${ALERT_THRESHOLD}+ OR ${LOW_TRADE_THRESHOLD}- trades)`);
  await tick();
  setInterval(tick, 30000);
})();
