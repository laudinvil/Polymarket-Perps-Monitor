const WS_URL = process.env.OPENMARKET_WS_URL || "wss://eu-de3.ws.api.openmarket.xyz/nonbook/ws?encoding=json";
const MIN_LIQUIDATION_USD = Number(process.env.MIN_LIQUIDATION_USD || "0");
const RECONNECT_MS = 3000;
const WS_CONNECT_TIMEOUT_MS = 15000;
const WS_AUTH_TIMEOUT_MS = 15000;
const WS_SUBSCRIBE_TIMEOUT_MS = 15000;
const RUN_MS = 5 * 60 * 60 * 1000 + 50 * 60 * 1000;

// OpenMarket Free plan: keep client-initiated WebSocket traffic below 10 messages/min.
const WS_MESSAGE_LIMIT = 9;
const WS_WINDOW_MS = 60 * 1000;
const RAW_CONVEX_URL = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || null;
const CONVEX_URL = RAW_CONVEX_URL
  ? RAW_CONVEX_URL.replace(/\.convex\.site\/?$/, ".convex.cloud").replace(/\/$/, "")
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

  console.log("ALERT SENT id=" + liq.id + " exchange=" + liq.exchange + " side=" + liq.side + " price=" + liq.price + " amount=" + liq.amount + " usd=" + usd.toFixed(2));
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
  if (typeof WebSocket !== "function") throw new Error("Node WebSocket API is unavailable");

  const seen = new Set();
  const startedAt = Date.now();
  let stopping = false;
  const wsMessageTimes = [];
  let wsSendQueue = Promise.resolve();

  function sendWs(ws, payload) {
    wsSendQueue = wsSendQueue.then(async () => {
      const now = Date.now();
      while (wsMessageTimes.length && now - wsMessageTimes[0] >= WS_WINDOW_MS) wsMessageTimes.shift();

      if (wsMessageTimes.length >= WS_MESSAGE_LIMIT) {
        const waitMs = WS_WINDOW_MS - (now - wsMessageTimes[0]) + 50;
        console.log("OpenMarket WS rate guard: waiting " + waitMs + "ms");
        await sleep(waitMs);
      }

      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(payload));
      wsMessageTimes.push(Date.now());
    }).catch(err => console.error("OpenMarket WS send queue error: " + err.stack));

    return wsSendQueue;
  }

  async function connect() {
    if (stopping) return;

    await new Promise(resolve => {
      console.log("OpenMarket: about to create WebSocket");
      convexMutation("btc5mState:logOpenMarket", { level: "INFO", event: "ws_connect_attempt", message: "Opening WebSocket connection", data: JSON.stringify({ url: WS_URL }) })
        .catch(err => console.error("Connect-attempt persistent log failed: " + err.message))
        .finally(() => createSocket(resolve));
    });

    function createSocket(resolve) {
      let ws;
      try {
        ws = new WebSocket(WS_URL);
      } catch (err) {
        console.error("OpenMarket WebSocket constructor failed: " + err.stack);\n        logPersistent("ERROR", "ws_constructor_error", "WebSocket constructor failed", { message: err.message, stack: err.stack });
        resolve();
        return;
      }

      let settled = false;
      let pingTimer = null;
      let subscribed = false;
      let opened = false;
      let authTimer = null;
      let subscribeTimer = null;

      const connectTimer = setTimeout(() => {
        if (!opened) {
          logPersistent("ERROR", "ws_connect_timeout", "WebSocket did not open within timeout", { timeoutMs: WS_CONNECT_TIMEOUT_MS });
          try { ws.close(); } catch (_) {}
        }
      }, WS_CONNECT_TIMEOUT_MS);

      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (authTimer) clearTimeout(authTimer);
        if (subscribeTimer) clearTimeout(subscribeTimer);
        if (pingTimer) clearInterval(pingTimer);
        try { ws.close(); } catch (_) {}
        resolve();
      }

      ws.addEventListener("open", () => {
        opened = true;
        console.log("OpenMarket WebSocket connected: " + WS_URL);
        logPersistent("INFO", "ws_connected", "WebSocket connected", { url: WS_URL });

        sendWs(ws, {
          method: "public/authenticate",
          params: { token: apiKey }
        });

        logPersistent("INFO", "auth_sent", "Authentication request sent");

        authTimer = setTimeout(() => {
          if (!subscribed) {
            logPersistent("ERROR", "auth_timeout", "No authentication response within timeout", { timeoutMs: WS_AUTH_TIMEOUT_MS });
            try { ws.close(); } catch (_) {}
          }
        }, WS_AUTH_TIMEOUT_MS);

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
          logPersistent("ERROR", "invalid_json", "OpenMarket sent invalid JSON", { message: String(event.data).slice(0, 500) });
          return;
        }

        console.log("OpenMarket WS message: " + JSON.stringify(message).slice(0, 2000));

        if (message.error) {
          console.error("OpenMarket WS error: " + JSON.stringify(message.error));
          logPersistent("ERROR", "ws_error", "OpenMarket WebSocket error", message.error);
          return;
        }

        if (message.result && !subscribed && !message.points) {
          subscribed = true;
          if (authTimer) clearTimeout(authTimer);

          logPersistent("INFO", "auth_ok", "Authentication accepted", message.result);

          const channels = SUBSCRIPTIONS.map(item => ({
            type: "LIQUIDATION",
            category: "PERPETUAL",
            exchange: item.exchange,
            symbol: item.symbol
          }));

          sendWs(ws, {
            jsonrpc: "2.0",
            id: 0,
            method: "public/subscribe",
            params: {
              channels,
              version: "v2"
            }
          });

          logPersistent("INFO", "subscribe_sent", "Liquidation subscriptions sent", { channels });

          subscribeTimer = setTimeout(() => {
            logPersistent("ERROR", "subscribe_timeout", "No subscription response within timeout", { timeoutMs: WS_SUBSCRIBE_TIMEOUT_MS });
          }, WS_SUBSCRIBE_TIMEOUT_MS);
          return;
        }

        if (message.id === 0 || message.result?.channels || message.result?.subscriptions) {
          if (subscribeTimer) clearTimeout(subscribeTimer);
          logPersistent("INFO", "subscribe_response", "Subscription response received", message.result || message);
        }

        const points = Array.isArray(message.points) ? message.points : [];
        for (const point of points) {
          if (!point.series || point.series.type !== "LIQUIDATION") continue;

          const liq = normalizePoint(point);
          if (!liq.id || !liq.exchange || !Number.isFinite(liq.price) || !Number.isFinite(liq.amount) || liq.amount <= 0) continue;

          const key = liq.exchange + ":" + liq.id;
          if (seen.has(key)) continue;
          seen.add(key);

          if (seen.size > 5000) {
            const first = seen.values().next().value;
            seen.delete(first);
          }

          const usd = liq.price * liq.amount;
          logPersistent("INFO", "liquidation_received", "BTC liquidation received", liq);

          console.log("LIQUIDATION exchange=" + liq.exchange + " symbol=" + liq.symbol + " side=" + liq.side + " price=" + liq.price + " amount=" + liq.amount + " usd=" + usd.toFixed(2) + " id=" + liq.id);

          if (usd < MIN_LIQUIDATION_USD) {
            console.log("FILTERED below MIN_LIQUIDATION_USD=" + MIN_LIQUIDATION_USD.toFixed(2));
            continue;
          }

          sendTelegram(liq).catch(err => console.error("Telegram alert failed: " + err.stack));
        }
      });

      ws.addEventListener("error", event => {
        console.error("OpenMarket WebSocket error event received");
        logPersistent("ERROR", "ws_error_event", "WebSocket error event", { message: String(event && event.message || "unknown") });
      });

      ws.addEventListener("close", event => {
        logPersistent("WARN", "ws_closed", "WebSocket closed", { code: event.code, reason: String(event.reason || "") });
        console.log("OpenMarket WebSocket closed code=" + event.code + " reason=" + String(event.reason || ""));
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
        logPersistent("ERROR", "monitor_connection_error", "Monitor connection error", { message: err.message, stack: err.stack });
        await sleep(RECONNECT_MS);
      }
    }

    stopping = true;
    console.log("OpenMarket BTC liquidation monitor stopping cleanly");
    logPersistent("INFO", "monitor_stopped", "BTC liquidation monitor stopped");
  })();
}

console.log("OpenMarket BTC liquidation monitor started");
logPersistent("INFO", "monitor_started", "BTC liquidation monitor started", { subscriptions: SUBSCRIPTIONS });
console.log("OpenMarket WS client rate guard: " + WS_MESSAGE_LIMIT + " messages/min; heartbeat: 9s");
console.log("Minimum liquidation USD: " + MIN_LIQUIDATION_USD);
console.log("Subscriptions: " + SUBSCRIPTIONS.map(x => x.exchange + ":" + x.symbol).join(", "));
startMonitor();
