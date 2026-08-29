import { createPublicClient } from '@polymarket/client';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const IMBALANCE_THRESHOLD = Number(process.env.IMBALANCE_THRESHOLD ?? 0.40);
const LARGE_ORDER_USD = Number(process.env.LARGE_ORDER_USD ?? 100000);
const LIQUIDITY_PULL_THRESHOLD = Number(process.env.LIQUIDITY_PULL_THRESHOLD ?? 0.40);
const SPREAD_MULTIPLIER = Number(process.env.SPREAD_MULTIPLIER ?? 3);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 120000);

const state = new Map();
const cooldowns = new Map();

const client = createPublicClient();

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function pct(v) { return `${(v * 100).toFixed(1)}%`; }
function key(id, type) { return `${id}:${type}`; }
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
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: {'content-type':'application/json'},
    body: JSON.stringify({chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false})
  });
}

function bookStats(book) {
  const bids = (book.bids ?? []).map(x => ({p:num(x.price), s:num(x.size)})).filter(x=>x.p>0&&x.s>0);
  const asks = (book.asks ?? []).map(x => ({p:num(x.price), s:num(x.size)})).filter(x=>x.p>0&&x.s>0);
  const bidUsd = bids.reduce((a,x)=>a+x.p*x.s,0);
  const askUsd = asks.reduce((a,x)=>a+x.p*x.s,0);
  const total = bidUsd + askUsd;
  return {
    bids, asks, bidUsd, askUsd,
    imbalance: total ? (bidUsd-askUsd)/total : 0,
    bestBid: bids[0]?.p ?? 0,
    bestAsk: asks[0]?.p ?? 0
  };
}

async function handleBook(instrumentId, event) {
  const book = event.book ?? event;
  const current = bookStats(book);
  const previous = state.get(instrumentId);
  state.set(instrumentId, current);
  if (!previous) return;

  const spread = current.bestBid > 0 && current.bestAsk > 0 ? current.bestAsk-current.bestBid : 0;
  const prevSpread = previous.bestBid > 0 && previous.bestAsk > 0 ? previous.bestAsk-previous.bestBid : 0;

  if (prevSpread > 0 && spread >= prevSpread * SPREAD_MULTIPLIER && canAlert(key(instrumentId,'spread'))) {
    await telegram(`🚨 PERPS BBO\n\nInstrument: ${instrumentId}\nBid: ${current.bestBid}\nAsk: ${current.bestAsk}\nSpread: ${spread.toFixed(4)}\nPrevious spread: ${prevSpread.toFixed(4)}\n\n⚠️ Spread expanded ×${(spread/prevSpread).toFixed(1)}`);
  }

  if (Math.abs(current.imbalance) >= IMBALANCE_THRESHOLD && canAlert(key(instrumentId,current.imbalance > 0 ? 'bid-imbalance':'ask-imbalance'))) {
    const side = current.imbalance > 0 ? '🟢 BID dominance' : '🔴 ASK dominance';
    await telegram(`🚨 PERPS ORDER BOOK\n\nInstrument: ${instrumentId}\nBid liquidity: $${current.bidUsd.toFixed(0)}\nAsk liquidity: $${current.askUsd.toFixed(0)}\nImbalance: ${pct(current.imbalance)}\n\n${side}`);
  }

  const bidPull = previous.bidUsd > 0 ? (previous.bidUsd-current.bidUsd)/previous.bidUsd : 0;
  const askPull = previous.askUsd > 0 ? (previous.askUsd-current.askUsd)/previous.askUsd : 0;
  if (bidPull >= LIQUIDITY_PULL_THRESHOLD && canAlert(key(instrumentId,'bid-pull'))) {
    await telegram(`⚠️ LIQUIDITY PULL\n\nInstrument: ${instrumentId}\nSide: BID\nLiquidity: $${previous.bidUsd.toFixed(0)} → $${current.bidUsd.toFixed(0)}\nRemoved: ${pct(bidPull)}`);
  }
  if (askPull >= LIQUIDITY_PULL_THRESHOLD && canAlert(key(instrumentId,'ask-pull'))) {
    await telegram(`⚠️ LIQUIDITY PULL\n\nInstrument: ${instrumentId}\nSide: ASK\nLiquidity: $${previous.askUsd.toFixed(0)} → $${current.askUsd.toFixed(0)}\nRemoved: ${pct(askPull)}`);
  }

  for (const x of [...current.bids.map(x=>({...x,side:'BID'})), ...current.asks.map(x=>({...x,side:'ASK'}))]) {
    const usd = x.p*x.s;
    if (usd >= LARGE_ORDER_USD && canAlert(key(instrumentId,`large-${x.side}-${x.p}`))) {
      await telegram(`🐋 LARGE ORDER\n\nInstrument: ${instrumentId}\nSide: ${x.side}\nPrice: ${x.p}\nSize: ${x.s}\nNotional: $${usd.toFixed(0)}`);
    }
  }
}

async function main() {
  const instruments = await client.fetchPerpsInstruments({});
  const ids = instruments.items?.map(x => Number(x.instrumentId ?? x.id)).filter(Number.isFinite) ?? [];
  console.log(`Found ${ids.length} Perps instruments`);
  if (!ids.length) throw new Error('No Perps instruments returned');

  const specs = ids.flatMap(instrumentId => [
    { topic: 'perps.bbo', instrumentId },
    { topic: 'perps.book', instrumentId }
  ]);

  const stream = client.subscribe(specs);
  for await (const event of stream) {
    const id = Number(event.instrumentId ?? event.instrument_id);
    if (!Number.isFinite(id)) continue;
    if (event.topic === 'perps.bbo') {
      console.log('BBO', id, event);
      const s = state.get(id) ?? {};
      if (event.bestBid != null) s.bestBid = num(event.bestBid);
      if (event.bestAsk != null) s.bestAsk = num(event.bestAsk);
      state.set(id, s);
    } else if (event.topic === 'perps.book') {
      await handleBook(id, event);
    }
  }
}

main().catch(err => { console.error(err); process.exit(1); });
