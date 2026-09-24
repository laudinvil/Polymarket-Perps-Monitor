const WS_URL = process.env.OPENMARKET_WS_URL || "wss://eu-de3.ws.api.openmarket.xyz/nonbook/ws?encoding=json";
const MIN_LIQUIDATION_USD = Number(process.env.MIN_LIQUIDATION_USD || "0");
const RECONNECT_MS = 3000;
const RUN_MS = 5 * 60 * 60 * 1000 + 50 * 60 * 1000;

// OpenMarket Free plan: keep client-initiated WebSocket traffic below 10 messages/min.
const WS_MESSAGE_LIMIT = 9;
const WS_WINDOW_MS = 60 * 1000;
const RAW_CONVEX_URL = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || null;
// Convex function API uses the .convex.cloud deployment URL. If the secret contains
// the previously used .convex.site URL, normalize it automatically.
const CONVEX_URL = RAW_CONVEX_URL
  ? RAW_CONVEX_URL.replace(/\\.convex\\.site\\/?$/, ".convex.cloud").replace(/\\/$/, "")
  : null;

async function convexMutation(path, args) {
  if (!CONVEX_URL) throw new Error("Missing CONVEX_URL");
  const res = await fetch(CONVEX_URL + "/api/mutation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path, args, format: "json" }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await res.text();
  if (!res.ok) throw new Error("Convex HTTP " + res.status + ": " + body);
  const json = JSON.parse(body);
  if (json.status !== "success") throw new Error("Convex mutation error: " + (json.errorMessage || body));
  return json.value;
}

function logPersistent(level, event, message, data) {
  console.log("PERSISTENT " + level + " " + event + " " + message);
  convexMutation("btc5mState:logOpenMarket", {
    level,
    event,
    message,
    data: data == null ? undefined : JSON.stringify(data)
  }).catch(err => console.error("Persistent log failed: " + err.message));
}

const SUBSCRIPTIONS = [
  { exchange: "BINANCE_FUTURES", symbol: "BTCUSDT" },
  { exchange: "BYBIT", symbol: "BTCUSDT" },
  { exchange: "OKEX_SWAP", symbol: "BTC-USDT-SWAP" },
  { exchange: "HYPERLIQUID_FUTURES", symbol: "BTC" },
  { exchange: "BITMEX", symbol: "XBTUSD" },
  { exchange: "BITGET", symbol: "BTCUSDT" },
  { exchange: "GATE_IO_FUTURES", symbol: "BTC_USDT" }
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatUsd(value) {
  return Number.isFinite(value)
    ? "$" + value.toLocaleString("en-US", { maximumFractionDigits: 0 })
    : "n/a";
}

function formatPrice(value) {
  return Number.isFinite(value)
    ? "$" + value.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "n/a";
}

async function telegramRequest(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const res = await fetch(
    "https://api.telegram.org/bot" + token + "/" + method,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000)
    }
  );

  const body = await res.text();
  if (!res.ok) throw new Error("Telegram HTTP " + res.status + ": " + body);

  const json = JSON.parse(body);
  if (!json.ok) throw new Error("Telegram API error: " + body);
  return json.result;
}

async function sendTelegram(liq) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("Missing TELEGRAM_CHAT_ID");

  const side = liq.side === "SELL"
    ? "LONG LIQUIDATED"
    : liq.side === "BUY"
      ? "SHORT LIQUIDATED"
      : liq.side;

  const usd = Number(liq.price) * Number(liq.amount);
  const time = new Date(
    Number(liq.timestampSeconds || Math.floor(Date.now() / 1000)) * 1000
  );

  const text = [
    "🔥 BTC · LIQUIDATION",
    "",
    "SIDE: " + side,
    "PRICE: " + formatPrice(Number(liq.price)),
    "SIZE: " + formatUsd(usd),
    "AMOUNT: " + Number(liq.amount).toFixed(6) + " BTC",
    "EXCHANGE: " + liq.exchange,
    "TIME: " + time.toISOString().replace("T", " ").replace(".000Z", " UTC")
  ].join("\n");

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: true
  });

  console.log(
    "ALERT SENT id=" + liq.id +
    " exchange=" + liq.exchange +
    " side=" + liq.side +
    " price=" + liq.price +
    " amount=" + liq.amount +
    " usd=" + usd.toFixed(2)
  );
}

function normalizePoint(point) {
  const series = point && point.series ? point.series : {};
  const liquidation = point && point.liquidation ? point.liquidation : {};

  const timestampSeconds = liquidation.timestamp && liquidation.timestamp.seconds != null
    ? Number(liquidation.timestamp.seconds)
    : Math.floor(Date.now() / 1000);

  return {
    id: String(liquidation.id || ""),
    exchange: String(series.exchange || ""),
    symbol: String(series.symbol || ""),
    side: String(series.side || ""),
    price: Number(liquidation.price),
    amount: Number(liquidation.amount),
    timestampSeconds
  };
}

function startMonitor() {
  const apiKey = process.env.OPENMARKET_API_KEY;
  if (!apiKey) throw new Error("Missing OPENMARKET_API_KEY");

  if (typeof WebSocket !== "function") {
    throw new Error("Node WebSocket API is unavailable");
  }

  const seen = new Set();
  const startedAt = Date.now();
  let stopping = false;
  const wsMessageTimes = [];
  let wsSendQueue = Promise.resolve();

  function sendWs(ws, payload) {
    wsSendQueue = wsSendQueue.then(async () => {
      const now = Date.now();
      while (wsMessageTimes.length && now - wsMessageTimes[0] >= WS_WINDOW_MS) {
        wsMessageTimes.shift();
      }

      if (wsMessageTimes.length >= WS_MESSAGE_LIMIT) {
        const waitMs = WS_WINDOW_MS - (now - wsMessageTimes[0]) + 50;
        console.log("OpenMarket WS rate guard: waiting " + waitMs + "ms");
        await sleep(waitMs);
      }

      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(payload));
      wsMessageTimes.push(Date.now());
    }).catch(err => {
      console.error("OpenMarket WS send queue error: " + err.stack);
    });

    return wsSendQueue;
  }

  async function connect() {
    if (stopping) return;

    await new Promise(resolve => {
      const ws = new WebSocket(WS_URL);
      let settled = false;
      let pingTimer = null;
      let subscribed = false;

      function finish() {
        if (settled) return;
        settled = true;
        if (pingTimer) clearInterval(pingTimer);
        try { ws.close(); } catch (_) {}
        resolve();
      }

      ws.addEventListener("open", () => {
        console.log("OpenMarket WebSocket connected: " + WS_URL);
        logPersistent("INFO", "ws_connected", "WebSocket connected", { url: WS_URL });

        sendWs(ws, {
          jsonrpc: "2.0",
          id: 1,
          method: "public/authenticate",
          params: { token: apiKey }
        });

        logPersistent("INFO", "auth_sent", "Authentication request sent");
        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            sendWs(ws, { type: "ping", timestamp: Date.now() });
          }
        }, 9000);
      });

      ws.addEventListener("message", event => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (err) {
          console.error("OpenMarket invalid JSON: " + err.message);
          return;
        }

        console.log("OpenMarket WS message type=" + String(message.method || message.result?.type || message.type || "unknown"));
        if (message.error) {
          console.error("OpenMarket WS error: " + JSON.stringify(message.error));
          logPersistent("ERROR", "ws_error", "OpenMarket WebSocket error", message.error);
          return;
        }

        if (message.id === 1 && message.result && !subscribed) {
          subscribed = true;
          logPersistent("INFO", "auth_ok", "Authentication accepted", message.result);
          const channels = SUBSCRIPTIONS.map(item => ({
            type: "LIQUIDATION",
            category: "PERPETUAL",
            exchange: item.exchange,
            symbol: item.symbol
          }));
          sendWs(ws, {
            jsonrpc: "2.0",
            id: 2,
            method: "public/subscribe",
            params: { channels, version: "v2" }
          });
          logPersistent("INFO", "subscribe_sent", "Liquidation subscriptions sent", { channels });
          return;
        }

        if (message.id === 2 || message.result?.channels || message.result?.subscriptions) {
          logPersistent("INFO", "subscribe_response", "Subscription response received", message.result || message);
        }

        const points = Array.isArray(message.points) ? message.points : [];
        for (const point of points) {
          if (!point.series || point.series.type !== "LIQUIDATION") continue;

          const liq = normalizePoint(point);
          if (!liq.id || !liq.exchange || !Number.isFinite(liq.price) ||
              !Number.isFinite(liq.amount) || liq.amount <= 0) {
            continue;
          }

          const key = liq.exchange + ":" + liq.id;
          if (seen.has(key)) continue;
          seen.add(key);

          if (seen.size > 5000) {
            const first = seen.values().next().value;
            seen.delete(first);
          }

          const usd = liq.price * liq.amount;

          logPersistent("INFO", "liquidation_received", "BTC liquidation received", liq);
          console.log(
            "LIQUIDATION exchange=" + liq.exchange +
            " symbol=" + liq.symbol +
            " side=" + liq.side +
            " price=" + liq.price +
            " amount=" + liq.amount +
            " usd=" + usd.toFixed(2) +
            " id=" + liq.id
          );

          if (usd < MIN_LIQUIDATION_USD) {
            console.log(
              "FILTERED below MIN_LIQUIDATION_USD=" +
              MIN_LIQUIDATION_USD.toFixed(2)
            );
            continue;
          }

          sendTelegram(liq).catch(err => {
            console.error("Telegram alert failed: " + err.stack);
          });
        }
      });

      ws.addEventListener("error", event => {
        logPersistent("ERROR", "ws_error_event", "WebSocket error event", { message: String(event && event.message || "unknown") });
        console.error(
          "OpenMarket WebSocket error: " +
          String(event && event.message || "unknown")
        );
      });

      ws.addEventListener("close", event => {
        logPersistent("WARN", "ws_closed", "WebSocket closed", { code: event.code, reason: String(event.reason || "") });
        console.log(
          "OpenMarket WebSocket closed code=" +
          event.code +
          " reason=" +
          String(event.reason || "")
        );
        finish();
      });
    });

    if (!stopping) {
      console.log("Reconnecting OpenMarket WebSocket in " + RECONNECT_MS + "ms");
      await sleep(RECONNECT_MS);
    }
  }

  (async () => {
    while (!stopping && Date.now() - startedAt < RUN_MS) {
      try {
        await connect();
      } catch (err) {
        console.error("Monitor connection error: " + err.stack);
        await sleep(RECONNECT_MS);
      }
    }

    stopping = true;
    console.log("OpenMarket BTC liquidation monitor stopping cleanly");
  })();
}

console.log("OpenMarket BTC liquidation monitor started");
logPersistent("INFO", "monitor_started", "BTC liquidation monitor started", { subscriptions: SUBSCRIPTIONS });
console.log("OpenMarket WS client rate guard: " + WS_MESSAGE_LIMIT + " messages/min; heartbeat: 9s");
console.log("Minimum liquidation USD: " + MIN_LIQUIDATION_USD);
console.log("Subscriptions: " + SUBSCRIPTIONS.map(x => x.exchange + ":" + x.symbol).join(", "));
startMonitor();
