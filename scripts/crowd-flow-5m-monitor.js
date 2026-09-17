const WebSocket = require('ws');
const { findMarketByEpoch, constructMarketUrl } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const PERIOD_MS = 5 * 60 * 1000;
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE'];
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
  ws.on('message', raw => { try { const x = JSON.parse(raw); for (const t of x.data || []) { const price = Number(t.p), qty = Number(t.v), ts = Number(t.T); addTrade(symbol, ts, t.S === 'Buy' ? 'buy' : 'sell', price * qty, 'bybit'); } } catch (e) { console.warn(`[crowd-flow] Bybit parse ${symbol}: ${e.message}`); } });
  ws.on('close', () => setTimeout(() => connectBybit(symbol), 3000));
  ws.on('error', e => console.warn(`[crowd-flow] Bybit ${symbol}: ${e.message}`));
  sockets.push(ws);
}
function connectOkx(symbol) {
  const ws = new WebSocket('wss://ws.okx.com:8443/ws/v5/public');
  ws.on('open', () => { ws.send(JSON.stringify({ op: 'subscribe', args: [{ channel: 'trades', instId: `${symbol}-USDT-SWAP` }] })); console.log(`[crowd-flow] OKX connected ${symbol}`); });
  ws.on('message', raw => { try { const x = JSON.parse(raw); for (const t of x.data || []) { const price = Number(t.px), size = Number(t.sz), ts = Number(t.ts); addTrade(symbol, ts, t.side === 'buy' ? 'buy' : 'sell', price * size * 0.01, 'okx'); } } catch (e) { console.warn(`[crowd-flow] OKX parse ${symbol}: ${e.message}`); } });
  ws.on('close', () => setTimeout(() => connectOkx(symbol), 3000));
  ws.on('error', e => console.warn(`[crowd-flow] OKX ${symbol}: ${e.message}`));
  sockets.push(ws);
}
async function connectGate(symbol) {
  try {
    const r = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${symbol}_USDT`);
    const meta = await r.json();
    const contractSize = Number(meta.quanto_multiplier || meta.contract_size || 1);
    const ws = new WebSocket('wss://fx-ws.gateio.ws/v4/ws/usdt');
    ws.on('open', () => { ws.send(JSON.stringify({ time: Math.floor(Date.now()/1000), channel: 'futures.trades', event: 'subscribe', payload: [`${symbol}_USDT`] })); console.log(`[crowd-flow] Gate connected ${symbol}`); });
    ws.on('message', raw => { try { const x = JSON.parse(raw); for (const t of x.result || []) { const price = Number(t.price), size = Number(t.size), ts = Number(t.create_time_ms || Date.now()); addTrade(symbol, ts, size >= 0 ? 'buy' : 'sell', Math.abs(size) * contractSize * price, 'gate'); } } catch (e) { console.warn(`[crowd-flow] Gate parse ${symbol}: ${e.message}`); } });
    ws.on('close', () => setTimeout(() => connectGate(symbol), 3000));
    ws.on('error', e => console.warn(`[crowd-flow] Gate ${symbol}: ${e.message}`));
    sockets.push(ws);
  } catch (e) { console.warn(`[crowd-flow] Gate setup ${symbol}: ${e.message}`); setTimeout(() => connectGate(symbol), 5000); }
}
function connectHyperliquid(symbol) {
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');
  ws.on('open', () => { ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: symbol } })); console.log(`[crowd-flow] Hyperliquid connected ${symbol}`); });
  ws.on('message', raw => { try { const x = JSON.parse(raw); for (const t of x.data || []) { const price = Number(t.px), size = Number(t.sz), ts = Number(t.time); const side = t.side === 'A' || t.side === 'BUY' ? 'buy' : 'sell'; addTrade(symbol, ts, side, price * size, 'hyperliquid'); } } catch (e) { console.warn(`[crowd-flow] Hyperliquid parse ${symbol}: ${e.message}`); } });
  ws.on('close', () => setTimeout(() => connectHyperliquid(symbol), 3000));
  ws.on('error', e => console.warn(`[crowd-flow] Hyperliquid ${symbol}: ${e.message}`));
  sockets.push(ws);
}
function closeCompletedPeriods() {
  const now = Date.now();
  const current = periodStart(now);
  const completed = [...state.values()].filter(b => b.periodStart < current);
  const byPeriod = new Map();
  for (const b of completed) {
    if (!byPeriod.has(b.periodStart)) byPeriod.set(b.periodStart, []);
    byPeriod.get(b.periodStart).push(b);
  }
  for (const [p, rows] of byPeriod) {
    for (const b of rows) {
      const total = b.buyUsd + b.sellUsd;
      b.cvdUsd = b.buyUsd - b.sellUsd;
      b.imbalancePct = total > 0 ? Math.abs(b.cvdUsd) / total * 100 : 0;
      b.direction = b.cvdUsd >= 0 ? 'BUY' : 'SELL';
      console.log(`[crowd-flow] closed ${b.symbol} ${p} BUY=${b.buyUsd.toFixed(2)} SELL=${b.sellUsd.toFixed(2)} CVD=${b.cvdUsd.toFixed(2)} IMB=${b.imbalancePct.toFixed(2)} TRADES=${b.trades}`);
    }
    rows.sort((a, b) => b.imbalancePct - a.imbalancePct);
    const winner = rows[0];
    if (winner && !alertedPeriods.has(p) && winner.imbalancePct > 0) {
      alertedPeriods.add(p);
      sendAlert(winner).catch(e => console.warn(`[crowd-flow] alert error: ${e.message}`));
    }
    for (const b of rows) {
      fetch(`${process.env.CONVEX_URL}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CONVEX_INGEST_TOKEN}` }, body: JSON.stringify({ type: 'crowdFlow.period', symbol: b.symbol, periodStart: b.periodStart, buyUsd: b.buyUsd, sellUsd: b.sellUsd, cvdUsd: b.cvdUsd, imbalancePct: b.imbalancePct, trades: b.trades, direction: b.direction }) }).catch(e => console.warn(`[crowd-flow] convex ${b.symbol}: ${e.message}`));
      state.delete(`${b.symbol}:${b.periodStart}`);
    }
  }
}
async function sendAlert(b) {
  const claimed = await fetch(`${process.env.CONVEX_URL}/claim-crowd-flow-alert`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.CONVEX_INGEST_TOKEN}` }, body: JSON.stringify({ symbol: b.symbol, periodStart: b.periodStart }) }).then(r => r.json());
  if (!claimed.ok) return;
  const market = await findMarketByEpoch(b.symbol, Date.now(), '5m');
  const url = market ? constructMarketUrl(market) : '';
  const arrow = b.direction === 'BUY' ? '⬆️ BUY UP' : '⬇️ BUY DOWN';
  const text = `🔥 ${b.symbol} · 5M · ${arrow}\nCVD: ${b.cvdUsd >= 0 ? '+' : '-'}$${Math.abs(b.cvdUsd).toFixed(0)}\nBUY: $${b.buyUsd.toFixed(0)}\nSELL: $${b.sellUsd.toFixed(0)}\nIMBALANCE: ${b.imbalancePct.toFixed(1)}%\nTRADES: ${b.trades}\n\n➡️ Polymarket 5M\n${url}`;
  await sendTelegramMessage(text);
}
for (const symbol of SYMBOLS) { connectBinance(symbol); connectBybit(symbol); connectOkx(symbol); connectGate(symbol); connectHyperliquid(symbol); }
setInterval(closeCompletedPeriods, 15000);
console.log(`[crowd-flow] started symbols=${SYMBOLS.join(',')} exchanges=${EXCHANGES.join(',')}`);
