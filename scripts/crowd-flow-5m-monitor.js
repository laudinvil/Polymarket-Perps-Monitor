const WebSocket = globalThis.WebSocket;
const { bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

if (!WebSocket) throw new Error('WebSocket unavailable');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const PERIOD = 300000;
const WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const markets = new Map();
const tokens = new Map();
const seen = new Set();
const alertedLinks = new Set();
const completed = new Map();
let socket;

const start = () => bucketStart(Date.now(), '5m');
const key = (symbol, period) => `${symbol}:${period}`;
const price = n => Number(n).toFixed(3);

async function checkBoundary(currentStart) {
  const justFinishedStart = currentStart - PERIOD;

  const candidates = [];
  for (const symbol of SYMBOLS) {
    const justFinished = completed.get(key(symbol, justFinishedStart));
    if (!justFinished || justFinished.alertChecked) continue;

    justFinished.alertChecked = true;
    candidates.push({ symbol, justFinished });
  }

  if (!candidates.length) return;

  // One alert per completed period: select the coin with the minimum trade count.
  candidates.sort((a, b) => a.justFinished.trades - b.justFinished.trades || a.symbol.localeCompare(b.symbol));
  const winner = candidates[0];
  const { symbol, justFinished } = winner;

  const current = markets.get(key(symbol, currentStart));
  const currentUrl = current?.market?.url || `https://polymarket.com/event/${symbol.toLowerCase()}-updown-5m-${Math.floor(currentStart / 1000)}`;

  if (alertedLinks.has(currentUrl)) {
    console.log(`[crowd-flow] duplicate link suppressed symbol=${symbol} current=${currentUrl}`);
    return;
  }

  alertedLinks.add(currentUrl);

  const upPrice = justFinished.lu === null ? 'n/a' : price(justFinished.lu);
  const downPrice = justFinished.ld === null ? 'n/a' : price(justFinished.ld);

  await sendTelegramMessage([
    `🔥 ${symbol} · 5M TRADE FLOW`,
    `TRADES: ${justFinished.trades}`,
    `PRICE UP: ${upPrice}`,
    `PRICE DOWN: ${downPrice}`,
    '',
    '➡️ CURRENT · Polymarket 5M',
    currentUrl
  ].join('\n'));

  console.log(`[crowd-flow] ALERT ${symbol} trades=${justFinished.trades} priceUp=${upPrice} priceDown=${downPrice} boundary=${currentStart}`);
}

async function refresh() {
  const t = start();

  for (const symbol of SYMBOLS) {
    const market = await findMarketByEpoch(symbol, t, '5m');
    if (!market?.tokenIds?.UP || !market?.tokenIds?.DOWN) {
      console.log(`[crowd-flow] ${symbol} market unavailable period=${t}`);
      continue;
    }

    const k = key(symbol, t);
    if (!markets.has(k)) {
      markets.set(k, {
        symbol,
        start: t,
        market,
        up: 0,
        down: 0,
        trades: 0,
        lu: null,
        ld: null
      });
    }

    tokens.set(market.tokenIds.UP, { k, o: 'UP' });
    tokens.set(market.tokenIds.DOWN, { k, o: 'DOWN' });

    const previousStart = t - PERIOD;
    const previous = markets.get(key(symbol, previousStart));
    if (previous && !completed.has(key(symbol, previousStart))) {
      completed.set(key(symbol, previousStart), { ...previous });
    }
  }

  await checkBoundary(t);

  for (const [k, v] of markets) {
    if (v.start < t - PERIOD) markets.delete(k);
  }

  for (const [k, v] of completed) {
    if (v.start < t - PERIOD * 4) completed.delete(k);
  }

  if (socket?.readyState === WebSocket.OPEN) {
    const ids = [...tokens]
      .filter(([, v]) => markets.get(v.k)?.start === t)
      .map(([id]) => id);

    if (ids.length) {
      socket.send(JSON.stringify({ assets_ids: ids, type: 'market' }));
      console.log(`[crowd-flow] subscribed tokens=${ids.length} symbols=${SYMBOLS.length} period=${t}`);
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
  const n = p * q;
  if (!Number.isFinite(n) || n <= 0) return;

  v.trades += 1;
  if (m.o === 'UP') {
    v.up += n;
    v.lu = p;
  } else {
    v.down += n;
    v.ld = p;
  }
}

function diagnostics() {
  const t = start();
  const rows = [];
  for (const symbol of SYMBOLS) {
    const v = markets.get(key(symbol, t));
    if (v) rows.push(`${symbol}=${v.trades}`);
  }
  console.log(`[crowd-flow] DIAG ${rows.join(' ')}`);
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
  console.log('[crowd-flow] start', SYMBOLS.join(','));
  await refresh();
  connect();
  setInterval(() => refresh().catch(e => console.error('[crowd-flow]', e.message)), 30000);
  setInterval(diagnostics, 60000);
})();
