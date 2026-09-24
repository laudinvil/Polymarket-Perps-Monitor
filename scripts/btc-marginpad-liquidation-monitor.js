const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const FEED_URL = "https://marginpad.io/api/v1/feed";
const POLL_MS = 4000;
const REQUEST_TIMEOUT_MS = 4500;
const RUN_MS = 5 * 60 * 60 * 1000;
const seen = new Set();
let stopping = false;
let pollInFlight = false;

const sourceState = {
  MARGINPAD: {
    state: "STARTING",
    requests: 0,
    successfulRequests: 0,
    matchingEvents: 0,
    alerts: 0,
    lastSuccessAt: null,
    lastErrorAt: null
  }
};

function log(level, event, message, data) {
  const payload = {
    level,
    event,
    message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) })
  };
  console.log(JSON.stringify(payload));
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;

  const response = await fetch(
    "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(10000)
    }
  );

  if (!response.ok) {
    throw new Error("Telegram HTTP " + response.status);
  }
}

function dedupeKey(liq) {
  return [
    liq.exchange,
    liq.time,
    liq.side,
    liq.price,
    liq.amount
  ].join(":");
}

function processLiquidation(liq) {
  if (
    liq.exchange !== "HYPERLIQUID" ||
    liq.symbol !== "BTC" ||
    !Number.isFinite(liq.price) ||
    !Number.isFinite(liq.amount) ||
    liq.amount <= 0 ||
    !Number.isFinite(liq.time)
  ) {
    return;
  }

  sourceState.MARGINPAD.matchingEvents += 1;

  const key = dedupeKey(liq);
  if (seen.has(key)) return;

  seen.add(key);
  if (seen.size > 10000) {
    seen.delete(seen.values().next().value);
  }

  const usd = liq.price * liq.amount;
  const sideText =
    liq.side === "long_liquidated"
      ? "LONG LIQUIDATED"
      : liq.side === "short_liquidated"
        ? "SHORT LIQUIDATED"
        : String(liq.side).toUpperCase();

  sourceState.MARGINPAD.alerts += 1;

  log("INFO", "liquidation_received", "BTC Hyperliquid liquidation received via MarginPad", {
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
    "EXCHANGE: HYPERLIQUID",
    "TIME: " + new Date(liq.time).toISOString().replace("T", " "),
    "",
    "➡️ TF",
    "https://tf.xyz/events/"
  ].join("\n");

  sendTelegram(text).catch(err =>
    log("ERROR", "telegram_error", "Telegram alert failed", { message: err.message })
  );
}

async function pollMarginPad() {
  if (stopping || pollInFlight) return;
  pollInFlight = true;

  sourceState.MARGINPAD.requests += 1;

  try {
    const response = await fetch(FEED_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    if (!response.ok) {
      throw new Error("MarginPad HTTP " + response.status);
    }

    const rawText = await response.text();
    log("INFO", "marginpad_raw_response", "Raw MarginPad feed response", {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: rawText
    });

    let body;
    try {
      body = JSON.parse(rawText);
    } catch (parseErr) {
      throw new Error("MarginPad returned non-JSON response: " + parseErr.message);
    }

    const events = Array.isArray(body?.events) ? body.events : [];
    if (!Array.isArray(body?.events)) {
      log("WARN", "marginpad_unexpected_shape", "MarginPad response has no events array; monitoring continues", {
        bodyKeys: body && typeof body === "object" ? Object.keys(body) : [],
        bodyType: typeof body
      });
    }

    sourceState.MARGINPAD.state = "OPEN";
    sourceState.MARGINPAD.successfulRequests += 1;
    sourceState.MARGINPAD.lastSuccessAt = Date.now();

    for (const event of events) {
      processLiquidation({
        exchange: String(event.exchange || "").toUpperCase(),
        symbol: String(event.symbol || "").toUpperCase(),
        side: event.side,
        price: Number(event.price),
        amount: Number(event.qty),
        time: Number(event.ts)
      });
    }
  } catch (err) {
    sourceState.MARGINPAD.state = "ERROR";
    sourceState.MARGINPAD.lastErrorAt = Date.now();

    log("WARN", "marginpad_poll_error", "MarginPad liquidation feed request failed; monitoring continues", {
      message: err.message
    });
  } finally {
    pollInFlight = false;
  }
}

console.log("BTC liquidation monitor started");
log("INFO", "monitor_started", "BTC Hyperliquid liquidation monitor started via MarginPad", {
  source: "MARGINPAD",
  exchange: "HYPERLIQUID",
  symbol: "BTC",
  method: "marginpad_feed_polling",
  pollMs: POLL_MS,
  minLiquidationUsd: 0
});

pollMarginPad();
const pollTimer = setInterval(pollMarginPad, POLL_MS);

const heartbeatTimer = setInterval(() => {
  log("INFO", "monitor_heartbeat", "BTC liquidation monitor heartbeat", {
    uptimeSec: Math.floor(process.uptime()),
    MARGINPAD: sourceState.MARGINPAD,
    seen: seen.size
  });
}, 30000);

setTimeout(() => {
  stopping = true;
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  log("INFO", "monitor_stopped", "BTC Hyperliquid liquidation monitor stopped");
}, RUN_MS);

process.on("SIGTERM", () => {
  stopping = true;
  clearInterval(pollTimer);
  clearInterval(heartbeatTimer);
  process.exit(0);
});
