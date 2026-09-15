const WebSocket = globalThis.WebSocket;
const { bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

if (!WebSocket) throw new Error('WebSocket unavailable');

const SYMBOLS = ['BTC'];
const PERIOD = 300000;
const MIN_TRADES = 1500;
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

async function convexPost(type, data) {
  const base = process.env.CONVEX_URL;
  const token = process.env.CONVEX_INGEST_TOKEN;
  if (!base || !token) return;
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/ingest`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ type, data })
    });
    if (!response.ok) throw new Error(`Convex ${response.status}`);
  } catch (e) {
    console.error(`[crowd-flow] Convex stats write failed: ${e.message}`);
  }
}

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
  const trades = await fetchFullPeriodTrades(v.market, v.start);
  if (trades === null) return false;
  let up = 0, down = 0, lu = null, ld = null, luTs = -Infinity, ldTs = -Infinity;
  const upToken = String(v.market.tokenIds.UP);
  const downToken = String(v.market.tokenIds.DOWN);
  for (const trade of trades) {
    const asset = String(trade.asset || '');
    const p = Number(trade.price);
    const q = Number(trade.size);
    const ts = Number(trade.timestamp);
    if (!Number.isFinite(p) || !Number.isFinite(q) || q <= 0) continue;
    if (asset === upToken) {
      up += p * q;
      if (ts >= luTs) { lu = p; luTs = ts; }
    } else if (asset === downToken) {
      down += p * q;
      if (ts >= ldTs) { ld = p; ldTs = ts; }
    }
  }
  v.trades = trades.length;
  v.up = up;
  v.down = down;
  v.lu = lu;
  v.ld = ld;
  v.backfilled = true;
  return true;
}

async function checkBoundary(currentStart) {
  const justFinishedStart = currentStart - PERIOD;
  const current = completed.get(key('BTC', justFinishedStart));
  if (!current || current.alertChecked) return;

  try {
    const ok = await backfillPeriod(current);
    if (!ok) return;
    current.alertChecked = true;

    console.log(`[crowd-flow] BTC trades=${current.trades} threshold=${MIN_TRADES} period=${justFinishedStart}`);

    await convexPost('crowdFlow.period', {
      symbol:'BTC',
      periodStart:justFinishedStart,
      periodEnd:justFinishedStart + PERIOD,
      trades:current.trades,
      direction: current.trades >= MIN_TRADES ? 'UP' : 'NOT_UP',
      closeUp:current.lu ?? undefined,
      closeDown:current.ld ?? undefined,
      recordedAt:Date.now()
    });

    if (current.trades < MIN_TRADES) return;

    const currentMarket = markets.get(key('BTC', currentStart));
    const currentUrl = currentMarket?.market?.url || `https://polymarket.com/event/btc-updown-5m-${Math.floor(currentStart / 1000)}`;
    if (alertedLinks.has(currentUrl)) return;
    alertedLinks.add(currentUrl);

    await sendTelegramMessage([
      '🔥 BTC · 5M CROWD FLOW',
      `TRADES: ${current.trades}`,
      `THRESHOLD: ${MIN_TRADES}+`,
      `CLOSE UP: ${current.lu ?? 'N/A'}`,
      `CLOSE DOWN: ${current.ld ?? 'N/A'}`,
      '', '➡️ CURRENT · Polymarket 5M', currentUrl
    ].join('\n'));
    console.log(`[crowd-flow] ALERT BTC trades=${current.trades} threshold=${MIN_TRADES} closeUp=${current.lu ?? 'N/A'} closeDown=${current.ld ?? 'N/A'} boundary=${currentStart}`);
  } catch (e) {
    console.error(`[crowd-flow] CHECK FAILED BTC period=${justFinishedStart}: ${e.message}`);
  }
}

async function refresh() {
  const t = start();
  const symbol = 'BTC';
  const market = await findMarketByEpoch(symbol, t, '5m');
  if (!market?.tokenIds?.UP || !market?.tokenIds?.DOWN) {
    console.log(`[crowd-flow] BTC market unavailable period=${t}`);
    return;
  }
  const k = key(symbol, t);
  if (!markets.has(k)) markets.set(k, { symbol, start:t, market, up:0, down:0, trades:0, lu:null, ld:null, backfilled:false });
  tokens.set(market.tokenIds.UP, { k, o:'UP' });
  tokens.set(market.tokenIds.DOWN, { k, o:'DOWN' });

  const previousStart = t - PERIOD;
  const previous = markets.get(key(symbol, previousStart));
  if (previous && !completed.has(key(symbol, previousStart))) completed.set(key(symbol, previousStart), { ...previous });

  await checkBoundary(t);
  for (const [mk, v] of markets) if (v.start < t - PERIOD) markets.delete(mk);
  for (const [ck, v] of completed) if (v.start < t - PERIOD * 4) completed.delete(ck);

  if (socket?.readyState === WebSocket.OPEN) {
    const ids = [...tokens].filter(([,v]) => markets.get(v.k)?.start === t).map(([id]) => id);
    if (ids.length) {
      socket.send(JSON.stringify({ assets_ids:ids, type:'market' }));
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
  const p = Number(x.price), q = Number(x.size), n = p * q;
  if (!Number.isFinite(n) || n <= 0) return;
  v.trades += 1;
  if (m.o === 'UP') { v.up += n; v.lu = p; } else { v.down += n; v.ld = p; }
}

function diagnostics() {
  const t = start();
  const v = markets.get(key('BTC', t));
  if (v) console.log(`[crowd-flow] DIAG BTC=${v.trades}`);
}

function connect() {
  socket = new WebSocket(WS);
  socket.onopen = () => refresh();
  socket.onmessage = e => { try { const x=JSON.parse(e.data); (Array.isArray(x)?x:[x]).forEach(event); } catch {} };
  socket.onclose = () => setTimeout(connect, 3000);
  socket.onerror = () => { try { socket.close(); } catch {} };
}

(async () => {
  console.log(`[crowd-flow] start BTC threshold=${MIN_TRADES} no-streak`);
  await refresh();
  connect();
  setInterval(() => refresh().catch(e => console.error('[crowd-flow]', e.message)), 30000);
  setInterval(diagnostics, 60000);
})();
