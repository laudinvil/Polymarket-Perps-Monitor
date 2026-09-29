const EventEmitter = require("events");
const WebSocket = require("ws");

const WS_URL = "wss://rpc.hyperliquid.xyz/ws";
const SYMBOLS = new Set(["BTC","ETH","SOL","XRP","DOGE","BNB","HYPE"]);
const RECONNECT_MS = 3000;
const HEARTBEAT_MS = 30000;

class HyperliquidLiquidationAdapter extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.stopped = false;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.connected = false;
    this.lastEventAt = null;
    this.errors = 0;
    this.dedupe = new Set();
  }

  start() {
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.heartbeatTimer);
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
  }

  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.emit("connected");
      this.send({ method: "subscribe", subscription: { type: "explorerTxs" } });
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = setInterval(() => {
        if (this.ws === ws && ws.readyState === WebSocket.OPEN) {
          try { ws.send(JSON.stringify({ method: "ping" })); } catch {}
        }
      }, HEARTBEAT_MS);
    });

    ws.on("message", raw => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(raw.toString());
        if (msg && msg.channel === "subscriptionResponse") return;
        this.scan(msg);
      } catch {
        this.errors++;
      }
    });

    ws.on("error", () => {
      this.errors++;
    });

    ws.on("close", () => {
      if (this.ws !== ws) return;
      this.connected = false;
      clearInterval(this.heartbeatTimer);
      this.emit("disconnected");
      if (!this.stopped) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_MS);
      }
    });
  }

  send(value) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(value));
    }
  }

  scan(value) {
    const hits = [];
    const walk = (node, path = []) => {
      if (!node || typeof node !== "object") return;

      if (Array.isArray(node)) {
        for (const item of node) walk(item, path);
        return;
      }

      if (node.liquidation && typeof node.liquidation === "object") {
        const base = { ...node, ...node.liquidation };
        const coin = String(base.coin || "").toUpperCase();
        if (SYMBOLS.has(coin)) hits.push(base);
      }

      if (node.type === "liquidation" && Array.isArray(node.liquidatedPositions)) {
        for (const position of node.liquidatedPositions) {
          const coin = String(position.coin || "").toUpperCase();
          if (SYMBOLS.has(coin)) {
            hits.push({
              ...node,
              ...position,
              coin,
              liquidatedNtlPos: node.liquidatedNtlPos
            });
          }
        }
      }

      for (const [key, child] of Object.entries(node)) {
        if (key === "liquidation" || key === "liquidatedPositions") continue;
        walk(child, path.concat(key));
      }
    };

    walk(value);

    for (const hit of hits) {
      const event = this.normalize(hit, value);
      if (!event) continue;
      const key = event.id;
      if (this.dedupe.has(key)) continue;
      this.dedupe.add(key);
      if (this.dedupe.size > 10000) {
        const first = this.dedupe.values().next().value;
        this.dedupe.delete(first);
      }
      this.lastEventAt = new Date(event.timestamp).toISOString();
      this.emit("liquidations", event);
    }
  }

  normalize(hit, raw) {
    const coin = String(hit.coin || "").toUpperCase();
    if (!SYMBOLS.has(coin)) return null;

    const px = Number(hit.px ?? hit.markPx ?? hit.mark_px);
    const sz = Math.abs(Number(hit.sz ?? hit.szi));
    const ntl = Math.abs(Number(
      hit.liquidatedNtlPos ??
      hit.liquidated_ntl_pos ??
      hit.notional ??
      hit.liquidatedNtl
    ));

    let price = Number.isFinite(px) && px > 0 ? px : null;
    let size = Number.isFinite(sz) && sz > 0 ? sz : null;

    if ((!price || !size) && Number.isFinite(ntl) && ntl > 0) {
      if (size) price = ntl / size;
      else if (price) size = ntl / price;
    }

    if (!price || !size || price <= 0 || size <= 0) return null;

    const hash = String(hit.hash || hit.txHash || raw?.hash || "");
    const lid = String(hit.lid || "");
    const tid = String(hit.tid || hit.oid || "");
    const id = hash + ":" + coin + ":" + (lid || tid || price + ":" + size);

    return {
      id,
      timestamp: Number(hit.time || hit.timestamp || Date.now()),
      exchange: "HYPERLIQUID",
      pair: coin + "-USDC-PERP",
      symbol: coin,
      side: String(hit.side || "").toLowerCase(),
      price,
      size,
      liquidation: true
    };
  }
}

module.exports = HyperliquidLiquidationAdapter;
