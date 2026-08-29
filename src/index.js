import { createPublicClient } from '@polymarket/client';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IMBALANCE_THRESHOLD = Number(process.env.IMBALANCE_THRESHOLD ?? 0.40);
const LARGE_ORDER_USD = Number(process.env.LARGE_ORDER_USD ?? 100000);
const LIQUIDITY_PULL_THRESHOLD = Number(process.env.LIQUIDITY_PULL_THRESHOLD ?? 0.40);
const SPREAD_MULTIPLIER = Number(process.env.SPREAD_MULTIPLIER ?? 3);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 120000);
const BOOK_LEVELS = Number(process.env.BOOK_LEVELS ?? 10);

const client = createPublicClient();
const states = new Map();
const cooldowns = new Map();
const subscribed = new Set();

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}

function key(id, type) {
  return `${id}:${type}`;
}

function canAlert(k) {
  const now = Date.now();
  if ((cooldowns.get(k) ?? 0) > now) return false;
  cooldowns.set(k, now + COOLDOWN_MS);
  return true;
}

async function telegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(text);
    return;
  }
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true})
  });
  if (!response.ok) console.error('Telegram error:', await response.text());
}

function instrumentIdOf(event) {
  const value = event?.instrumentId ?? event?.instrument_id ?? event?.payload?.instrumentId ?? event?.payload?.instrument_id;
  const id = Number(value);
  return Number.isFinite(id) ? id : null;
}

function sideOf(level) {
  const side = String(level?.side ?? '').toUpperCase();
  if (side === 'BID' || side === 'BUY' || side === 'B') return 'BID';
  if (side === 'ASK' || side === 'SELL' || side === 'A') return 'ASK';
  return null;
}

function levelsFrom(value) {
  if (!Array.isArray(value)) return [];
  return value.map(x => ({
    price: num(x?.price ?? x?.p),
    size: num(x?.size ?? x?.quantity ?? x?.q),
    side: sideOf(x)
  })).filter(x => x.price > 0 && x.size > 0);
}

function normalizeBook(event) {
  const source = event?.book ?? event?.payload?.book ?? event?.data?.book ?? event?.payload ?? event;
  let bids = levelsFrom(source?.bids ?? source?.bid ?? event?.bids);
  let asks = levelsFrom(source?.asks ?? source?.ask ?? event?.asks);

  // Some stream payloads expose one flat level array with a side field.
  const flat = levelsFrom(source?.levels ?? source?.entries ?? event?.levels);
  if (flat.length && (!bids.length || !asks.length)) {
    bids = flat.filter(x => x.side === 'BID');
    asks = flat.filter(x => x.side === 'ASK');
  }
  return { bids, asks };
}

function stats(bids, asks) {
  const b = bids.slice().sort((a, z) => z.price - a.price).slice(0, BOOK_LEVELS);
  const a = asks.slice().sort((x, z) => x.price - z.price).slice(0, BOOK_LEVELS);
  const bidUsd = b.reduce((sum, x) => sum + x.price * x.size, 0);
  const askUsd = a.reduce((sum, x) => sum + x.price * x.size, 0);
  const total = bidUsd + askUsd;
  return {
    bids: b,
    asks: a,
    bidUsd,
    askUsd,
    imbalance: total ? (bidUsd - askUsd) / total : 0,
    bestBid: b[0]?.price ?? 0,
    bestAsk: a[0]?.price ?? 0
  };
}

function mergeLevels(previous, incoming) {
  if (!incoming.bids.length && !incoming.asks.length) return previous;
  const map = new Map();
  for (const x of [...previous.bids, ...previous.asks]) map.set(`${x.side}:${x.price}`, x);
  for (const x of [...incoming.bids, ...incoming.asks]) map.set(`${x.side}:${x.price}`, x);
  const bids = [...map.values()].filter(x => x.side === 'BID' && x.size > 0).map(({side, ...x}) => x);
  const asks = [...map.values()].filter(x => x.side === 'ASK' && x.size > 0).map(({side, ...x}) => x);
  return { bids, asks };
}

async function subscribeInstrument(id) {
  if (subscribed.has(id)) return;
  subscribed.add(id);
  const handle = await client.subscribe([
    { topic: 'perps.bbo', instrumentId: id },
    { topic: 'perps.book', instrumentId: id }
  ]);
  (async () => {
    try {
      for await (const event of handle) await handleEvent(event);
    } catch (error) {
      console.error(`Perps ${id} stream stopped:`, error);
      subscribed.delete(id);
    }
  })();
}

async function handleBbo(id, event) {
  const payload = event?.payload ?? event?.data ?? event;
  const bid = num(payload?.bestBid ?? payload?.best_bid ?? payload?.bid);
  const ask = num(payload?.bestAsk ?? payload?.best_ask ?? payload?.ask);
  if (!(bid > 0 && ask > 0)) return;

  const state = states.get(id) ?? { bids: [], asks: [], bestBid: 0, bestAsk: 0 };
  const previousSpread = state.bestBid > 0 && state.bestAsk > 0 ? state.bestAsk - state.bestBid : 0;
  const spread = ask - bid;
  const previous = states.get(id);
  state.bestBid = bid;
  state.bestAsk = ask;
  states.set(id, state);

  if (previous && previousSpread > 0 && spread >= previousSpread * SPREAD_MULTIPLIER && canAlert(key(id, 'spread'))) {
    await telegram(`🚨 PERPS BBO\n\nInstrument: ${id}\nBid: ${bid}\nAsk: ${ask}\nSpread: ${spread.toFixed(6)}\nPrevious: ${previousSpread.toFixed(6)}\n\n⚠️ Spread expanded ×${(spread / previousSpread).toFixed(1)}`);
  }
}

async function handleBook(id, event) {
  const incoming = normalizeBook(event);
  const old = states.get(id) ?? { bids: [], asks: [], bestBid: 0, bestAsk: 0 };
  const merged = mergeLevels(old, incoming);
  const current = stats(merged.bids, merged.asks);
  const previous = stats(old.bids, old.asks);
  states.set(id, {...current, bids: merged.bids, asks: merged.asks});

  if (!previous.bids.length && !previous.asks.length) return;

  if (Math.abs(current.imbalance) >= IMBALANCE_THRESHOLD && canAlert(key(id, current.imbalance > 0 ? 'bid-imbalance' : 'ask-imbalance'))) {
    const side = current.imbalance > 0 ? '🟢 BID dominance' : '🔴 ASK dominance';
    await telegram(`🚨 PERPS ORDER BOOK\n\nInstrument: ${id}\nBid liquidity: $${current.bidUsd.toFixed(0)}\nAsk liquidity: $${current.askUsd.toFixed(0)}\nImbalance: ${pct(current.imbalance)}\n\n${side}`);
  }

  const bidPull = previous.bidUsd > 0 ? (previous.bidUsd - current.bidUsd) / previous.bidUsd : 0;
  const askPull = previous.askUsd > 0 ? (previous.askUsd - current.askUsd) / previous.askUsd : 0;
  if (bidPull >= LIQUIDITY_PULL_THRESHOLD && canAlert(key(id, 'bid-pull'))) {
    await telegram(`⚠️ LIQUIDITY PULL\n\nInstrument: ${id}\nSide: BID\nLiquidity: $${previous.bidUsd.toFixed(0)} → $${current.bidUsd.toFixed(0)}\nRemoved: ${pct(bidPull)}`);
  }
  if (askPull >= LIQUIDITY_PULL_THRESHOLD && canAlert(key(id, 'ask-pull'))) {
    await telegram(`⚠️ LIQUIDITY PULL\n\nInstrument: ${id}\nSide: ASK\nLiquidity: $${previous.askUsd.toFixed(0)} → $${current.askUsd.toFixed(0)}\nRemoved: ${pct(askPull)}`);
  }

  const currentLarge = [...current.bids.map(x => ({...x, side: 'BID'})), ...current.asks.map(x => ({...x, side: 'ASK'}))];
  const previousKeys = new Set([...previous.bids.map(x => `BID:${x.price}`), ...previous.asks.map(x => `ASK:${x.price}`)]);
  for (const x of currentLarge) {
    const usd = x.price * x.size;
    if (usd >= LARGE_ORDER_USD && !previousKeys.has(`${x.side}:${x.price}`) && canAlert(key(id, `large-${x.side}-${x.price}`))) {
      await telegram(`🐋 LARGE ORDER\n\nInstrument: ${id}\nSide: ${x.side}\nPrice: ${x.price}\nSize: ${x.size}\nNotional: $${usd.toFixed(0)}`);
    }
  }
}

async function handleEvent(event) {
  const id = instrumentIdOf(event);
  if (id === null) return;

  const topic = event?.topic ?? event?.type;
  if (topic === 'perps.tickers' || topic === 'ticker') {
    await subscribeInstrument(id);
    return;
  }
  if (topic === 'perps.bbo' || topic === 'bbo') return handleBbo(id, event);
  if (topic === 'perps.book' || topic === 'book') return handleBook(id, event);
}

async function main() {
  console.log('Starting Polymarket Perps BBO + Order Book monitor...');
  console.log(`Thresholds: imbalance=${pct(IMBALANCE_THRESHOLD)}, large=$${LARGE_ORDER_USD}, pull=${pct(LIQUIDITY_PULL_THRESHOLD)}, spread×=${SPREAD_MULTIPLIER}`);

  const tickerHandle = await client.subscribe([{ topic: 'perps.tickers' }]);
  for await (const event of tickerHandle) await handleEvent(event);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
