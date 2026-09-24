const WS_URL = process.env.OPENMARKET_WS_URL || "wss://eu-de3.ws.api.openmarket.xyz/nonbook/ws?encoding=json";
const API_KEY = process.env.OPENMARKET_API_KEY || "";
const RUN_MS = 5 * 60 * 1000;

if (!API_KEY) throw new Error("Missing OPENMARKET_API_KEY");
if (typeof WebSocket !== "function") throw new Error("Node WebSocket API is unavailable");

const startedAt = Date.now();
let stopping = false;

function raw(label, data) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    label,
    data
  }));
}

const ws = new WebSocket(WS_URL);

ws.addEventListener("open", () => {
  raw("OPEN", { url: WS_URL });

  const auth = {
    jsonrpc: "2.0",
    id: 1,
    method: "public/authenticate",
    params: { token: API_KEY }
  };

  raw("SEND_AUTH", { ...auth, params: { token: "[REDACTED]" } });
  ws.send(JSON.stringify(auth));

  const subscribe = {
    jsonrpc: "2.0",
    id: 2,
    method: "public/subscribe",
    params: {
      channels: [{
        type: "LIQUIDATION",
        category: "PERPETUAL",
        exchange: "HYPERLIQUID_FUTURES",
        symbol: "BTC"
      }],
      version: "v2"
    }
  };

  raw("SEND_SUBSCRIBE", subscribe);
  ws.send(JSON.stringify(subscribe));
});

ws.addEventListener("message", event => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    raw("MESSAGE_NON_JSON", String(event.data));
    return;
  }

  raw("MESSAGE", message);

  if (Array.isArray(message.points)) {
    for (const point of message.points) {
      if (point?.series?.exchange === "HYPERLIQUID_FUTURES" &&
          point?.series?.symbol === "BTC" &&
          point?.series?.type === "LIQUIDATION") {
        raw("HYPERLIQUID_BTC_LIQUIDATION", point);
      }
    }
  }
});

ws.addEventListener("error", event => {
  raw("ERROR", {
    message: String(event?.message || "unknown")
  });
});

ws.addEventListener("close", event => {
  raw("CLOSE", {
    code: event.code,
    reason: String(event.reason || "")
  });
});

setTimeout(() => {
  stopping = true;
  raw("STOP", { runtimeMs: Date.now() - startedAt });
  try { ws.close(); } catch (_) {}
}, RUN_MS);
