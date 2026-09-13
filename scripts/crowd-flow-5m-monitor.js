const WebSocket = globalThis.WebSocket;
const { bucketStart, findMarketByEpoch } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

if (!WebSocket) throw new Error('WebSocket unavailable');

const SYMBOLS = ['BTC'];
const PERIOD = 300000;
const WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

const markets = new Map();
const tokens = new Map();
const seen = new Set();
const periodAlerts = new Set();
const alertedLinks = new Set();
let socket;

const start = () => bucketStart(Date.now(), '5m');
const key = (symbol, period) => `${symbol}:${period}`;
const money = n => `$${Math.round(n).toLocaleString('en-US')}`;
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
        fu: null,
        fd: null,
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

  for (const p of periodAlerts) {
    if (p !== String(t)) periodAlerts.delete(p);
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

async function alert(v) {
  if (v.alerted || periodAlerts.has(String(v.start))) return;

  const total = v.up + v.down;
  if (total <= 0) return;

  const o = v.up >= v.down ? 'UP' : 'DOWN';
  const fp = o === 'UP' ? v.fu : v.fd;
  const lp = o === 'UP' ? v.lu : v.ld;

  const next = await findMarketByEpoch(v.symbol, v.start + PERIOD, '5m');
  const nextUrl = next?.url || `https://polymarket.com/event/${v.symbol.toLowerCase()}-updown-5m-${Math.floor((v.start + PERIOD) / 1000)}`;

  if (alertedLinks.has(nextUrl)) {
    console.log(`[crowd-flow] duplicate next link suppressed symbol=${v.symbol} next=${nextUrl}`);
    v.alerted = true;
    periodAlerts.add(String(v.start));
    return;
  }

  v.alerted = true;
  periodAlerts.add(String(v.start));
  alertedLinks.add(nextUrl);

  const buy = o === 'UP' ? 'DOWN' : 'UP';

  await sendTelegramMessage([
    `🔥 ${v.symbol} · 5M CROWD FLOW`,
    `FLOW: ${Math.round((Math.max(v.up, v.down) / total) * 100)}% → ${o}`,
    `UP: ${money(v.up)}`,
    `DOWN: ${money(v.down)}`,
    `PRICE: ${price(fp)} → ${price(lp)}`,
    `BUY ${buy}`,
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

  if (m.o === 'UP') {
    v.up += n;
    if (v.fu === null) v.fu = p;
    v.lu = p;
  } else {
    v.down += n;
    if (v.fd === null) v.fd = p;
    v.ld = p;
  }

  alert(v).catch(e => console.error('[crowd-flow] alert', e.message));
}

function diagnostics() {
  const t = start();
  const v = markets.get(key('BTC', t));
  if (!v) {
    console.log(`[crowd-flow] DIAG BTC no market period=${t}`);
    return;
  }

  const total = v.up + v.down;
  const o = v.up >= v.down ? 'UP' : 'DOWN';
  const share = total ? Math.max(v.up, v.down) / total : 0;
  const fp = o === 'UP' ? v.fu : v.fd;
  const lp = o === 'UP' ? v.lu : v.ld;

  console.log(
    `[crowd-flow] DIAG BTC UP=${money(v.up)} DOWN=${money(v.down)} TOTAL=${money(total)} FLOW=${Math.round(share * 100)}% PRICE=${fp === null ? 'n/a' : price(fp)}->${lp === null ? 'n/a' : price(lp)} REASON=${periodAlerts.has(String(t)) ? 'period-alerted' : 'READY'}`
  );
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
