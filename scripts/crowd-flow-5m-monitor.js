const WebSocket = globalThis.WebSocket;
const { bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

if (!WebSocket) throw new Error('WebSocket unavailable');

const SYMBOLS = ['BTC'];
const PERIOD = 300000;
const WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const DATA_API = 'https://data-api.polymarket.com/trades';

const markets = new Map();
const tokens = new Map();
const seen = new Set();
const alertedLinks = new Set();
const completed = new Map();
let socket;

const start = () => bucketStart(Date.now(), '5m');
const key = (symbol, period) => `${symbol}:${period}`;

async function fetchFullPeriodTrades(market, periodStart) {
  if (!market?.conditionId) return null;

  const startSec = Math.floor(periodStart / 1000);
  const endSec = startSec + Math.floor(PERIOD / 1000);
  const rows = [];
  const seenRows = new Set();
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

async function backfillPeriod(v) {
  if (v.backfilled) return true;
  const trades = await fetchFullPeriodTrades(v.market, v.start);
  if (trades === null) return false;

  v.trades = trades.length;
  v.backfilled = true;
  return true;
}

async function checkBoundary(currentStart) {
  const periodStart = currentStart - PERIOD;
  const current = completed.get(key('BTC', periodStart));
  if (!current || current.alertChecked) return;

  try {
    const ok = await backfillPeriod(current);
    if (!ok) return;
  } catch (e) {
    console.error(`[crowd-flow] BACKFILL FAILED BTC period=${periodStart}: ${e.message}`);
    return;
  }

  const previousStart = periodStart - PERIOD;
  const previous = completed.get(key('BTC', previousStart));

  // Wait until the immediately previous 5M period is also available and backfilled.
  if (!previous) return;

  try {
    const ok = await backfillPeriod(previous);
    if (!ok) return;
  } catch (e) {
    console.error(`[crowd-flow] BACKFILL FAILED BTC previous=${previousStart}: ${e.message}`);
    return;
  }

  const diff = current.trades - previous.trades;
  const direction = diff > 0 ? 'MORE' : diff < 0 ? 'LESS' : 'SAME';
  const change = diff > 0 ? `+${diff}` : String(diff);

  const live = markets.get(key('BTC', currentStart));
  const currentUrl = live?.market?.url || `https://polymarket.com/event/btc-updown-5m-${Math.floor(currentStart / 1000)}`;

  if (alertedLinks.has(currentUrl)) {
    current.alertChecked = true;
    return;
  }

  alertedLinks.add(currentUrl);
  current.alertChecked = true;

  await sendTelegramMessage([
    '🔥 BTC · 5M',
    `TRADES: ${current.trades}`,
    `PREVIOUS: ${previous.trades}`,
    `CHANGE: ${direction} ${change}`,
    '',
    '➡️ CURRENT · Polymarket 5M',
    currentUrl
  ].join('\n'));

  console.log(`[crowd-flow] ALERT BTC trades=${current.trades} previous=${previous.trades} change=${change} direction=${direction} boundary=${currentStart}`);
}

async function refresh() {
  const t = start();

  const market = await findMarketByEpoch('BTC', t, '5m');
  if (!market?.tokenIds?.UP || !market?.tokenIds?.DOWN) {
    console.log(`[crowd-flow] BTC market unavailable period=${t}`);
    return;
  }

  const k = key('BTC', t);
  if (!markets.has(k)) {
    markets.set(k, {
      symbol: 'BTC',
      start: t,
      market,
      trades: 0,
      backfilled: false,
      alertChecked: false
    });
  }

  tokens.set(market.tokenIds.UP, { k, o: 'UP' });
  tokens.set(market.tokenIds.DOWN, { k, o: 'DOWN' });

  const previousStart = t - PERIOD;
  const previous = markets.get(key('BTC', previousStart));
  if (previous && !completed.has(key('BTC', previousStart))) {
    completed.set(key('BTC', previousStart), { ...previous });
  }

  await checkBoundary(t);

  for (const [mk, v] of markets) {
    if (v.start < t - PERIOD) markets.delete(mk);
  }

  for (const [ck, v] of completed) {
    if (v.start < t - PERIOD * 4) completed.delete(ck);
  }

  if (socket?.readyState === WebSocket.OPEN) {
    const ids = [...tokens]
      .filter(([, v]) => markets.get(v.k)?.start === t)
      .map(([id]) => id);

    if (ids.length) {
      socket.send(JSON.stringify({ assets_ids: ids, type: 'market' }));
      console.log(`[crowd-flow] subscribed tokens=${ids.length} symbol=BTC period=${t}`);
    }
  }
}

function event(x) {
  if (x?.event_type !== 'last_trade_price') return;

  const m = tokens.get(String(x.asset_id));
  if (!m) return;

  const v = markets.get(m.k);
  if (!v || v.start !== start()) return;

  const id = `${x.asset_id}:${x.timestamp}:${x.transaction_hash || x.price}`;
  if (seen.has(id)) return;
  seen.add(id);

  const p = Number(x.price);
  const q = Number(x.size);
  if (!Number.isFinite(p) || !Number.isFinite(q) || q <= 0) return;
  v.trades += 1;
}

function diagnostics() {
  const t = start();
  const v = markets.get(key('BTC', t));
  if (v) console.log(`[crowd-flow] DIAG BTC=${v.trades}`);
}

function connect() {
  socket = new WebSocket(WS);
  socket.onopen = () => refresh();
  socket.onmessage = e => {
    try {
      const x = JSON.parse(e.data);
      (Array.isArray(x) ? x : [x]).forEach(event);
    } catch {}
  };
  socket.onclose = () => setTimeout(connect, 3000);
  socket.onerror = () => {
    try { socket.close(); } catch {}
  };
}

(async () => {
  console.log('[crowd-flow] start BTC');
  await refresh();
  connect();
  setInterval(() => refresh().catch(e => console.error('[crowd-flow]', e.message)), 30000);
  setInterval(diagnostics, 60000);
})();
