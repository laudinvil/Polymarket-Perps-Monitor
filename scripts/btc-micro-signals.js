const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const WS_URL = "wss://fstream.binance.com/market/ws/btcusdt@aggTrade";
const TURBOFLOW_URL = "https://laudinvil.github.io/Polymarket-Perps-Monitor/turboflow/";

const SAMPLE_MS = 1000;
const SIGNAL_WINDOW_MS = 5000;
const RETURN_BASELINE_MS = 60_000;
const RV_BASELINE_MS = 60_000;
const RUN_MS = 6 * 60 * 60 * 1000;

const RV_Z_THRESHOLD = 2.0;
const RETURN_CASCADE_COUNT = 3;
const RETURN_CASCADE_WINDOW_MS = 5000;

let stopping = false;
let ws = null;
let reconnectTimer = null;
let sampleTimer = null;
let latestTradePrice = null;
let lastPrice = null;
let samples = [];
let signals = { rv: 0, ret: 0 };
let startedAt = Date.now();
let returnSignalTimes = [];

function log(level, event, message, data) {
  console.log(JSON.stringify({ level, event, message, ...(data === undefined ? {} : { data: JSON.stringify(data) }) }));
}

function fmt(v, d = 2) {
  return Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function time3(ts) {
  return new Date(ts + 3 * 60 * 60 * 1000).toISOString().slice(11, 19);
}

function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
}

function std(a, m) {
  if (a.length < 2) return 0;
  return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
}

function rv(a) {
  return Math.sqrt(a.reduce((s, x) => s + x * x, 0));
}

async function telegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("ERROR", "telegram_config_missing", "Telegram secrets are missing");
    return;
  }
  const r = await fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error("Telegram HTTP " + r.status);
}

function alert(type, body, now) {
  const key = type === "RV" ? "rv" : "ret";
  signals[key] += 1;

  const text = [
    "⚡ <b>BTC MICRO " + type + "</b>",
    "",
    body,
    "PRICE: $" + fmt(latestTradePrice, 2),
    "TIME: " + time3(now),
    "",
    '<a href="' + TURBOFLOW_URL + '">ОТКРЫТЬ TURBOFLOW</a>'
  ].join("\n");

  log("INFO", "micro_signal", "BTC micro signal detected", { type, signals });
  telegram(text).catch(err => log("ERROR", "telegram_error", "Telegram alert failed", { message: err.message, type }));
}

function evaluate(now) {
  const currentCutoff = now - SIGNAL_WINDOW_MS;
  const current = samples.filter(s => s.t >= currentCutoff);
  if (current.length < 2) return;

  const currentReturns = current.map(s => s.r).filter(Number.isFinite);
  if (currentReturns.length < 2) return;

  const baselineCutoff = now - RV_BASELINE_MS;
  const baseline = samples.filter(s => s.t >= baselineCutoff && s.t < currentCutoff).map(s => s.r);

  if (baseline.length >= 60) {
    const blocks = [];
    for (let i = 0; i + 4 < baseline.length; i += 5) blocks.push(rv(baseline.slice(i, i + 5)));
    if (blocks.length >= 10) {
      const m = mean(blocks);
      const sd = std(blocks, m);
      const z = sd > 0 ? (rv(currentReturns) - m) / sd : 0;
      if (z >= RV_Z_THRESHOLD) {
        alert("RV", "5S RV Z-SCORE: <b>" + fmt(z, 2) + "</b>\n5S RV: " + fmt(rv(currentReturns) * 100, 3) + "%", now);
      }
    }
  }

  const retBaseline = samples.filter(s => s.t >= baselineCutoff && s.t < currentCutoff).map(s => s.r);
  if (retBaseline.length >= 30) {
    const m = mean(retBaseline);
    const sd = std(retBaseline, m);
    const currentReturn = current[current.length - 1].r;
    const z = sd > 0 ? (currentReturn - m) / sd : 0;
    if (Math.abs(z) > 0) {
      returnSignalTimes = returnSignalTimes.filter(t => now - t <= RETURN_CASCADE_WINDOW_MS);
      if (!returnSignalTimes.length || now - returnSignalTimes[returnSignalTimes.length - 1] >= SAMPLE_MS) {
        returnSignalTimes.push(now);
      }
    }
    if (returnSignalTimes.length >= RETURN_CASCADE_COUNT) {
      alert("RETURN", "1S RETURN CASCADE: <b>3 real signals / 5S</b>\nLAST Z-SCORE: <b>" + fmt(z, 2) + "</b>\nRETURN: " + fmt(currentReturn * 100, 4) + "%", now);
      returnSignalTimes = [];
    }
  }
}

function sample(now) {
  if (!Number.isFinite(latestTradePrice) || latestTradePrice <= 0) return;
  const p = latestTradePrice;
  const r = lastPrice && lastPrice > 0 ? Math.log(p / lastPrice) : 0;
  samples.push({ t: now, p, r });
  lastPrice = p;
  samples = samples.filter(s => s.t >= now - Math.max(RV_BASELINE_MS, RETURN_BASELINE_MS) - SIGNAL_WINDOW_MS);
  evaluate(now);
}

function connect() {
  if (stopping) return;
  ws = new WebSocket(WS_URL);
  ws.addEventListener("open", () => log("INFO", "websocket_connected", "Connected to Binance BTCUSDT aggregate trades", { source: WS_URL }));
  ws.addEventListener("message", e => {
    try {
      const d = JSON.parse(e.data);
      if (d.e === "aggTrade") latestTradePrice = Number(d.p);
    } catch (err) {
      log("WARN", "message_error", "Invalid websocket message", { message: err.message });
    }
  });
  ws.addEventListener("close", () => {
    if (!stopping) { log("WARN", "websocket_closed", "Reconnecting"); scheduleReconnect(); }
  });
  ws.addEventListener("error", () => log("WARN", "websocket_error", "Binance websocket error"));
}

function scheduleReconnect() {
  if (reconnectTimer || stopping) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 2000);
}

function start() {
  log("INFO", "monitor_started", "BTC micro-signal monitor started", {
    source: WS_URL,
    rvWindowSec: SIGNAL_WINDOW_MS / 1000,
    baselineMin: 1,
    rvZ: RV_Z_THRESHOLD,
    returnCascade: RETURN_CASCADE_COUNT + " signals / " + (RETURN_CASCADE_WINDOW_MS / 1000) + "s",
    cooldownSec: 0
  });

  connect();
  sampleTimer = setInterval(() => {
    if (!stopping) sample(Date.now());
  }, SAMPLE_MS);

  setTimeout(() => stop(), RUN_MS);
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (sampleTimer) clearInterval(sampleTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  log("INFO", "monitor_stopped", "BTC micro-signal monitor stopped", { signals, uptimeMin: Math.round((Date.now() - startedAt) / 60000) });
}

process.on("SIGTERM", () => { stop(); process.exit(0); });
start();
