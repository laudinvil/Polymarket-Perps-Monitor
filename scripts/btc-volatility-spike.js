const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const WS_URL = "wss://fstream.binance.com/market/ws/btcusdt@aggTrade";
const TURBOFLOW_URL = "https://laudinvil.github.io/Polymarket-Perps-Monitor/turboflow/";

const SAMPLE_MS = 1000;
const CURRENT_WINDOW_MS = 30_000;
const BASELINE_WINDOW_MS = 10 * 60_000;
const SPIKE_Z = 2.0;
const RESET_Z = 0.75;
const COOLDOWN_MS = 60_000;
const RUN_MS = 6 * 60 * 60 * 1000;

let stopping = false;
let ws = null;
let reconnectTimer = null;
let sampleTimer = null;
let lastPrice = null;
let latestTradePrice = null;
let latestTradeTime = null;
let samples = [];
let currentSpikeActive = false;
let lastAlertAt = 0;
let signals = 0;
let startedAt = Date.now();
let lastStatsAt = 0;

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
    log("ERROR", "telegram_config_missing", "Telegram secrets are missing");
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

  if (!response.ok) throw new Error("Telegram HTTP " + response.status);
}

function formatNumber(value, digits = 2) {
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function formatUtcPlus3(timestamp) {
  const date = new Date(Number(timestamp) + 3 * 60 * 60 * 1000);
  return date.toISOString().slice(11, 19);
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function stddev(values, avg) {
  if (values.length < 2) return 0;
  const variance = mean(values.map(v => (v - avg) ** 2));
  return Math.sqrt(variance);
}

function computeMetrics(now) {
  const currentCutoff = now - CURRENT_WINDOW_MS;
  const baselineCutoff = now - BASELINE_WINDOW_MS;

  const current = samples.filter(s => s.t >= currentCutoff);
  const baseline = samples.filter(s => s.t >= baselineCutoff && s.t < currentCutoff);

  if (current.length < 10 || baseline.length < 120) return null;

  const currentReturns = current.map(s => s.r).filter(Number.isFinite);
  const baselineReturns = baseline.map(s => s.r).filter(Number.isFinite);
  if (currentReturns.length < 10 || baselineReturns.length < 120) return null;

  const currentRv = Math.sqrt(currentReturns.reduce((sum, r) => sum + r * r, 0));
  const chunks = [];
  for (let i = 0; i + 29 < baselineReturns.length; i += 30) {
    const chunk = baselineReturns.slice(i, i + 30);
    chunks.push(Math.sqrt(chunk.reduce((sum, r) => sum + r * r, 0)));
  }

  const baselineMean = mean(chunks);
  const baselineStd = stddev(chunks, baselineMean);
  const z = baselineStd > 0 ? (currentRv - baselineMean) / baselineStd : 0;

  const prices = current.map(s => s.p);
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const rangePct = low > 0 ? ((high - low) / low) * 100 : 0;

  return {
    currentRv,
    baselineMean,
    baselineStd,
    z,
    rangePct,
    price: prices[prices.length - 1],
    samples: current.length,
    baselineSamples: baseline.length
  };
}

function evaluate(now) {
  const metrics = computeMetrics(now);
  if (!metrics) return;

  const spike = metrics.z >= SPIKE_Z;
  if (!spike && metrics.z <= RESET_Z) currentSpikeActive = false;

  if (spike && !currentSpikeActive && now - lastAlertAt >= COOLDOWN_MS) {
    currentSpikeActive = true;
    lastAlertAt = now;
    signals += 1;

    const text = [
      "🔥 <b>BTC VOLATILITY SPIKE</b>",
      "",
      "Z-SCORE: <b>" + formatNumber(metrics.z, 2) + "</b>",
      "30S RV: " + formatNumber(metrics.currentRv * 100, 3) + "%",
      "10M BASELINE: " + formatNumber(metrics.baselineMean * 100, 3) + "%",
      "30S RANGE: " + formatNumber(metrics.rangePct, 3) + "%",
      "PRICE: $" + formatNumber(metrics.price, 2),
      "TIME: " + formatUtcPlus3(now),
      "",
      '<a href="' + TURBOFLOW_URL + '">ОТКРЫТЬ TURBOFLOW</a>'
    ].join("\n");

    log("INFO", "volatility_spike", "BTC volatility spike detected", {
      z: metrics.z,
      currentRv: metrics.currentRv,
      baselineMean: metrics.baselineMean,
      baselineStd: metrics.baselineStd,
      rangePct: metrics.rangePct,
      price: metrics.price,
      signals
    });

    sendTelegram(text).catch(err => {
      log("ERROR", "telegram_error", "Telegram alert failed", { message: err.message });
    });
  }

  if (now - lastStatsAt >= 60_000) {
    lastStatsAt = now;
    log("INFO", "volatility_stats", "BTC volatility monitor statistics", {
      z: Number(metrics.z.toFixed(3)),
      currentRv: Number((metrics.currentRv * 100).toFixed(4)),
      baselineRv: Number((metrics.baselineMean * 100).toFixed(4)),
      rangePct: Number(metrics.rangePct.toFixed(4)),
      price: metrics.price,
      signals,
      uptimeMin: Math.round((now - startedAt) / 60000)
    });
  }
}

function addTradePrice(price, timestamp) {
  if (!Number.isFinite(price) || !Number.isFinite(timestamp)) return;
  latestTradePrice = Number(price);
  latestTradeTime = Number(timestamp);
}

function samplePrice(now) {
  if (!Number.isFinite(latestTradePrice) || latestTradePrice <= 0) return;

  const price = latestTradePrice;
  const timestamp = now;

  if (lastPrice !== null && lastPrice > 0) {
    samples.push({ t: timestamp, p: price, r: Math.log(price / lastPrice) });
  } else {
    samples.push({ t: timestamp, p: price, r: 0 });
  }

  lastPrice = price;
  const cutoff = timestamp - BASELINE_WINDOW_MS - CURRENT_WINDOW_MS;
  samples = samples.filter(s => s.t >= cutoff);
}

function connect() {
  if (stopping) return;

  ws = new WebSocket(WS_URL);

  ws.addEventListener("open", () => {
    log("INFO", "websocket_connected", "Connected to Binance BTCUSDT aggregate trades", {
      source: WS_URL
    });
  });

  ws.addEventListener("message", event => {
    try {
      const data = JSON.parse(event.data);
      if (data.e !== "aggTrade") return;
      addTradePrice(Number(data.p), Number(data.T || data.E));
    } catch (err) {
      log("WARN", "message_error", "Invalid Binance websocket message", {
        message: err.message
      });
    }
  });

  ws.addEventListener("close", () => {
    if (stopping) return;
    log("WARN", "websocket_closed", "Binance websocket closed; reconnecting");
    scheduleReconnect();
  });

  ws.addEventListener("error", () => {
    log("WARN", "websocket_error", "Binance websocket error");
  });
}

function scheduleReconnect() {
  if (reconnectTimer || stopping) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 2000);
}

async function start() {
  log("INFO", "monitor_started", "BTC Volatility Spike monitor started", {
    source: WS_URL,
    currentWindowSec: CURRENT_WINDOW_MS / 1000,
    baselineMin: BASELINE_WINDOW_MS / 60000,
    spikeZ: SPIKE_Z,
    resetZ: RESET_Z,
    cooldownSec: COOLDOWN_MS / 1000,
    strategy: "30s_realized_vol_vs_10m_rolling_baseline"
  });

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("ERROR", "telegram_config_missing", "Telegram secrets are missing at startup");
  }

  connect();

  sampleTimer = setInterval(() => {
    if (stopping) return;
    const now = Date.now();
    samplePrice(now);
    evaluate(now);
  }, SAMPLE_MS);

  setTimeout(() => {
    stopping = true;
    if (sampleTimer) clearInterval(sampleTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (ws) ws.close();
    log("INFO", "monitor_stopped", "BTC Volatility Spike monitor stopped", {
      signals,
      uptimeMin: Math.round((Date.now() - startedAt) / 60000)
    });
  }, RUN_MS);
}

process.on("SIGTERM", () => {
  stopping = true;
  if (sampleTimer) clearInterval(sampleTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (ws) ws.close();
  process.exit(0);
});

start().catch(err => {
  log("ERROR", "fatal_error", "BTC Volatility Spike monitor failed", {
    message: err.message
  });
  process.exitCode = 1;
});
