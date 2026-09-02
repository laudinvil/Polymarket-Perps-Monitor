const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'DOGEUSDT', 'HYPEUSDT', 'BNBUSDT'];
const COIN_BY_SYMBOL = Object.fromEntries(SYMBOLS.map(symbol => [symbol, symbol.replace('USDT', '')]));
const STREAM_URL = `wss://fstream.binance.com/stream?streams=${SYMBOLS.map(s => `${s.toLowerCase()}@forceOrder`).join('/')}`;
const MAX_EVENTS = 20000;
const events = [];
let socket = null;
let reconnectTimer = null;
let stopped = false;

export function startBinanceLiquidationStream() {
  if (socket || stopped) return;
  connect();
}

function connect() {
  if (stopped) return;
  try {
    socket = new WebSocket(STREAM_URL);
    socket.addEventListener('open', () => console.log('[BINANCE][WS] connected'));
    socket.addEventListener('message', event => {
      try {
        const message = JSON.parse(String(event.data));
        const order = message?.data?.o;
        if (message?.data?.e !== 'forceOrder' || !order) return;
        const symbol = String(order.s || '').toUpperCase();
        const coin = COIN_BY_SYMBOL[symbol];
        const timestamp = Number(order.T || message?.data?.E);
        const qty = Number(order.z || order.q);
        const avgPrice = Number(order.ap || order.p);
        if (!coin || !Number.isFinite(timestamp) || !Number.isFinite(qty) || !Number.isFinite(avgPrice)) return;
        const side = String(order.S || '').toUpperCase() === 'SELL' ? 'LONG' : 'SHORT';
        events.push({ coin, side, timestamp, notional: Math.abs(qty * avgPrice) });
        if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
      } catch (error) {
        console.error('[BINANCE][WS] message parse error:', error?.message ?? error);
      }
    });
    socket.addEventListener('error', error => console.error('[BINANCE][WS] error:', error?.message ?? error));
    socket.addEventListener('close', () => {
      console.log('[BINANCE][WS] disconnected; reconnecting in 5000ms');
      socket = null;
      if (!stopped) {
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 5000);
      }
    });
  } catch (error) {
    console.error('[BINANCE][WS] connection error:', error?.message ?? error);
    socket = null;
    reconnectTimer = setTimeout(connect, 5000);
  }
}

export function getBinanceLiquidationStats(startMs, endMs) {
  const stats = Object.fromEntries(Object.values(COIN_BY_SYMBOL).map(coin => [coin, { events: 0, longVolume: 0, shortVolume: 0, totalVolume: 0 }]));
  for (const event of events) {
    if (event.timestamp < startMs || event.timestamp >= endMs) continue;
    const item = stats[event.coin];
    if (!item) continue;
    item.events += 1;
    item.totalVolume += event.notional;
    if (event.side === 'LONG') item.longVolume += event.notional;
    else item.shortVolume += event.notional;
  }
  return stats;
}

export function stopBinanceLiquidationStream() {
  stopped = true;
  clearTimeout(reconnectTimer);
  if (socket) {
    try { socket.close(); } catch {}
  }
  socket = null;
}
