const fs = require("fs");
const WebSocket = require("ws");

const VERSION = "1.0.0-BTC-5M-EMA-9-21";
const SYMBOL = String(process.env.EMA_SYMBOL || "btcusdt").toLowerCase();
const INTERVAL = "5m";
const FAST = Number(process.env.EMA_FAST || 9);
const SLOW = Number(process.env.EMA_SLOW || 21);
const STATE_FILE = process.env.EMA_STATE_FILE || "/data/ema-btc-5m-state.json";
const WS_URL = "wss://fstream.binance.com/ws/" + SYMBOL + "@kline_" + INTERVAL;

let ws = null;
let reconnectTimer = null;
let stopped = false;
let emaFast = null;
let emaSlow = null;
let lastClosedPrice = null;
let lastSignal = null;
let candlesSeen = 0;

function log(event, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    component: "EMA_MONITOR",
    version: VERSION,
    event,
    ...data
  }));
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s && s.fast === FAST && s.slow === SLOW) {
      emaFast = Number.isFinite(Number(s.emaFast)) ? Number(s.emaFast) : null;
      emaSlow = Number.isFinite(Number(s.emaSlow)) ? Number(s.emaSlow) : null;
      lastClosedPrice = Number.isFinite(Number(s.lastClosedPrice)) ? Number(s.lastClosedPrice) : null;
      lastSignal = s.lastSignal || null;
      candlesSeen = Number(s.candlesSeen) || 0;
    }
  } catch {}
}

function saveState() {
  try {
    fs.mkdirSync(require("path").dirname(STATE_FILE), { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify({
      version: VERSION,
      symbol: SYMBOL,
      interval: INTERVAL,
      fast: FAST,
      slow: SLOW,
      emaFast,
      emaSlow,
      lastClosedPrice,
      lastSignal,
      candlesSeen,
      updatedAt: new Date().toISOString()
    }, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log("STATE_WRITE_ERROR", { error: String(e.message || e) });
  }
}

function updateEma(previous, price, length) {
  const alpha = 2 / (length + 1);
  return previous === null ? price : alpha * price + (1 - alpha) * previous;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log("TELEGRAM_NOT_CONFIGURED");
    return false;
  }
  try {
    const response = await fetch(
      "https://api.telegram.org/bot" + token + "/sendMessage",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: AbortSignal.timeout(8000)
      }
    );
    if (!response.ok) {
      log("TELEGRAM_ERROR", { status: response.status });
      return false;
    }
    return true;
  } catch (e) {
    log("TELEGRAM_ERROR", { error: String(e.message || e) });
    return false;
  }
}

function signalText(signal, price, candleTime) {
  const direction = signal === "UP" ? "🟢 LONG" : "🔴 SHORT";
  const time = new Date(candleTime).toLocaleTimeString("uk-UA", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
  return [
    direction + " BTC 5m EMA",
    "EMA: " + FAST + "/" + SLOW,
    "PRICE: $" + price.toFixed(2),
    "EMA" + FAST + ": $" + emaFast.toFixed(2),
    "EMA" + SLOW + ": $" + emaSlow.toFixed(2),
    time
  ].join("\n");
}

async function handleClosedCandle(k) {
  const close = Number(k.c);
  const candleTime = Number(k.T);
  if (!Number.isFinite(close) || close <= 0) return;

  const previousFast = emaFast;
  const previousSlow = emaSlow;

  emaFast = updateEma(emaFast, close, FAST);
  emaSlow = updateEma(emaSlow, close, SLOW);
  lastClosedPrice = close;
  candlesSeen++;

  if (previousFast !== null && previousSlow !== null) {
    const crossedUp = previousFast <= previousSlow && emaFast > emaSlow;
    const crossedDown = previousFast >= previousSlow && emaFast < emaSlow;

    if (crossedUp || crossedDown) {
      const signal = crossedUp ? "UP" : "DOWN";
      if (signal !== lastSignal) {
        lastSignal = signal;
        log("EMA_SIGNAL", {
          signal,
          price: close,
          emaFast,
          emaSlow,
          candleClosedAt: new Date(candleTime).toISOString()
        });
        await sendTelegram(signalText(signal, close, candleTime));
      }
    }
  }

  saveState();
}

async function bootstrapHistory() {
  try {
    const url = "https://fapi.binance.com/fapi/v1/klines?symbol=" +
      SYMBOL.toUpperCase() + "&interval=" + INTERVAL + "&limit=100";
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("Binance HTTP " + response.status);
    const rows = await response.json();
    emaFast = null;
    emaSlow = null;
    candlesSeen = 0;

    for (const row of rows) {
      const closeTime = Number(row[6]);
      const close = Number(row[4]);
      if (!Number.isFinite(closeTime) || closeTime > Date.now() || !Number.isFinite(close) || close <= 0) continue;
      emaFast = updateEma(emaFast, close, FAST);
      emaSlow = updateEma(emaSlow, close, SLOW);
      lastClosedPrice = close;
      candlesSeen++;
    }

    if (emaFast === null || emaSlow === null) {
      throw new Error("No closed candles returned");
    }

    saveState();
    log("BOOTSTRAPPED", {
      candles: candlesSeen,
      price: lastClosedPrice,
      emaFast,
      emaSlow
    });
  } catch (e) {
    log("BOOTSTRAP_ERROR", { error: String(e.message || e) });
    if (emaFast === null || emaSlow === null) {
      setTimeout(bootstrapHistory, 5000).unref();
    }
    throw e;
  }
}

function connect() {
  if (stopped) return;
  ws = new WebSocket(WS_URL);

  ws.on("open", () => {
    log("CONNECTED", {
      symbol: SYMBOL.toUpperCase(),
      interval: INTERVAL,
      fast: FAST,
      slow: SLOW
    });
  });

  ws.on("message", async raw => {
    try {
      const msg = JSON.parse(raw.toString());
      const k = msg.k;
      if (!k || k.x !== true) return;
      await handleClosedCandle(k);
    } catch (e) {
      log("MESSAGE_ERROR", { error: String(e.message || e) });
    }
  });

  ws.on("error", e => {
    log("WS_ERROR", { error: String(e.message || e) });
  });

  ws.on("close", () => {
    ws = null;
    if (stopped) return;
    log("DISCONNECTED");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  });
}

function shutdown(signal) {
  if (stopped) return;
  stopped = true;
  clearTimeout(reconnectTimer);
  saveState();
  try { if (ws) ws.close(); } catch {}
  log("STOPPED", { signal });
  setTimeout(() => process.exit(0), 100).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

if (!Number.isInteger(FAST) || !Number.isInteger(SLOW) || FAST < 2 || SLOW <= FAST) {
  throw new Error("EMA_FAST/EMA_SLOW invalid");
}

loadState();
bootstrapHistory().then(() => connect());
log("STARTING", {
  symbol: SYMBOL.toUpperCase(),
  interval: INTERVAL,
  strategy: "EMA_CROSS",
  fast: FAST,
  slow: SLOW,
  confirmation: "closed_5m_candle_only"
});
