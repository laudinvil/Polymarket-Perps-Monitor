import { createPublicClient } from '@polymarket/client';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LARGE_ORDER_USD = Number(process.env.LARGE_ORDER_USD ?? 25000);
const COOLDOWN_MS = Number(process.env.SIGNAL_COOLDOWN_MS ?? process.env.COOLDOWN_MS ?? 60000);
const BOOK_LEVELS = Number(process.env.ORDER_BOOK_LEVELS ?? process.env.BOOK_LEVELS ?? 10);

const client = createPublicClient();
const states = new Map();
const cooldowns = new Map();
const subscribed = new Set();

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
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
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true })
  });
  if (!response.ok) console.error('Telegram error:', await response.text());
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
  return {
    bids: b,
    asks: a,
    bidUsd: b.reduce((sum, x) => sum + x.price * x.size, 0),
    askUsd: a.reduce((sum, x) => sum + x.price * x.size, 0)
  };
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

function stateFor(id, name = String(id)) {
  let state = states.get(id);
  if (!state) { state = { bids: [], asks: [], name }; states.set(id, state); }
  if (name && name !== String(id)) state.name = name;
  return state;
}

async function subscribeInstrument(id) {
  if (subscribed.has(id)) return;
  subscribed.add(id);
  try {
    const handle = await client.subscribe([{ topic: 'perps.book', instrumentId: id }]);
    for await (const event of handle) await handleEvent(event);
  } catch (error) {
    console.error(`Perps ${id} stream stopped:`, error); subscribed.delete(id);
  }
}

async function handleBook(id, event) {
  const incoming = normalizeBook(event);
  if (!incoming.bids.length && !incoming.asks.length) return;
  const state = stateFor(id, instrumentNameOf(event, id));
  const previous = stats(state.bids, state.asks);
  const previousKeys = new Set([...state.bids.map(x => `BID:${x.price}`), ...state.asks.map(x => `ASK:${x.price}`)]);
  const merged = mergeLevels(state, incoming);
  const current = stats(merged.bids, merged.asks);
  state.bids = merged.bids;
  state.asks = merged.asks;
  if (!previous.bids.length && !previous.asks.length) return;

  for (const x of [...current.bids.map(x => ({ ...x, side: 'BID' })), ...current.asks.map(x => ({ ...x, side: 'ASK' }))]) {
    const notional = x.price * x.size;
    const levelKey = `${x.side}:${x.price}`;
    if (notional >= LARGE_ORDER_USD && !previousKeys.has(levelKey) && canAlert(key(id, `large-${levelKey}`))) {
      await telegram(`🐋 LARGE ORDER\n\n${state.name}\nSide: ${x.side}\nPrice: ${x.price}\nSize: ${x.size}\nNotional: $${notional.toFixed(0)}`);
    }
  }
}

async function handleEvent(event) {
  const topic = event?.topic ?? event?.type;
  const id = instrumentIdOf(event);
  if (topic === 'perps.tickers') { if (id !== null) await subscribeInstrument(id); return; }
  if (id !== null && topic === 'perps.book') await handleBook(id, event);
}

async function main() {
  console.log('Starting Polymarket Perps Large Order monitor...');
  console.log(`Large Order threshold: $${LARGE_ORDER_USD}; cooldown=${COOLDOWN_MS}ms; levels=${BOOK_LEVELS}`);
  const tickerHandle = await client.subscribe([{ topic: 'perps.tickers' }]);
  for await (const event of tickerHandle) await handleEvent(event);
}

main().catch(err => { console.error(err); process.exit(1); });
