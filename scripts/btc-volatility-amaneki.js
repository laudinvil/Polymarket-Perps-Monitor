const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";

const AMANEKI_URL = "https://api.amaneki.com/v1/regime/btcusdt";
const POLL_MS = 5 * 1000;
const RUN_MS = 6 * 60 * 60 * 1000;
const TURBOFLOW_URL = "https://laudinvil.github.io/Polymarket-Perps-Monitor/turboflow/";

let stopping = false;
let lastRegime = null;
let pollTimer = null;

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

async function poll() {
  if (stopping) return;

  try {
    const response = await fetch(AMANEKI_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(4000)
    });

    if (!response.ok) {
      throw new Error("Amaneki HTTP " + response.status);
    }

    const data = await response.json();
    const regime = String(data.regime || "").toLowerCase();
    const zVol = Number(data.z_vol);

    if (!["low", "normal", "high"].includes(regime) || !Number.isFinite(zVol)) {
      log("WARN", "invalid_response", "Invalid Amaneki regime response", { data });
      return;
    }

    log("INFO", "volatility_snapshot", "Amaneki BTC volatility snapshot", {
      regime,
      z_vol: zVol,
      realized_vol: data.realized_vol,
      baseline_vol: data.baseline_vol,
      close: data.close,
      last_update_ms: data.last_update_ms,
      computed_at_ms: data.computed_at_ms
    });

    const transitionedToAlertRegime =
      (regime === "normal" || regime === "high") &&
      regime !== lastRegime;

    lastRegime = regime;

    if (!transitionedToAlertRegime) return;

    const eventTime = Number(data.computed_at_ms || data.last_update_ms || Date.now());
    const label = regime.toUpperCase();
    const icon = regime === "high" ? "🔥" : "⚠️";

    const text = [
      icon + " <b>BTC VOLATILITY " + label + "</b>",
      "",
      "Z-VOL: " + formatNumber(zVol, 2),
      "REGIME: <b>" + label + "</b>",
      "TIME: " + formatUtcPlus3(eventTime),
      "",
      '<a href="' + TURBOFLOW_URL + '">ОТКРЫТЬ TURBOFLOW</a>',
      ""
    ].join("\n");

    log("INFO", "regime_alert", "BTC volatility entered alert regime", {
      regime,
      z_vol: zVol,
      eventTime
    });

    sendTelegram(text).catch(err => {
      log("ERROR", "telegram_error", "Telegram alert failed", {
        message: err.message,
        regime,
        z_vol: zVol
      });
    });
  } catch (err) {
    log("WARN", "poll_error", "Amaneki REST poll failed; monitor continues", {
      message: err.message
    });
  }
}

async function start() {
  log("INFO", "monitor_started", "BTC Amaneki volatility monitor started", {
    source: AMANEKI_URL,
    symbol: "BTCUSDT",
    pollMs: POLL_MS,
    strategy: "alert_on_transition_to_normal_or_high",
    turboflowUrl: TURBOFLOW_URL
  });

  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    log("ERROR", "telegram_config_missing", "Telegram secrets are missing at startup", {
      botTokenPresent: Boolean(TELEGRAM_BOT_TOKEN),
      chatIdPresent: Boolean(TELEGRAM_CHAT_ID)
    });
  }

  await poll();
  pollTimer = setInterval(poll, POLL_MS);

  setTimeout(() => {
    stopping = true;
    if (pollTimer) clearInterval(pollTimer);
    log("INFO", "monitor_stopped", "BTC Amaneki volatility monitor stopped");
  }, RUN_MS);
}

process.on("SIGTERM", () => {
  stopping = true;
  if (pollTimer) clearInterval(pollTimer);
  process.exit(0);
});

start().catch(err => {
  log("ERROR", "fatal_error", "BTC Amaneki volatility monitor failed", {
    message: err.message
  });
  process.exitCode = 1;
});
