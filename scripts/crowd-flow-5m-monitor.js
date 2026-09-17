const { bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const PERIOD = 300000;
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'DOGE', 'BNB'];
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
  const text = await response.text();
  if (!response.ok) throw new Error(`Convex ${response.status}: ${text}`);
}

async function claimCrowdFlowAlert(periodStart, symbol) {
  const base = process.env.CONVEX_URL;
  const token = process.env.CONVEX_INGEST_TOKEN;
  if (!base || !token) throw new Error('Convex environment variables missing');
  const response = await fetch(`${base.replace(/\/$/, '')}/claim-crowd-flow-alert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ symbol, periodStart, alertType: 'MAX_IMBALANCE', sentAt: Date.now() })
  });
  if (!response.ok) throw new Error(`Convex Crowd Flow claim ${response.status}`);
  const result = await response.json();
  return result?.claimed === true;
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
      const id = `${trade.transactionHash || ''}:${trade.asset || ''}:${trade.timestamp}:${trade.price}:${trade.size}:${trade.side || ''}`;
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

async function loadPeriod(symbol, periodStart) {
  const market = await findMarketByEpoch(symbol, periodStart, '5m');
  if (!market?.tokenIds?.UP || !market?.tokenIds?.DOWN) return null;
  const trades = await fetchFullPeriodTrades(market, periodStart);
  if (trades === null) return null;

  let buyUsd = 0;
  let sellUsd = 0;
  let buyEvents = 0;
  let sellEvents = 0;
  let closeUp = null;
  let closeDown = null;
  let closeUpTs = -Infinity;
  let closeDownTs = -Infinity;
  const upToken = String(market.tokenIds.UP);
  const downToken = String(market.tokenIds.DOWN);

  for (const trade of trades) {
    const asset = String(trade.asset || '');
    const price = Number(trade.price);
    const size = Number(trade.size);
    const ts = Number(trade.timestamp);
    if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0 || !Number.isFinite(ts)) continue;

    const usd = price * size;
    const side = String(trade.side || '').toUpperCase();
    if (side === 'BUY') { buyUsd += usd; buyEvents += 1; }
    else if (side === 'SELL') { sellUsd += usd; sellEvents += 1; }

    if (asset === upToken && ts >= closeUpTs) { closeUp = price; closeUpTs = ts; }
    if (asset === downToken && ts >= closeDownTs) { closeDown = price; closeDownTs = ts; }
  }

  const total = buyUsd + sellUsd;
  const cvdUsd = buyUsd - sellUsd;
  const imbalancePct = total > 0 ? Math.abs(cvdUsd) / total * 100 : 0;
  const direction = cvdUsd > 0 ? 'BUY' : cvdUsd < 0 ? 'SELL' : 'NEUTRAL';

  return {
    symbol,
    market,
    trades: trades.length,
    buyUsd,
    sellUsd,
    cvdUsd,
    imbalancePct,
    buyEvents,
    sellEvents,
    direction,
    closeUp,
    closeDown
  };
}

async function saveCompletedPeriod(periodStart, data) {
  const key = `${data.symbol}:${periodStart}`;
  if (saved.has(key)) return;
  await convexPost({
    symbol: data.symbol,
    periodStart,
    periodEnd: periodStart + PERIOD,
    trades: data.trades,
    buyUsd: Number(data.buyUsd.toFixed(2)),
    sellUsd: Number(data.sellUsd.toFixed(2)),
    cvdUsd: Number(data.cvdUsd.toFixed(2)),
    imbalancePct: Number(data.imbalancePct.toFixed(4)),
    buyEvents: data.buyEvents,
    sellEvents: data.sellEvents,
    direction: data.direction,
    closeUp: data.closeUp ?? undefined,
    closeDown: data.closeDown ?? undefined,
    recordedAt: Date.now()
  });
  saved.add(key);
  console.log(`[crowd-flow] SAVED ${data.symbol} period=${periodStart} direction=${data.direction} imbalance=${data.imbalancePct.toFixed(1)}% buy=$${data.buyUsd.toFixed(2)} sell=$${data.sellUsd.toFixed(2)}`);
}

async function alertMaxImbalance(periodStart, results) {
  const candidates = results.filter(x => x && x.direction !== 'NEUTRAL' && x.imbalancePct > 0);
  if (!candidates.length || alertedPeriods.has(String(periodStart))) return;

  candidates.sort((a, b) => b.imbalancePct - a.imbalancePct);
  const winner = candidates[0];
  const claimed = await claimCrowdFlowAlert(periodStart, winner.symbol);
  if (!claimed) {
    alertedPeriods.add(String(periodStart));
    console.log(`[crowd-flow] DUPLICATE SUPPRESSED period=${periodStart}`);
    return;
  }

  const currentStart = periodStart + PERIOD;
  const currentMarket = await findMarketByEpoch(winner.symbol, currentStart, '5m');
  const currentUrl = currentMarket?.url || `https://polymarket.com/event/${winner.symbol.toLowerCase()}-updown-5m-${Math.floor(currentStart / 1000)}`;
  const title = winner.direction === 'BUY' ? '⬆️ BUY UP' : '⬇️ BUY DOWN';
  const message = [
    `🔥 ${winner.symbol} · 5M · ${title}`,
    `CVD: ${winner.cvdUsd >= 0 ? '+' : ''}$${winner.cvdUsd.toFixed(2)}`,
    `BUY: $${winner.buyUsd.toFixed(2)}`,
    `SELL: $${winner.sellUsd.toFixed(2)}`,
    `IMBALANCE: ${winner.imbalancePct.toFixed(1)}%`,
    `TRADES: ${winner.trades}`,
    '',
    '➡️ Polymarket 5M',
    currentUrl
  ];

  await sendTelegramMessage(message.join('\n'));
  alertedPeriods.add(String(periodStart));
  console.log(`[crowd-flow] ALERT SENT period=${periodStart} winner=${winner.symbol} imbalance=${winner.imbalancePct.toFixed(1)}%`);
}

async function tick() {
  const completedStart = start() - PERIOD;
  try {
    const results = await Promise.all(SYMBOLS.map(symbol => loadPeriod(symbol, completedStart).catch(e => {
      console.error(`[crowd-flow] ${symbol} PERIOD LOAD FAILED period=${completedStart}: ${e.message}`);
      return null;
    })));

    for (const result of results) {
      if (!result) continue;
      try { await saveCompletedPeriod(completedStart, result); }
      catch (e) { console.error(`[crowd-flow] ${result.symbol} STATS SAVE FAILED: ${e.message}`); }
    }

    await alertMaxImbalance(completedStart, results);
  } catch (e) {
    console.error(`[crowd-flow] TICK FAILED period=${completedStart}: ${e.message}`);
  }
}

(async () => {
  console.log(`[crowd-flow] start 5m imbalance monitor: ${SYMBOLS.join(', ')}; signal=MAX ABS(CVD)/(BUY+SELL); one alert per 5m period`);
  await tick();
  setInterval(tick, 30000);
})();
