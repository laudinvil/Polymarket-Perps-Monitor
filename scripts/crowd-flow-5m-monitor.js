const WebSocket = globalThis.WebSocket;
const { bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

if (!WebSocket) throw new Error('WebSocket unavailable');

const SYMBOLS = ['BTC', 'ETH', 'XRP', 'SOL', 'BNB', 'HYPE', 'DOGE'];
const PERIOD = 300000;
const WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const MIN_TRADES = 900;

const markets = new Map();
const tokens = new Map();
const seen = new Set();
const alertedLinks = new Set();
let socket;

const start = () => bucketStart(Date.now(), '5m');
const key = (symbol, period) => `${symbol}:${period}`;
const price = n => Number(n).toFixed(3);

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
        ld: null,
        alerted: false
      });
    }

    tokens.set(market.tokenIds.UP, { k, o: 'UP' });
    tokens.set(market.tokenIds.DOWN, { k, o: 'DOWN' });
  }

  for (const [k, v] of markets) {
    if (v.start !== t) markets.delete(k);
  }

  if (socket?.readyState === WebSocket.OPEN) {
    const ids = [...tokens]
      .filter(([, v]) => markets.get(v.k)?.start === t)
      .map(([id]) => id);

    if (ids.length) {
      socket.send(JSON.stringify({ assets_ids: ids, type: 'market' }));
      console.log(`[crowd-flow] subscribed tokens=${ids.length} period=${t}`);
    }
  }
}

function signal(v) {
  if (v.trades < MIN_TRADES) return null;

  const o = v.up >= v.down ? 'UP' : 'DOWN';
  return { o };
}

async function alert(v) {
  if (v.alerted) return;

  const s = signal(v);
  if (!s) return;

  const next = await findMarketByEpoch(v.symbol, v.start + PERIOD, '5m');
  const nextUrl = next?.url || `https://polymarket.com/event/${v.symbol.toLowerCase()}-updown-5m-${Math.floor((v.start + PERIOD) / 1000)}`;

  if (alertedLinks.has(nextUrl)) {
    console.log(`[crowd-flow] duplicate link suppressed symbol=${v.symbol} next=${nextUrl}`);
    v.alerted = true;
    return;
  }

  v.alerted = true;
  alertedLinks.add(nextUrl);

  const upPrice = v.lu === null ? null : price(v.lu);
  const downPrice = v.ld === null ? null : price(v.ld);
  const upAttention = upPrice !== null && (downPrice === null || Number(v.lu) > Number(v.ld)) ? ' ⚠️' : '';
  const downAttention = downPrice !== null && (upPrice === null || Number(v.ld) > Number(v.lu)) ? ' ⚠️' : '';

  await sendTelegramMessage([
    `🔥 ${v.symbol} · 5M`,
    `TRADES: ${v.trades}`,
    `PRICE UP: ${upPrice === null ? 'n/a' : upPrice}${upAttention}`,
    `PRICE DOWN: ${downPrice === null ? 'n/a' : downPrice}${downAttention}`,
    '',
    `➡️ NEXT · Polymarket 5M`,
    nextUrl
  ].join('\n'));
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

  alert(v).catch(e => console.error('[crowd-flow] alert', e.message));
}

function diagnostics() {
  const t = start();
  for (const symbol of SYMBOLS) {
    const v = markets.get(key(symbol, t));
    if (!v) continue;

    const total = v.up + v.down;
    const o = v.up >= v.down ? 'UP' : 'DOWN';
    const reason = v.alerted ? 'alerted' : 'WAITING';

    console.log(
      `[crowd-flow] DIAG ${symbol} UP=${Math.round(v.up)} DOWN=${Math.round(v.down)} TOTAL=${Math.round(total)} TRADES=${v.trades} PRICE_UP=${v.lu === null ? 'n/a' : price(v.lu)} PRICE_DOWN=${v.ld === null ? 'n/a' : price(v.ld)} DIRECTION=${o} REASON=${reason}`
    );
  }
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