const WebSocket = require('ws');
const { findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const PERIOD_MS = 5 * 60 * 1000;
const POLL_MS = 15000;
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'HYPE', 'DOGE', 'BNB'];
const EXCHANGES = ['binance', 'bybit', 'okx', 'gate', 'hyperliquid'];
const periods = new Map();
const seen = new Map();
const alerted = new Set();
const okxMeta = new Map();
const gateMeta = new Map();

function bucket(ts) { return Math.floor(ts / PERIOD_MS) * PERIOD_MS; }
function getPeriod(symbol, start) {
  const key = `${symbol}:${start}`;
  if (!periods.has(key)) periods.set(key, { symbol, periodStart: start, buyUsd: 0, sellUsd: 0, trades: 0, exchanges: {} });
  return periods.get(key);
}
function remember(exchange, id, ts) {
  if (!id) return true;
  const key = `${exchange}:${id}`;
  if (seen.has(key)) return false;
  seen.set(key, ts);
  return true;
}
function addTrade(exchange, symbol, ts, side, usd, id) {
  if (!SYMBOLS.includes(symbol) || !Number.isFinite(ts) || !Number.isFinite(usd) || usd <= 0 || !side) return;
  if (!remember(exchange, id, ts)) return;
  const p = getPeriod(symbol, bucket(ts));
  if (!p.exchanges[exchange]) p.exchanges[exchange] = { buyUsd: 0, sellUsd: 0, trades: 0 };
  const e = p.exchanges[exchange];
  p.trades += 1; e.trades += 1;
  if (side === 'BUY') { p.buyUsd += usd; e.buyUsd += usd; }
  else { p.sellUsd += usd; e.sellUsd += usd; }
}
function connect(name, url, onMessage, onOpen) {
  const ws = new WebSocket(url);
  ws.on('open', () => { console.log(`[crowd-flow] ${name} connected`); if (onOpen) onOpen(ws); });
  ws.on('message', raw => { try { onMessage(JSON.parse(raw.toString())); } catch (e) { console.warn(`[crowd-flow] ${name} parse: ${e.message}`); } });
  ws.on('error', e => console.warn(`[crowd-flow] ${name} error: ${e.message}`));
  ws.on('close', () => setTimeout(() => connect(name, url, onMessage, onOpen), 3000));
  return ws;
}
const BINANCE = Object.fromEntries(SYMBOLS.map(s => [s, `${s.toLowerCase()}usdt`]));
function connectBinance() {
  const streams = SYMBOLS.map(s => `${BINANCE[s]}@aggTrade`).join('/');
  connect('binance', `wss://fstream.binance.com/stream?streams=${streams}`, m => {
    const d = m.data; if (!d) return;
    const symbol = Object.keys(BINANCE).find(s => BINANCE[s] === String(d.s || '').toLowerCase());
    if (symbol) addTrade('binance', symbol, Number(d.T), d.m ? 'SELL' : 'BUY', Number(d.p) * Number(d.q), d.a || `${d.T}:${d.p}:${d.q}:${d.m}`);
  });
}
function connectBybit() {
  connect('bybit', 'wss://stream.bybit.com/v5/public/linear', m => {
    for (const t of (m.data || [])) {
      const symbol = String(t.s || '').replace(/USDT$/i, '').toUpperCase();
      const side = String(t.S || '').toUpperCase();
      addTrade('bybit', symbol, Number(t.T), side === 'BUY' ? 'BUY' : side === 'SELL' ? 'SELL' : null, Number(t.p) * Number(t.v), t.i || `${t.T}:${t.p}:${t.v}:${t.S}`);
    }
  }, ws => ws.send(JSON.stringify({ op: 'subscribe', args: SYMBOLS.map(s => `publicTrade.${s}USDT`) })));
}
async function loadOkxMeta() {
  const r = await fetch('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
  if (!r.ok) throw new Error(`OKX instruments ${r.status}`);
  const j = await r.json();
  for (const row of (j.data || [])) {
    const symbol = String(row.instId || '').split('-')[0].toUpperCase();
    if (SYMBOLS.includes(symbol)) okxMeta.set(symbol, { instId: row.instId, ctVal: Number(row.ctVal), ctValCcy: String(row.ctValCcy || '').toUpperCase() });
  }
}
function okxUsd(symbol, price, size) {
  const m = okxMeta.get(symbol); if (!m || !Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(m.ctVal)) return 0;
  return /^(USD|USDT|USDC)$/.test(m.ctValCcy) ? size * m.ctVal : price * size * m.ctVal;
}
function connectOkx() {
  connect('okx', 'wss://ws.okx.com:8443/ws/v5/public', m => {
    for (const t of (m.data || [])) {
      const symbol = String(t.instId || '').split('-')[0].toUpperCase();
      const side = String(t.side || '').toUpperCase();
      addTrade('okx', symbol, Number(t.ts), side === 'BUY' ? 'BUY' : side === 'SELL' ? 'SELL' : null, okxUsd(symbol, Number(t.px), Number(t.sz)), t.tradeId || `${t.ts}:${t.px}:${t.sz}:${t.side}`);
    }
  }, ws => ws.send(JSON.stringify({ op: 'subscribe', args: [...okxMeta.values()].map(m => ({ channel: 'trades', instId: m.instId })) })));
}
async function loadGateMeta() {
  await Promise.all(SYMBOLS.map(async symbol => {
    try {
      const r = await fetch(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${symbol}_USDT`);
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const multiplier = Number(j.quanto_multiplier || j.contract_size);
      if (Number.isFinite(multiplier) && multiplier > 0) gateMeta.set(symbol, multiplier);
    } catch (e) { console.warn(`[crowd-flow] Gate ${symbol} metadata: ${e.message}`); }
  }));
}
function connectGate() {
  connect('gate', 'wss://fx-ws.gateio.ws/v4/ws/usdt', m => {
    for (const t of (Array.isArray(m.result) ? m.result : [])) {
      const symbol = String(t.contract || '').replace(/_USDT$/i, '').toUpperCase();
      const size = Number(t.size), price = Number(t.price), multiplier = gateMeta.get(symbol);
      const ts = Number(t.create_time_ms || Number(t.create_time || 0) * 1000);
      if (!Number.isFinite(multiplier)) continue;
      addTrade('gate', symbol, ts, size >= 0 ? 'BUY' : 'SELL', Math.abs(size) * multiplier * price, t.id || t.trade_id || `${ts}:${size}:${price}`);
    }
  }, ws => ws.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), channel: 'futures.trades', event: 'subscribe', payload: SYMBOLS.map(s => `${s}_USDT`) })));
}
function connectHyperliquid() {
  connect('hyperliquid', 'wss://api.hyperliquid.xyz/ws', m => {
    if (m.channel !== 'trades') return;
    for (const t of (m.data || [])) {
      const symbol = String(t.coin || '').toUpperCase();
      const side = String(t.side || '').toUpperCase();
      addTrade('hyperliquid', symbol, Number(t.time), side === 'A' || side === 'BUY' ? 'BUY' : side === 'B' || side === 'SELL' ? 'SELL' : null, Number(t.px) * Number(t.sz), t.tid || t.id || `${t.time}:${t.px}:${t.sz}:${t.side}`);
    }
  }, ws => SYMBOLS.forEach(symbol => ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin: symbol } }))));
}
async function convexPost(data) {
  const base = String(process.env.CONVEX_URL || '').replace(/\/$/, ''), token = process.env.CONVEX_INGEST_TOKEN;
  if (!base || !token) return;
  const r = await fetch(`${base}/ingest`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ type: 'crowdFlow.imbalance5m', data }) });
  if (!r.ok) throw new Error(`Convex ${r.status}: ${await r.text()}`);
}
async function sendAlert(winner, nextStart) {
  const market = await findMarketByEpoch(winner.symbol, nextStart, '5m');
  const url = market?.url || `https://polymarket.com/event/${winner.symbol.toLowerCase()}-updown-5m-${Math.floor(nextStart / 1000)}`;
  const arrow = winner.cvdUsd > 0 ? 'BUY UP' : 'BUY DOWN';
  const text = [`🔥 ${winner.symbol} · 5M CROWD FLOW`,`IMBALANCE: ${winner.imbalancePct.toFixed(2)}% → ${arrow}`,`CVD: ${winner.cvdUsd >= 0 ? '+' : ''}$${winner.cvdUsd.toFixed(0)}`,`BUY: $${winner.buyUsd.toFixed(0)}`,`SELL: $${winner.sellUsd.toFixed(0)}`,`TRADES: ${winner.trades}`,'','➡️ NEXT · Polymarket 5M',url].join('\n');
  await sendTelegramMessage(text);
}
async function closeCompletedPeriods() {
  const current = bucket(Date.now());
  const completed = [...periods.values()].filter(p => p.periodStart < current);
  const byPeriod = new Map();
  for (const p of completed) {
    const total = p.buyUsd + p.sellUsd;
    p.cvdUsd = p.buyUsd - p.sellUsd;
    p.imbalancePct = total > 0 ? Math.abs(p.cvdUsd) / total * 100 : 0;
    p.direction = p.cvdUsd > 0 ? 'BUY' : p.cvdUsd < 0 ? 'SELL' : 'NEUTRAL';
    if (!byPeriod.has(p.periodStart)) byPeriod.set(p.periodStart, []);
    byPeriod.get(p.periodStart).push(p);
  }
  for (const [start, rows] of byPeriod) {
    for (const p of rows) await convexPost({ ...p, periodEnd: start + PERIOD_MS, recordedAt: Date.now() });
    if (!alerted.has(start)) {
      const candidates = rows.filter(p => p.buyUsd + p.sellUsd > 0).sort((a, b) => b.imbalancePct - a.imbalancePct);
      if (candidates.length) { alerted.add(start); await sendAlert(candidates[0], current); }
    }
    for (const p of rows) periods.delete(`${p.symbol}:${p.periodStart}`);
  }
  const cutoff = current - 2 * PERIOD_MS;
  for (const [key, ts] of seen) if (ts < cutoff) seen.delete(key);
}

(async () => {
  console.log(`[crowd-flow] NEW 5M MULTI-EXCHANGE IMBALANCE: ${SYMBOLS.join(',')} | ${EXCHANGES.join(',')} | NO THRESHOLD`);
  await loadOkxMeta();
  await loadGateMeta();
  connectBinance();
  connectBybit();
  connectOkx();
  connectGate();
  connectHyperliquid();
  setInterval(() => closeCompletedPeriods().catch(e => console.error(`[crowd-flow] close failed: ${e.message}`)), POLL_MS);
})().catch(e => { console.error(e); process.exitCode = 1; });
// start new monitor
