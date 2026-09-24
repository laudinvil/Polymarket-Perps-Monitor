const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const BINANCE_WS_URL = "wss://fstream.binance.com/ws/btcusdt@forceOrder";
const BYBIT_WS_URL = "wss://stream.bybit.com/v5/public/linear";

const RUN_MS = 6 * 60 * 60 * 1000;
const COOLDOWN_MS = 30 * 1000;
const RECONNECT_MS = 3000;
const TURBOFLOW_URL = "https://laudinvil.github.io/Polymarket-Perps-Monitor/turboflow/";

let stopping = false;
let cooldownUntil = 0;

const stats = {
  BINANCE: { state: "STARTING", received: 0, alerts: 0, ignoredCooldown: 0, reconnects: 0 },
  BYBIT: { state: "STARTING", received: 0, alerts: 0, ignoredCooldown: 0, reconnects: 0 }
};

function log(level, event, message, data) {
  console.log(JSON.stringify({
    level,
    event,
    message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) })
  }));
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("ERROR", "telegram_config_missing", "Telegram secrets are missing", {
      botTokenPresent: Boolean(TELEGRAM_BOT_TOKEN),
      chatIdPresent: Boolean(TELEGRAM_CHAT_ID)
    });
    return;
  }

  const response = await fetch(
    "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    throw new Error("Telegram HTTP " + response.status);
  }
}

function formatUsd(value) {
  return "$" + value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function acceptLiquidation({ exchange, side, price, amount, eventTime }) {
  if (
    side === undefined ||
    !Number.isFinite(price) ||
    !Number.isFinite(amount) ||
    amount <= 0
  ) {
    log("WARN", "invalid_liquidation", "Ignoring invalid liquidation event", {
      exchange, side, price, amount, eventTime
    });
    return;
  }

  stats[exchange].received += 1;

  const now = Date.now();

  if (now < cooldownUntil) {
    stats[exchange].ignoredCooldown += 1;
    log("INFO", "liquidation_ignored_cooldown", "Liquidation ignored during 30 second cooldown", {
      exchange,
      side,
      price,
      amount,
      cooldownRemainingMs: cooldownUntil - now
    });
    return;
  }

  cooldownUntil = now + COOLDOWN_MS;

  const usd = price * amount;

  stats[exchange].alerts += 1;

  log("INFO", "liquidation_alert", "BTC liquidation accepted", {
    exchange,
    side,
    price,
    amount,
    usd,
    eventTime,
    cooldownUntil
  });

  const text = [
    "🔥 BTC",
    "",
    String(side).toUpperCase() + " LIQUIDATED",
    "PRICE: $" + price.toLocaleString("en-US", { maximumFractionDigits: 2 }),
    "SIZE: " + formatUsd(usd),
    "",
    '<a href="' + TURBOFLOW_URL + '">ОТКРЫТЬ TURBOFLOW</a>',
    "",
    "➡️ TF",
    "https://tf.xyz/events/"
  ].join("\n");

  sendTelegram(text).catch(err => {
    log("ERROR", "telegram_error", "Telegram alert failed", {
      message: err.message,
      exchange,
      side,
      price,
      usd
    });
  });
}

function handleBinanceMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    log("WARN", "binance_parse_error", "Invalid Binance websocket message", {
      message: err.message
    });
    return;
  }

  const order = msg?.o;
  if (msg?.e !== "forceOrder" || !order || order.s !== "BTCUSDT") return;

  acceptLiquidation({
    exchange: "BINANCE",
    side: order.S,
    price: Number(order.ap),
    amount: Number(order.z || order.q),
    eventTime: Number(order.T || msg.E)
  });
}

function connectBinance() {
  if (stopping) return;

  const ws = new WebSocket(BINANCE_WS_URL);
  stats.BINANCE.state = "CONNECTING";

  ws.addEventListener("open", () => {
    stats.BINANCE.state = "OPEN";
    log("INFO", "binance_connected", "Binance BTC liquidation websocket connected");
  });

  ws.addEventListener("message", event => {
    handleBinanceMessage(event.data);
  });

  ws.addEventListener("error", event => {
    stats.BINANCE.state = "ERROR";
    log("WARN", "binance_ws_error", "Binance websocket error", {
      message: event?.message || "websocket error"
    });
  });

  ws.addEventListener("close", () => {
    stats.BINANCE.state = "CLOSED";
    if (stopping) return;

    stats.BINANCE.reconnects += 1;
    log("WARN", "binance_disconnected", "Binance websocket disconnected; reconnecting", {
      reconnectInMs: RECONNECT_MS
    });

    setTimeout(connectBinance, RECONNECT_MS);
  });
}

function handleBybitMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    log("WARN", "bybit_parse_error", "Invalid Bybit websocket message", {
      message: err.message
    });
    return;
  }

  if (msg?.op === "subscribe") {
    log("INFO", "bybit_subscribed", "Bybit liquidation stream subscription response", {
      success: msg.success,
      ret_msg: msg.ret_msg
    });
    return;
  }

  if (msg?.topic !== "allLiquidation.BTCUSDT") return;

  const items = Array.isArray(msg.data) ? msg.data : [msg.data];

  for (const item of items) {
    if (!item) continue;

    acceptLiquidation({
      exchange: "BYBIT",
      side: item.S,
      price: Number(item.p),
      amount: Number(item.v),
      eventTime: Number(item.T || msg.ts)
    });
  }
}

function connectBybit() {
  if (stopping) return;

  const ws = new WebSocket(BYBIT_WS_URL);
  stats.BYBIT.state = "CONNECTING";

  ws.addEventListener("open", () => {
    stats.BYBIT.state = "OPEN";

    ws.send(JSON.stringify({
      op: "subscribe",
      args: ["allLiquidation.BTCUSDT"]
    }));

    log("INFO", "bybit_connected", "Bybit BTC liquidation websocket connected");
  });

  ws.addEventListener("message", event => {
    handleBybitMessage(event.data);
  });

  ws.addEventListener("error", event => {
    stats.BYBIT.state = "ERROR";
    log("WARN", "bybit_ws_error", "Bybit websocket error", {
      message: event?.message || "websocket error"
    });
  });

  ws.addEventListener("close", () => {
    stats.BYBIT.state = "CLOSED";
    if (stopping) return;

    stats.BYBIT.reconnects += 1;
    log("WARN", "bybit_disconnected", "Bybit websocket disconnected; reconnecting", {
      reconnectInMs: RECONNECT_MS
    });

    setTimeout(connectBybit, RECONNECT_MS);
  });
}

log("INFO", "monitor_started", "BTC liquidation monitor started via Binance and Bybit WebSockets", {
  sources: ["BINANCE", "BYBIT"],
  symbol: "BTCUSDT",
  cooldownMs: COOLDOWN_MS,
  directionMode: "raw_exchange_side",
  turboflowUrl: TURBOFLOW_URL
});

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  log("ERROR", "telegram_config_missing", "Telegram secrets are missing at startup", {
    botTokenPresent: Boolean(TELEGRAM_BOT_TOKEN),
    chatIdPresent: Boolean(TELEGRAM_CHAT_ID)
  });
}

connectBinance();
connectBybit();

const heartbeatTimer = setInterval(() => {
  log("INFO", "monitor_heartbeat", "BTC liquidation monitor heartbeat", {
    uptimeSec: Math.floor(process.uptime()),
    cooldownRemainingMs: Math.max(0, cooldownUntil - Date.now()),
    BINANCE: stats.BINANCE,
    BYBIT: stats.BYBIT
  });
}, 30000);

setTimeout(() => {
  stopping = true;
  clearInterval(heartbeatTimer);
  log("INFO", "monitor_stopped", "BTC liquidation monitor stopped");
}, RUN_MS);

process.on("SIGTERM", () => {
  stopping = true;
  clearInterval(heartbeatTimer);
  process.exit(0);
});
