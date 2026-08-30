const HL_WS_URL = 'wss://api.hyperliquid.xyz/ws';
const HL_ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const RECONNECT_MS = 3000;

// Hyperliquid does not expose a public global liquidation stream.
// This collector intentionally subscribes only to public trade data and
// NEVER converts ordinary trades into liquidation alerts.
// It is a diagnostic collector for validating the public feed before the
// production liquidation source is switched.

let ws = null;
let reconnectTimer = null;
let stopping = false;

function connect() {
  if (stopping) return;
  ws = new WebSocket(HL_WS_URL);

  ws.addEventListener('open', () => {
    console.log('[Hyperliquid] connected');
    for (const coin of HL_ASSETS) {
      ws.send(JSON.stringify({
        method: 'subscribe',
        subscription: { type: 'trades', coin }
      }));
    }
    console.log(`[Hyperliquid] subscribed trades: ${HL_ASSETS.join(', ')}`);
  });

  ws.addEventListener('message', event => {
    try {
      const message = JSON.parse(String(event.data));
      if (message?.channel !== 'trades') return;
      const trades = Array.isArray(message.data) ? message.data : [];
      for (const trade of trades) {
        // Diagnostic only. No Telegram alert and no liquidation classification.
        console.log('[Hyperliquid][TRADE]', JSON.stringify({
          coin: trade.coin,
          side: trade.side,
          px: trade.px,
          sz: trade.sz,
          time: trade.time,
          hash: trade.hash
        }));
      }
    } catch (error) {
      console.error('[Hyperliquid] parse error:', error?.message ?? error);
    }
  });

  ws.addEventListener('error', error => {
    console.error('[Hyperliquid] websocket error:', error?.message ?? error);
  });

  ws.addEventListener('close', () => {
    if (!stopping) reconnectTimer = setTimeout(connect, RECONNECT_MS);
  });
}

function shutdown() {
  stopping = true;
  clearTimeout(reconnectTimer);
  try { ws?.close(); } catch {}
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

connect();
