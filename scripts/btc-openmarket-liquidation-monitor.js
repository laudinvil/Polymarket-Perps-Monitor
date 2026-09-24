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

const persistentLogQueue = [];
let persistentLogFlushTimer = null;
let persistentLogFlushing = false;

async function flushPersistentLogs() {
  if (persistentLogFlushing || persistentLogQueue.length === 0) return;
  persistentLogFlushing = true;
  const batch = persistentLogQueue.splice(0, 20);
  try {
    await convexMutation("btc5mState:logOpenMarketBatch", { logs: batch });
  } catch (err) {
    console.error("Persistent log batch failed: " + err.message);
    // Put failed entries back so transient Convex failures do not lose diagnostics.
    persistentLogQueue.unshift(...batch);
  } finally {
    persistentLogFlushing = false;
  }
}

function logPersistent(level, event, message, data) {
  console.log("PERSISTENT " + level + " " + event + " " + message);
  persistentLogQueue.push({
    level,
    event,
    message,
    data: data == null ? undefined : JSON.stringify(data)
  });

  if (persistentLogQueue.length >= 20) {
    void flushPersistentLogs();
  }

  if (!persistentLogFlushTimer) {
    persistentLogFlushTimer = setTimeout(async () => {
      persistentLogFlushTimer = null;
      await flushPersistentLogs();
      if (persistentLogQueue.length > 0) {
        persistentLogFlushTimer = setTimeout(() => {
          persistentLogFlushTimer = null;
          void flushPersistentLogs();
        }, 2000);
      }
    }, 2000);
  }
}

const SUBSCRIPTIONS = [
  { exchange: "BINANCE_FUTURES", symbol: "BTCUSDT" }
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
      logPersistent("INFO", "ws_connect_attempt", "Opening WebSocket connection", { url: WS_URL });
      createSocket(resolve);
    });

    function createSocket(resolve) {
      let ws;
      try {
        ws = new WebSocket(WS_URL);
      } catch (err) {
        console.error("OpenMarket WebSocket constructor failed: " + err.stack);
        logPersistent("ERROR", "ws_constructor_error", "WebSocket constructor failed", { message: err.message, stack: err.stack });
        resolve();
        return;
      }

      let settled = false;
      let pingTimer = null;
      let subscribed = false;
      let subscriptionSent = false;
      let authAccepted = false;
      let opened = false;
      let authTimer = null;
      let subscribeTimer = null;
      let subscribeStartTimer = null;

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
        if (subscribeStartTimer) clearTimeout(subscribeStartTimer);
        if (pingTimer) clearInterval(pingTimer);
        try { ws.close(); } catch (_) {}
        resolve();
      }

      ws.addEventListener("open", () => {
        opened = true;
        console.log("OpenMarket WebSocket connected: " + WS_URL);
        logPersistent("INFO", "ws_connected", "WebSocket connected", { url: WS_URL });

        sendWs(ws, {
          jsonrpc: "2.0",
          id: 1,
          method: "public/authenticate",
          params: { token: apiKey }
        });

        logPersistent("INFO", "auth_sent", "Authentication request sent");

        authTimer = setTimeout(() => {
          if (!authAccepted) {
            logPersistent("WARN", "auth_no_response", "No authentication response observed; continuing with documented subscribe flow", { timeoutMs: WS_AUTH_TIMEOUT_MS });
          }
        }, WS_AUTH_TIMEOUT_MS);

        // Do not subscribe before authentication has been positively acknowledged.
        // The previous implementation subscribed after 1s even when authAccepted=false,
        // which produced the exact failure state seen in Convex.
        subscribeStartTimer = setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN || !authAccepted) {
            logPersistent("WARN", "subscribe_blocked_until_auth", "Subscription not sent because authentication was not confirmed", {
              authAccepted,
              readyState: ws.readyState
            });
            return;
          }

          // Subscribe to each exchange separately so one invalid channel cannot
          // obscure which exchange causes a protocol/connection failure.
          const sendSubscription = async () => {
            for (let i = 0; i < SUBSCRIPTIONS.length; i++) {
              if (ws.readyState !== WebSocket.OPEN) return;

              const item = SUBSCRIPTIONS[i];
              const channel = {
                type: "LIQUIDATION",
                category: "*",
                exchange: item.exchange,
                symbol: item.symbol
              };
              const id = i + 1;

              await sendWs(ws, {
                jsonrpc: "2.0",
                id,
                method: "public/subscribe",
                params: {
                  channels: [channel],
                  version: "v2"
                }
              });

              subscriptionSent = true;
              logPersistent("INFO", "subscribe_sent", "Liquidation subscription sent", {
                id,
                channel
              });

              // Only one documented BTC Binance liquidation channel is enabled for
              // the diagnostic run. Additional exchanges will be added after this
              // subscription is confirmed stable.
            }

            subscribeTimer = setTimeout(() => {
              if (!subscribed) {
                logPersistent("ERROR", "subscribe_timeout", "No subscription response observed", {
                  timeoutMs: WS_SUBSCRIBE_TIMEOUT_MS
                });
              }
            }, WS_SUBSCRIBE_TIMEOUT_MS);
          };

          sendSubscription().catch(err => {
            logPersistent("ERROR", "subscribe_send_error", "Subscription sequence failed", {
              message: err.message,
              stack: err.stack
            });
          });
        }, 1000);

        pingTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            sendWs(ws, { type: "ping", timestamp: Date.now() });
          }
        }, 30000);
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

        const rawMessage = JSON.stringify(message);
        console.log("OpenMarket WS message: " + rawMessage.slice(0, 4000));

        if (message.error) {
          logPersistent("ERROR", "ws_message_error", "OpenMarket WebSocket error message", {
            message: rawMessage.slice(0, 4000)
          });
          console.error("OpenMarket WS error: " + JSON.stringify(message.error));
          logPersistent("ERROR", "auth_or_protocol_error", "OpenMarket returned an error response", {
            error: message.error,
            opened,
            authAccepted,
            subscribed
          });
          logPersistent("ERROR", "ws_protocol_error", "OpenMarket protocol error", { error: message.error });
          logPersistent("ERROR", "ws_error", "OpenMarket WebSocket error", message.error);
          return;
        }

        // Subscription responses use the request id (1..7). Handle them before generic result messages
        // so a subscription response cannot be mistaken for authentication.
        if (Number.isInteger(message.id) && message.id >= 1 && message.id <= SUBSCRIPTIONS.length) {
          const channel = SUBSCRIPTIONS[message.id - 1];
          logPersistent("INFO", "subscribe_response", "Subscription response received", {
            id: message.id,
            channel,
            result: message.result || message,
            subscriptionSent
          });
          subscribed = true;
          if (subscribeTimer) clearTimeout(subscribeTimer);
          return;
        }

        // Authentication responses are not documented by OpenMarket, but if the server
        // sends an uncorrelated result message, retain it as diagnostic information.
        if (
          !authAccepted &&
          !message.points &&
          (
            (message.id === 1 && message.result) ||
            message.method === "public/authenticate" ||
            message.method === "public/authenticate.result"
          )
        ) {
          authAccepted = true;
          if (authTimer) clearTimeout(authTimer);
          logPersistent("INFO", "auth_response", "OpenMarket authentication response received", { result: message.result || message });
          logPersistent("INFO", "auth_ok", "Authentication accepted", message.result || message);
          return;
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
        logPersistent("ERROR", "ws_error_event", "WebSocket error event", {
          message: String(event && event.message || "unknown"),
          name: String(event && event.name || "unknown"),
          type: String(event && event.type || "error"),
          opened,
          authAccepted,
          subscriptionSent,
          subscribed,
          readyState: ws.readyState,
          url: WS_URL
        });
      });

      ws.addEventListener("close", event => {
        logPersistent("WARN", "ws_closed", "WebSocket closed", {
          code: event.code,
          reason: String(event.reason || ""),
          opened,
          authAccepted,
          subscribed,
          readyState: ws.readyState
        });
        console.log("OpenMarket WebSocket closed code=" + event.code + " reason=" + String(event.reason || ""));
        finish();
      });
    }

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
console.log("OpenMarket WS client rate guard: " + WS_MESSAGE_LIMIT + " messages/min; heartbeat: 30s");
console.log("Minimum liquidation USD: " + MIN_LIQUIDATION_USD);
console.log("Subscriptions: " + SUBSCRIPTIONS.map(x => x.exchange + ":" + x.symbol).join(", "));
startMonitor();
