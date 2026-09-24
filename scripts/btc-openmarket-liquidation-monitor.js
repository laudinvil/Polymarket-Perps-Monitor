const WebSocket = globalThis.WebSocket;
const CONVEX_URL = process.env.CONVEX_URL || null;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const RUN_MS = 5 * 60 * 60 * 1000;
const RECONNECT_MS = 5000;
const seen = new Set();
let stopping = false;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function convexMutation(path, args) {
  if (!CONVEX_URL) return;
  const url = CONVEX_URL.replace(/\/$/, "");
  try {
    const response = await fetch(url + "/api/mutation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path, args, format: "json" }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error("HTTP " + response.status);
  } catch (err) {
    console.error("Convex logging failed: " + err.message);
  }
}

function log(level, event, message, data) {
  const payload = {
    level, event, message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) })
  };
  console.log(JSON.stringify(payload));
  convexMutation("btc5mState:logOpenMarket", payload).catch(() => {});
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const response = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error("Telegram HTTP " + response.status);
}

function dedupeKey(liq) {
  return [
    liq.exchange, liq.time, liq.side,
    liq.price, liq.amount
  ].join(":");
}

function processLiquidation(liq) {
  if (!Number.isFinite(liq.price) || !Number.isFinite(liq.amount) || liq.amount <= 0) return;

  const key = dedupeKey(liq);
  if (seen.has(key)) return;
  seen.add(key);
  if (seen.size > 10000) {
    seen.delete(seen.values().next().value);
  }

  const usd = liq.price * liq.amount;
  const sideText = liq.side === "LONG" ? "LONG LIQUIDATED" : "SHORT LIQUIDATED";

  log("INFO", "liquidation_received", "BTC liquidation received", {
    exchange: liq.exchange,
    side: liq.side,
    price: liq.price,
    amount: liq.amount,
    usd,
    time: liq.time
  });

  const text = [
    "🔥 BTC · LIQUIDATION",
    "",
    "SIDE: " + sideText,
    "PRICE: $" + liq.price.toLocaleString("en-US", { maximumFractionDigits: 2 }),
    "SIZE: $" + usd.toLocaleString("en-US", { maximumFractionDigits: 2 }),
    "AMOUNT: " + liq.amount.toFixed(6) + " BTC",
    "EXCHANGE: " + liq.exchange,
    "TIME: " + new Date(liq.time).toISOString().replace("T", " ").replace(".000Z", " UTC")
  ].join("\n");

  sendTelegram(text).catch(err => log("ERROR", "telegram_error", "Telegram alert failed", { message: err.message }));
}

function connectBinance() {
  const url = "wss://fstream.binance.com/ws/btcusdt@forceOrder";
  log("INFO", "source_connect", "Connecting Binance liquidation stream", { url });
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    log("INFO", "source_connected", "Binance liquidation stream connected");
  });

  ws.addEventListener("message", event => {
    try {
      const m = JSON.parse(event.data);
      if (m.e !== "forceOrder" || !m.o) return;
      const o = m.o;
      processLiquidation({
        exchange: "BINANCE",
        side: o.S === "SELL" ? "LONG" : "SHORT",
        price: Number(o.ap || o.p),
        amount: Number(o.z || o.q),
        time: Number(o.T || m.E)
      });
    } catch (err) {
      log("ERROR", "binance_parse_error", "Failed to parse Binance liquidation", { message: err.message });
    }
  });

  ws.addEventListener("error", () => {
    log("ERROR", "source_error", "Binance WebSocket error");
  });

  ws.addEventListener("close", event => {
    log("WARN", "source_closed", "Binance liquidation stream closed", {
      code: event.code,
      reason: String(event.reason || "")
    });
    if (!stopping) setTimeout(connectBinance, RECONNECT_MS);
  });
}

function connectBybit() {
  const url = "wss://stream.bybit.com/v5/public/linear";
  log("INFO", "source_connect", "Connecting Bybit liquidation stream", { url });
  const ws = new WebSocket(url);
  let pingTimer;

  ws.addEventListener("open", () => {
    log("INFO", "source_connected", "Bybit liquidation stream connected");
    ws.send(JSON.stringify({
      op: "subscribe",
      args: ["allLiquidation.BTCUSDT"]
    }));
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: "ping" }));
    }, 20000);
  });

  ws.addEventListener("message", event => {
    try {
      const m = JSON.parse(event.data);
      if (m.op === "subscribe" || m.op === "pong") return;
      if (m.topic !== "allLiquidation.BTCUSDT" || !Array.isArray(m.data)) return;

      for (const o of m.data) {
        processLiquidation({
          exchange: "BYBIT",
          side: o.S === "Buy" ? "LONG" : "SHORT",
          price: Number(o.p),
          amount: Number(o.v),
          time: Number(o.T || m.ts)
        });
      }
    } catch (err) {
      log("ERROR", "bybit_parse_error", "Failed to parse Bybit liquidation", { message: err.message });
    }
  });

  ws.addEventListener("error", () => {
    log("ERROR", "source_error", "Bybit WebSocket error");
  });

  ws.addEventListener("close", event => {
    clearInterval(pingTimer);
    log("WARN", "source_closed", "Bybit liquidation stream closed", {
      code: event.code,
      reason: String(event.reason || "")
    });
    if (!stopping) setTimeout(connectBybit, RECONNECT_MS);
  });
}

console.log("BTC liquidation monitor started");
log("INFO", "monitor_started", "BTC liquidation monitor started", {
  sources: ["BINANCE", "BYBIT"],
  method: "direct_public_websockets",
  minLiquidationUsd: 0
});

connectBinance();
connectBybit();

setTimeout(() => {
  stopping = true;
  log("INFO", "monitor_stopped", "BTC liquidation monitor stopped");
}, RUN_MS);

process.on("SIGTERM", () => {
  stopping = true;
  process.exit(0);
});
