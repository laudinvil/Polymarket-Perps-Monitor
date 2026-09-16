const { findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const PERIOD_MS = 5 * 60 * 1000;
const SYMBOL = 'BTCUSDT';
const BINANCE = 'https://fapi.binance.com/fapi/v1/aggTrades';
const POLL_MS = 30000;
const saved = new Set();

function periodStart(now) {
  return Math.floor(now / PERIOD_MS) * PERIOD_MS;
}

async function convexPost(data) {
  const base = process.env.CONVEX_URL;
  const token = process.env.CONVEX_INGEST_TOKEN;
  if (!base || !token) throw new Error('Convex environment variables missing');
  const response = await fetch(`${base.replace(/\/$/, '')}/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ type: 'cvd5m.period', data })
  });
  if (!response.ok) throw new Error(`Convex ${response.status}`);
}

async function fetchPeriod(periodStartTs) {
  const startTime = periodStartTs;
  const endTime = periodStartTs + PERIOD_MS - 1;
  let fromId = null;
  let buyUsd = 0;
  let sellUsd = 0;
  let buyEvents = 0;
  let sellEvents = 0;
  let trades = 0;

  while (true) {
    const url = new URL(BINANCE);
    url.searchParams.set('symbol', SYMBOL);
    url.searchParams.set('limit', '1000');
    if (fromId !== null) url.searchParams.set('fromId', String(fromId));
    else {
      url.searchParams.set('startTime', String(startTime));
      url.searchParams.set('endTime', String(endTime));
    }

    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Binance aggTrades ${response.status}`);
    const page = await response.json();
    if (!Array.isArray(page)) throw new Error('Binance aggTrades invalid response');
    if (!page.length) break;

    let reachedEnd = false;
    for (const trade of page) {
      const ts = Number(trade.T);
      const price = Number(trade.p);
      const qty = Number(trade.q);
      if (!Number.isFinite(ts) || !Number.isFinite(price) || !Number.isFinite(qty)) continue;
      if (ts < startTime) continue;
      if (ts > endTime) { reachedEnd = true; break; }
      const notional = price * qty;
      trades += 1;
      if (trade.m === true) {
        sellUsd += notional;
        sellEvents += 1;
      } else {
        buyUsd += notional;
        buyEvents += 1;
      }
    }

    const lastId = Number(page[page.length - 1]?.a);
    if (reachedEnd || page.length < 1000 || !Number.isFinite(lastId)) break;
    fromId = lastId + 1;
  }

  const totalUsd = buyUsd + sellUsd;
  const cvdUsd = buyUsd - sellUsd;
  const imbalancePct = totalUsd > 0 ? Math.abs(cvdUsd) / totalUsd * 100 : 0;
  const direction = cvdUsd > 0 ? 'BUY' : cvdUsd < 0 ? 'SELL' : 'NEUTRAL';
  return { buyUsd, sellUsd, cvdUsd, imbalancePct, buyEvents, sellEvents, trades, direction };
}

async function tick() {
  const completedStart = periodStart(Date.now()) - PERIOD_MS;
  const key = String(completedStart);
  if (saved.has(key)) return;

  try {
    const data = await fetchPeriod(completedStart);
    const currentStart = completedStart + PERIOD_MS;
    const currentMarket = await findMarketByEpoch('BTC', currentStart, '5m');
    const currentUrl = currentMarket?.url || `https://polymarket.com/event/btc-updown-5m-${Math.floor(currentStart / 1000)}`;

    await convexPost({
      symbol: 'BTC',
      periodStart: completedStart,
      periodEnd: completedStart + PERIOD_MS,
      buyUsd: Number(data.buyUsd.toFixed(2)),
      sellUsd: Number(data.sellUsd.toFixed(2)),
      cvdUsd: Number(data.cvdUsd.toFixed(2)),
      imbalancePct: Number(data.imbalancePct.toFixed(4)),
      buyEvents: data.buyEvents,
      sellEvents: data.sellEvents,
      trades: data.trades,
      direction: data.direction,
      recordedAt: Date.now()
    });

    const sign = data.cvdUsd >= 0 ? '+' : '';
    const message = [
      `🔥 BTC · 5M · CVD`,
      `DISBALANCE: ${data.direction}`,
      `CVD: ${sign}$${data.cvdUsd.toFixed(2)}`,
      `BUY: $${data.buyUsd.toFixed(2)}`,
      `SELL: $${data.sellUsd.toFixed(2)}`,
      `IMBALANCE: ${data.imbalancePct.toFixed(1)}%`,
      `TRADES: ${data.trades}`,
      '',
      '➡️ CURRENT · Polymarket 5M',
      currentUrl
    ].join('\n');

    await sendTelegramMessage(message);
    saved.add(key);
    console.log(`[cvd-5m] SAVED period=${completedStart} direction=${data.direction} cvd=${data.cvdUsd.toFixed(2)} trades=${data.trades}`);
  } catch (error) {
    console.error(`[cvd-5m] PERIOD FAILED period=${completedStart}: ${error.message}`);
  }
}

(async () => {
  console.log('[cvd-5m] start BTC 5m CVD monitor');
  await tick();
  setInterval(tick, POLL_MS);
})();
