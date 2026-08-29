import { createPublicClient } from '@polymarket/client';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IMBALANCE_THRESHOLD = Number(process.env.IMBALANCE_THRESHOLD ?? 0.40);
const LARGE_ORDER_USD = Number(process.env.LARGE_ORDER_USD ?? 100000);
const LIQUIDITY_PULL_THRESHOLD = Number(process.env.LIQUIDITY_PULL_THRESHOLD ?? 0.40);
const SPREAD_MULTIPLIER = Number(process.env.SPREAD_MULTIPLIER ?? 3);
const COOLDOWN_MS = Number(process.env.SIGNAL_COOLDOWN_MS ?? process.env.COOLDOWN_MS ?? 120000);
const BOOK_LEVELS = Number(process.env.ORDER_BOOK_LEVELS ?? process.env.BOOK_LEVELS ?? 10);
const ALERT_ON_START = String(process.env.ALERT_ON_START ?? 'false').toLowerCase() === 'true';
const PREDICTION_MARKET_WINDOW_MS = 5 * 60 * 1000;

const client = createPublicClient();
const states = new Map();
const cooldowns = new Map();
const subscribed = new Set();
const diagnostics = { tickers: 0, bbo: 0, books: 0, normalizedBooks: 0, instruments: 0, alerts: 0 };

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const key = (id, type) => `${id}:${type}`;

function canAlert(k) {
  const now = Date.now();
  if ((cooldowns.get(k) ?? 0) > now) return false;
  cooldowns.set(k, now + COOLDOWN_MS);
  return true;
}

async function telegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) { console.log(text); return false; }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false })
  });
  if (!response.ok) console.error('Telegram error:', await response.text());
  if (response.ok) diagnostics.alerts++;
  return response.ok;
}

function instrumentIdOf(event) {
  const p = event?.payload ?? event?.data ?? event;
  const id = Number(event?.instrumentId ?? event?.instrument_id ?? p?.instrumentId ?? p?.instrument_id);
  return Number.isFinite(id) ? id : null;
}

function instrumentNameOf(event, id) {
  const p = event?.payload ?? event?.data ?? event;
  return String(p?.symbol ?? p?.ticker ?? p?.instrument ?? p?.instrumentName ?? p?.instrument_name ?? p?.market ?? id);
}

function assetSlugOf(event, id, fallbackName = '') {
  const p = event?.payload ?? event?.data ?? event;
  const raw = String(p?.symbol ?? p?.ticker ?? p?.asset ?? p?.underlying ?? p?.instrument ?? p?.instrumentName ?? p?.instrument_name ?? fallbackName ?? '').trim();
  const upper = raw.toUpperCase();
  const known = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
  const found = known.find(a => upper.includes(a));
  return found ? found.toLowerCase() : (upper.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(usd|usdt)$/, '') || `instrument-${id}`);
}

function marketLink(state) {
  const startMs = Math.floor(Date.now() / PREDICTION_MARKET_WINDOW_MS) * PREDICTION_MARKET_WINDOW_MS;
  const startSec = Math.floor(startMs / 1000);
  return `https://polymarket.com/event/${state.asset}-updown-5m-${startSec}`;
}

function sideOf(level) {
  const side = String(level?.side ?? '').toUpperCase();
  if (side === 'BID' || side === 'BUY' || side === 'B') return 'BID';
  if (side === 'ASK' || side === 'SELL' || side === 'A') return 'ASK';
  return null;
}

function levelsFrom(value, forcedSide = null) {
  if (!Array.isArray(value)) return [];
  return value.map(x => ({
    price: num(x?.price ?? x?.p), size: num(x?.size ?? x?.quantity ?? x?.q), side: forcedSide ?? sideOf(x)
  })).filter(x => x.price > 0 && x.size >= 0 && x.side);
}

function normalizeBook(event) {
  const source = event?.book ?? event?.payload?.book ?? event?.data?.book ?? event?.payload ?? event;
  let bids = levelsFrom(source?.bids ?? source?.bid ?? event?.bids, 'BID');
  let asks = levelsFrom(source?.asks ?? source?.ask ?? event?.asks, 'ASK');
  const flat = levelsFrom(source?.levels ?? source?.entries ?? event?.levels);
  if (flat.length && (!bids.length || !asks.length)) {
    bids = flat.filter(x => x.side === 'BID'); asks = flat.filter(x => x.side === 'ASK');
  }
  return { bids, asks };
}

function stats(bids, asks) {
  const b = bids.filter(x => x.size > 0).slice().sort((x, y) => y.price - x.price).slice(0, BOOK_LEVELS);
  const a = asks.filter(x => x.size > 0).slice().sort((x, y) => x.price - y.price).slice(0, BOOK_LEVELS);
  const bidUsd = b.reduce((sum, x) => sum + x.price * x.size, 0);
  const askUsd = a.reduce((sum, x) => sum + x.price * x.size, 0);
  const total = bidUsd + askUsd;
  return { bids: b, asks: a, bidUsd, askUsd, imbalance: total ? (bidUsd - askUsd) / total : 0,
    bestBid: b[0]?.price ?? 0, bestAsk: a[0]?.price ?? 0 };
}

function mergeLevels(previous, incoming) {
  const map = new Map();
  for (const x of previous.bids ?? []) map.set(`BID:${x.price}`, { ...x, side: 'BID' });
  for (const x of previous.asks ?? []) map.set(`ASK:${x.price}`, { ...x, side: 'ASK' });
  for (const x of [...incoming.bids, ...incoming.asks]) {
    const k = `${x.side}:${x.price}`;
    if (x.size > 0) map.set(k, x); else map.delete(k);
  }
  return {
    bids: [...map.values()].filter(x => x.side === 'BID' && x.size > 0),
    asks: [...map.values()].filter(x => x.side === 'ASK' && x.size > 0)
  };
}

function stateFor(id, name = String(id), event = null) {
  let state = states.get(id);
  if (!state) {
    state = { bids: [], asks: [], bestBid: 0, bestAsk: 0, name, asset: assetSlugOf(event, id, name) };
    states.set(id, state);
  }
  if (name && name !== String(id)) state.name = name;
  if (event) state.asset = assetSlugOf(event, id, state.name);
  return state;
}

async function subscribeInstrument(id) {
  if (subscribed.has(id)) return;
  subscribed.add(id);
  diagnostics.instruments++;
  try {
    const handle = await client.subscribe([{ topic: 'perps.bbo', instrumentId: id }, { topic: 'perps.book', instrumentId: id }]);
    for await (const event of handle) await handleEvent(event);
  } catch (error) {
    console.error(`Perps ${id} stream stopped:`, error); subscribed.delete(id);
  }
}

async function handleBbo(id, event) {
  diagnostics.bbo++;
  const p = event?.payload ?? event?.data ?? event;
  const bid = num(p?.bestBid ?? p?.best_bid ?? p?.bid);
  const ask = num(p?.bestAsk ?? p?.best_ask ?? p?.ask);
  if (!(bid > 0 && ask > 0)) return;
  const state = stateFor(id, instrumentNameOf(event, id), event);
  const previousSpread = state.bestBid > 0 && state.bestAsk > 0 ? state.bestAsk - state.bestBid : 0;
  const spread = ask - bid;
  state.bestBid = bid; state.bestAsk = ask;
  if (previousSpread > 0 && spread >= previousSpread * SPREAD_MULTIPLIER && canAlert(key(id, 'spread'))) {
    await telegram(`🚨 PERPS BBO\n\n${state.name}\nBid: ${bid}\nAsk: ${ask}\nSpread: ${spread.toFixed(6)}\nPrevious: ${previousSpread.toFixed(6)}\n\n⚠️ Spread expanded ×${(spread / previousSpread).toFixed(1)}\n\n🔗 ${marketLink(state)}`);
  }
}

async function handleBook(id, event) {
  diagnostics.books++;
  const incoming = normalizeBook(event);
  if (!incoming.bids.length && !incoming.asks.length) return;
  diagnostics.normalizedBooks++;
  const state = stateFor(id, instrumentNameOf(event, id), event);
  const previous = stats(state.bids, state.asks);
  const previousKeys = new Set([...state.bids.map(x => `BID:${x.price}`), ...state.asks.map(x => `ASK:${x.price}`)]);
  const merged = mergeLevels(state, incoming);
  const current = stats(merged.bids, merged.asks);
  state.bids = merged.bids; state.asks = merged.asks;
  if (!previous.bids.length && !previous.asks.length) return;

  if (Math.abs(current.imbalance) >= IMBALANCE_THRESHOLD && canAlert(key(id, current.imbalance > 0 ? 'bid-imbalance' : 'ask-imbalance'))) {
    const side = current.imbalance > 0 ? '🟢 BID dominance' : '🔴 ASK dominance';
    await telegram(`🚨 PERPS ORDER BOOK\n\n${state.name}\nBid liquidity: $${current.bidUsd.toFixed(0)}\nAsk liquidity: $${current.askUsd.toFixed(0)}\nImbalance: ${pct(current.imbalance)}\n\n${side}\n\n🎯 5m UP/DOWN\n🔗 ${marketLink(state)}`);
  }

  const bidPull = previous.bidUsd > 0 ? (previous.bidUsd - current.bidUsd) / previous.bidUsd : 0;
  const askPull = previous.askUsd > 0 ? (previous.askUsd - current.askUsd) / previous.askUsd : 0;
  if (bidPull >= LIQUIDITY_PULL_THRESHOLD && canAlert(key(id, 'bid-pull'))) {
    await telegram(`⚠️ LIQUIDITY PULL\n\n${state.name}\nSide: BID\nLiquidity: $${previous.bidUsd.toFixed(0)} → $${current.bidUsd.toFixed(0)}\nRemoved: ${pct(bidPull)}\n\n🎯 5m UP/DOWN\n🔗 ${marketLink(state)}`);
  }
  if (askPull >= LIQUIDITY_PULL_THRESHOLD && canAlert(key(id, 'ask-pull'))) {
    await telegram(`⚠️ LIQUIDITY PULL\n\n${state.name}\nSide: ASK\nLiquidity: $${previous.askUsd.toFixed(0)} → $${current.askUsd.toFixed(0)}\nRemoved: ${pct(askPull)}\n\n🎯 5m UP/DOWN\n🔗 ${marketLink(state)}`);
  }

  for (const x of [...current.bids.map(x => ({ ...x, side: 'BID' })), ...current.asks.map(x => ({ ...x, side: 'ASK' }))]) {
    const notional = x.price * x.size;
    const levelKey = `${x.side}:${x.price}`;
    if (notional >= LARGE_ORDER_USD && !previousKeys.has(levelKey) && canAlert(key(id, `large-${levelKey}`))) {
      await telegram(`🐋 LARGE ORDER\n\n${state.name}\nSide: ${x.side}\nPrice: ${x.price}\nSize: ${x.size}\nNotional: $${notional.toFixed(0)}\n\n🎯 5m UP/DOWN\n🔗 ${marketLink(state)}`);
    }
  }
}

async function handleEvent(event) {
  const topic = event?.topic ?? event?.type;
  const id = instrumentIdOf(event);
  if (topic === 'perps.tickers') { diagnostics.tickers++; if (id !== null) await subscribeInstrument(id); return; }
  if (id === null) return;
  if (topic === 'perps.bbo') return handleBbo(id, event);
  if (topic === 'perps.book') return handleBook(id, event);
}

function diagnosticsReport() {
  console.log(`[ORDERBOOK DIAG] tickers=${diagnostics.tickers} instruments=${diagnostics.instruments} bbo=${diagnostics.bbo} books=${diagnostics.books} normalized=${diagnostics.normalizedBooks} alerts=${diagnostics.alerts} subscribed=${subscribed.size}`);
  for (const [id, state] of states) {
    const s = stats(state.bids, state.asks);
    if (s.bids.length || s.asks.length) {
      console.log(`[ORDERBOOK] ${state.name} id=${id} bid=$${s.bidUsd.toFixed(0)} ask=$${s.askUsd.toFixed(0)} imbalance=${pct(s.imbalance)} bestBid=${s.bestBid} bestAsk=${s.bestAsk}`);
    }
  }
}

async function main() {
  console.log('Starting Polymarket Perps BBO + Order Book monitor...');
  console.log(`Thresholds: imbalance=${pct(IMBALANCE_THRESHOLD)}, large=$${LARGE_ORDER_USD}, pull=${pct(LIQUIDITY_PULL_THRESHOLD)}, spread×=${SPREAD_MULTIPLIER}, levels=${BOOK_LEVELS}, cooldown=${COOLDOWN_MS}ms`);
  console.log('[ORDERBOOK DIAG] diagnostics enabled; report every 60s');
  setInterval(diagnosticsReport, 60000);
  if (ALERT_ON_START) await telegram('✅ Polymarket Perps Monitor started\nBBO + Order Book stream is online.');
  const tickerHandle = await client.subscribe([{ topic: 'perps.tickers' }]);
  for await (const event of tickerHandle) await handleEvent(event);
}

main().catch(err => { console.error(err); process.exit(1); });
