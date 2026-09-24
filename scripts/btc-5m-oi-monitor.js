const fs = require("fs");

const GAMMA_API = "https://gamma-api.polymarket.com";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const STATE_FILE = "state/btc-5m-oi.json";
const PERIOD = 300;
const POLY_URL = "https://polymarket.com/event/btc-updown-5m-";
const TELEGRAM_UPDATE_MS = 3000;

const CONVEX_URL = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || null;

async function convexMutation(path, args) {
  if (!CONVEX_URL) throw new Error("Missing CONVEX_URL");
  const res = await fetch(CONVEX_URL + "/api/mutation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: path, args: args, format: "json" }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await res.text();
  if (!res.ok) throw new Error("Convex HTTP " + res.status + ": " + body);
  const json = JSON.parse(body);
  if (json.status !== "success") throw new Error("Convex mutation error: " + (json.errorMessage || body));
  return json.value;
}


async function telegramRequest(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });

  const body = await res.text();
  if (!res.ok) throw new Error("Telegram HTTP " + res.status + ": " + body);

  let json;
  try {
    json = JSON.parse(body);
  } catch (_) {
    throw new Error("Invalid Telegram response: " + body);
  }

  if (!json.ok) throw new Error("Telegram API error: " + body);
  return json.result;
}

function formatPrice(value) {
  return Number.isFinite(value) ? value.toFixed(4) : "n/a";
}

function formatAlertTime() {
  const now = new Date();
  const utcPlus3 = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return utcPlus3.toISOString().slice(0, 19).replace("T", " ");
}

function buildTelegramText(market, state) {
  const side = state.firstIncrease ? state.firstIncrease.side : null;
  const from = state.firstIncrease ? state.firstIncrease.from : null;
  const to = state.firstIncrease ? state.firstIncrease.to : null;
  const arrow = side === "UP" ? "⬆️" : "⬇️";

  return [
    "🔥 BTC · 5M",
    "",
    "UP: " + formatPrice(displayPrice(state.up)),
    "DOWN: " + formatPrice(displayPrice(state.down)),
    "",
    formatAlertTime(),
    "",
    arrow + " " + side + " " + formatPrice(from) + " → " + formatPrice(to),
    "",
    "➡️ Polymarket 5M",
    market.url
  ].join("\n");
}

