const WebSocket = require('ws');
const { findMarketByEpoch, constructMarketUrl } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const PERIOD_MS = 5 * 60 * 1000;
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'DOGE', 'BNB'];
const EXCHANGES = ['binance', 'bybit', 'okx', 'gate', 'hyperliquid'];
const state = new Map();
const alertedPeriods = new Set();
const sockets = [];

function periodStart(ts) { return Math.floor(ts / PERIOD_MS) * PERIOD_MS; }
function bucket(symbol, start) {
  const key = `${symbol}:${start}`;
  if (!state.has(key)) state.set(key, { symbol, periodStart: start, buyUsd: 0, sellUsd: 0, trades: 0, exchanges: {} });
  return state.get(key);
}
function addTrade(symbol, ts, side, usd, exchange) {
  if (!Number.isFinite(ts) || !Number.isFinite(usd) || usd <= 0) return;
  const b = bucket(symbol, periodStart(ts));
  if (side === 'buy') b.buyUsd += usd;
  else if (side === 'sell') b.sellUsd += usd;
  else return;
  b.trades += 1;
  b.exchanges[exchange] = (b.exchanges[exchange] || 0) + usd;
}
function connectBinance(symbol) {
  const ws = new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}usdt@aggTrade`);
  ws.on('open', () => console.log(`[crowd-flow] Binance connected ${symbol}`));
  ws.on('message', raw => { try { const x = JSON.parse(raw); const price = Number(x.p), qty = Number(x.q), ts = Number(x.T); addTrade(symbol, ts, x.m ? 'sell' : 'buy', price * qty, 'binance'); } catch (e) { console.warn(`[crowd-flow] Binance parse ${symbol}: ${e.message}`); } });
  ws.on('close', () => setTimeout(() => connectBinance(symbol), 3000));
  ws.on('error', e => console.warn(`[crowd-flow] Binance ${symbol}: ${e.message}`));
  sockets.push(ws);
}
function connectBybit(symbol) {
  const ws = new WebSocket('wss://stream.bybit.com/v5/public/linear');
  ws.on('open', () => { ws.send(JSON.stringify({ op: 'subscribe', args: [`publicTrade.${symbol}USDT`] })); console.log(`[crowd-flow] Bybit connected ${symbol}`); });
  ws.on('message', raw => { try { const x = JSON.parse(raw); for (const t of (x.data || [])) { const price = Number(t.p), qty = Number(t.v), ts = Number(t.T); addTrade(symbol, ts, String(t.S).toLowerCase(), price * qty, 'bybit'); } } catch (e) { console.warn(`[crowd-flow] Bybit parse ${symbol}: ${e.message}`); } });
  ws.on('close', () => setTimeout(() => connectBybit(symbol), 3000));
  ws.on('error', e => console.warn(`[crowd-flow] Bybit ${symbol}: ${e.message}`));
  sockets.push(ws);
}
function connectOkx(symbol) {
  const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
  ws.on('open', () => { ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId: `${symbol}-USDT-SWAP` }] })); console.log(`[crowd-flow] OKX connected ${symbol}`); });
  ws.on('message', raw => { try { const x = JSON.parse(raw); for (const t of (x.data || [])) { const price = Number(t.p), qty = Number(t.sz), ts = Number(t.ts); addTrade(symbol, ts, String(t.side).toLowerCase(), price * qty, 'okx'); } } catch (e) { console.warn(`[crowd-flow] OKX parse ${symbol}: ${e.message}`); } });
  ws.on('close', () => setTimeout(() => connectOkx(symbol), 3000));
  ws.on('error', e => console.warn(`[crowd-flow] OKX ${symbol}: ${e.message}`));
  sockets.push(ws);
}
function connectGate(symbol) {
  const ws = new WebSocket('wss://fx-ws.gateio.ws/v4/ws/usdt');
  ws.on('open', () => { ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.trades', event: 'subscribe', payload: [`${symbol}_USDT`] })); console.log(`[crowd-flow] Gate connected ${symbol}`); });
  ws.on('message', raw => { try { const x = JSON.parse(raw); if (x.event !== 'update' || x.channel !== 'futures.trades') return; const rows = Array.isArray(x.result) ? x.result : [x.result]; for (const t of rows) { const price = Number(t.price), size = Number(t.size), ts = Number(t.create_time_ms || t.time_ms || Number(t.time) * 1000); addTrade(symbol, ts, size >= 0 ? 'buy' : 'sell', price * Math.abs(size), 'gate'); } } catch (e) { console.warn(`[crowd-flow] Gate parse ${symbol}: ${e.message}`); } });
  ws.on('close', () => setTimeout(() => connectGate(symbol), 3000));
  ws.on('error', e => console.warn(`[crowd-flow] Gate ${symbol}: ${e.message}`));
  sockets.push(ws);
}
function connectHyperliquid(symbol) {
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  ws.on('open', () => { ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: symbol } })); console.log(`[crowd-flow] Hyperliquid connected ${symbol}`); });
  ws.on('message', raw => { try { const x = JSON.parse(raw); const rows = Array.isArray(x.data) ? x.data : []; for (const t of rows) { const price = Number(t.px), qty = Number(t.sz), ts = Number(t.time); const side = String(t.side).toUpperCase(); addTrade(symbol, ts, side === 'B' ? 'buy' : side === 'A' ? 'sell' : null, price * qty, 'hyperliquid'); } } catch (e) { console.warn(`[crowd-flow] Hyperliquid parse ${symbol}: ${e.message}`); } });
  ws.on('close', () => setTimeout(() => connectHyperliquid(symbol), 3000));
  ws.on('error', e => console.warn(`[crowd-flow] Hyperliquid ${symbol}: ${e.message}`));
  sockets.push(ws);
}
function connectAll() {
  for (const symbol of SYMBOLS) {
    connectBinance(symbol); connectBybit(symbol); connectOkx(symbol); connectGate(symbol); connectHyperliquid(symbol);
  }
  console.log(`[crowd-flow] started ${SYMBOLS.length} coins × ${EXCHANGES.length} exchanges = ${SYMBOLS.length * EXCHANGES.length} streams`);
}
async function convexPost(data) {
  const base = process.env.CONVEX_URL, token = process.env.CONVEX_INGEST_TOKEN;
  if (!base || !token) throw new Error('Convex environment variables missing');
  const response = await fetch(`${base.replace(/\/$/, '')}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ type: 'crowdFlow.period', data }) });
  if (!response.ok) throw new Error(`Convex ${response.status}`);
}
async function claimAlert(periodStart, symbol) {
  const base = process.env.CONVEX_URL, token = process.env.CONVEX_INGEST_TOKEN;
  if (!base || !token) return true;
  try {
    const response = await fetch(`${base.replace(/\/$/, '')}/claim-crowd-flow-alert`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ periodStart, symbol, alertType: 'MAX_IMBALANCE' }) });
    if (!response.ok) return true;
    const result = await response.json().catch(() => ({}));
    return result.claimed !== false;
  } catch (e) {
    console.warn(`[crowd-flow] claim failed: ${e.message}; sending alert anyway`);
    return true;
  }
}
function completedBuckets(completedStart) { return [...state.values()].filter(x => x.periodStart === completedStart); }
async function processPeriod(completedStart) {
  const rows = completedBuckets(completedStart);
  if (!rows.length) { console.log(`[crowd-flow] period=${completedStart} no data`); return; }
  const enriched = rows.map(x => {
    const total = x.buyUsd + x.sellUsd;
    const cvdUsd = x.buyUsd - x.sellUsd;
    const imbalancePct = total > 0 ? Math.abs(cvdUsd) / total * 100 : 0;
    return { ...x, cvdUsd, imbalancePct, direction: cvdUsd >= 0 ? 'BUY' : 'SELL', periodEnd: completedStart + PERIOD_MS };
  });
  const winner = enriched.filter(x => x.buyUsd + x.sellUsd > 0).sort((a, b) => b.imbalancePct - a.imbalancePct)[0];
  console.log(`[crowd-flow] period=${completedStart} rows=${enriched.length} winner=${winner ? `${winner.symbol} ${winner.imbalancePct.toFixed(2)}%` : 'none'}`);

  for (const x of enriched) {
    try {
      await convexPost({ symbol: x.symbol, periodStart: x.periodStart, periodEnd: x.periodEnd, buyUsd: x.buyUsd, sellUsd: x.sellUsd, cvdUsd: x.cvdUsd, imbalancePct: x.imbalancePct, trades: x.trades, exchanges: x.exchanges, direction: x.direction, recordedAt: Date.now() });
    } catch (e) {
      console.error(`[crowd-flow] Convex failed ${x.symbol} period=${completedStart}: ${e.message}`);
    }
  }
  if (!winner || alertedPeriods.has(String(completedStart))) return;
  const claimed = await claimAlert(completedStart, winner.symbol);
  if (!claimed) { console.log(`[crowd-flow] alert already claimed period=${completedStart} symbol=${winner.symbol}`); return; }
  let url = constructMarketUrl(winner.symbol, completedStart + PERIOD_MS, '5m');
  try {
    const market = await findMarketByEpoch(winner.symbol, completedStart + PERIOD_MS, '5m');
    if (market?.url) url = market.url;
  } catch (e) { console.warn(`[crowd-flow] market lookup failed: ${e.message}; using fallback URL`); }
  const sign = winner.cvdUsd >= 0 ? 'BUY' : 'SELL';
  const message = [`🔥 ${winner.symbol} · 5M CVD IMBALANCE`,`IMBALANCE: ${winner.imbalancePct.toFixed(2)}% → ${sign}`,`CVD: ${winner.cvdUsd >= 0 ? '+' : '-'}$${Math.abs(winner.cvdUsd).toFixed(0)}`,`BUY: $${winner.buyUsd.toFixed(0)}`,`SELL: $${winner.sellUsd.toFixed(0)}`,`TRADES: ${winner.trades}`,'',`➡️ NEXT · Polymarket 5M`,url].join('\n');
  await sendTelegramMessage(message);
  alertedPeriods.add(String(completedStart));
  console.log(`[crowd-flow] ALERT period=${completedStart} winner=${winner.symbol} imbalance=${winner.imbalancePct.toFixed(2)}% cvd=${winner.cvdUsd.toFixed(0)}`);
  for (const x of enriched) state.delete(`${x.symbol}:${x.periodStart}`);
}
async function tick() {
  const completedStart = periodStart(Date.now()) - PERIOD_MS;
  try { await processPeriod(completedStart); } catch (e) { console.error(`[crowd-flow] PERIOD FAILED ${completedStart}: ${e.stack || e.message}`); }
}
process.on('SIGTERM', () => { for (const ws of sockets) try { ws.close(); } catch {} process.exit(0); });
process.on('SIGINT', () => { for (const ws of sockets) try { ws.close(); } catch {} process.exit(0); });
(async () => { console.log(`[crowd-flow] CVD 5m monitor: ${SYMBOLS.join(', ')}; exchanges=${EXCHANGES.join(', ')}; winner=max absolute imbalance per 5m period`); connectAll(); await tick(); setInterval(tick, 15000); })();
