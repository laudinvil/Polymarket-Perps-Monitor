const fs = require("fs");
const { execFileSync } = require("child_process");

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const STATE_FILE = "state/btc-5m-oi.json";
const PERIOD = 300;
const TARGET_OFFSET = 285;
const POLY_URL = "https://polymarket.com/event/btc-updown-5m-";

function periodStart(ts) { return Math.floor(ts / PERIOD) * PERIOD; }
function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

async function getJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "btc-5m-oi-monitor/1.0", "Accept": "application/json" },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
      return await res.json();
    } catch (err) {
      lastError = err;
      console.error("API attempt " + attempt + "/3 failed: " + err.message);
      if (attempt < 3) await sleep(2000);
    }
  }
  throw lastError;
}

function unwrap(payload) { return payload && Array.isArray(payload.data) ? payload.data : payload; }

function getConditionId(event) {
  const markets = Array.isArray(event && event.markets) ? event.markets : [];
  const market = markets.find(function(m) {
    const q = String(m.question || "").toLowerCase();
    const s = String(m.slug || "").toLowerCase();
    return s.indexOf("btc-updown-5m") >= 0 || q.indexOf("bitcoin") >= 0 || q.indexOf("btc") >= 0;
  }) || markets[0];
  const conditionId = market && (market.conditionId || market.condition_id);
  if (!conditionId) throw new Error("BTC 5M market conditionId not found");
  return conditionId;
}

async function getCurrentMarket(start) {
  const slug = "btc-updown-5m-" + start;
  const event = await getJson(GAMMA_API + "/events/slug/" + slug);
  return { slug: slug, conditionId: getConditionId(event) };
}

async function getOpenInterest(conditionId) {
  const url = DATA_API + "/v2/oi?condition=" + encodeURIComponent(conditionId);
  const payload = unwrap(await getJson(url));
  const rows = Array.isArray(payload) ? payload : [payload];
  let total = 0;
  let found = false;
  for (const row of rows) {
    const value = row && (row.value != null ? row.value : row.openInterest != null ? row.openInterest : row.open_interest != null ? row.open_interest : row.oi);
    const n = Number(value);
    if (Number.isFinite(n)) { total += n; found = true; }
  }
  if (!found) throw new Error("Open interest value not found in Data API response: " + JSON.stringify(payload));
  return total;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (_) { return {}; }
}

function writeState(state) {
  fs.mkdirSync("state", { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function formatUsd(value) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  const res = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, disable_web_page_preview: false }),
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error("Telegram HTTP " + res.status + ": " + await res.text());
}

function gitCommitState(period) {
  try {
    execFileSync("git", ["config", "user.name", "github-actions[bot]"]);
    execFileSync("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"]);
    execFileSync("git", ["add", STATE_FILE]);
    execFileSync("git", ["commit", "-m", "Update BTC 5M OI state " + period], { stdio: "pipe" });
    execFileSync("git", ["push"], { stdio: "pipe" });
  } catch (err) {
    const message = String(err && (err.stderr || err.message) || err);
    if (message.indexOf("nothing to commit") < 0) throw err;
  }
}

async function monitorPeriod(start) {
  const targetTime = start + TARGET_OFFSET;
  const now = Math.floor(Date.now() / 1000);
  if (now < targetTime) {
    console.log("Waiting for 4:45. Period=" + start + " wait=" + (targetTime - now) + "s");
    await sleep((targetTime - now) * 1000);
  }

  const snapshotTime = Math.floor(Date.now() / 1000);
  if (periodStart(snapshotTime) !== start) {
    console.log("Period rolled over before snapshot. Period=" + start);
    return;
  }

  const state = readState();
  if (Number(state.periodStart) === start) {
    console.log("Duplicate period; skipping. Period=" + start);
    return;
  }

  const market = await getCurrentMarket(start);
  const currentOI = await getOpenInterest(market.conditionId);
  const previousOI = Number(state.openInterest);

  let direction = "FIRST SNAPSHOT";
  let deltaPct = null;
  if (Number.isFinite(previousOI) && previousOI > 0) {
    const delta = currentOI - previousOI;
    deltaPct = delta / previousOI * 100;
    direction = delta > 0 ? "MORE ↑" : delta < 0 ? "LESS ↓" : "SAME →";
  }

  const nextState = {
    periodStart: start,
    snapshotOffset: TARGET_OFFSET,
    openInterest: currentOI,
    previousOpenInterest: Number.isFinite(previousOI) ? previousOI : null,
    deltaPct: deltaPct,
    previousDirection: direction,
    updatedAt: new Date().toISOString()
  };

  const nextUrl = POLY_URL + (start + PERIOD);
  const lines = [
    "🔥 BTC · 5M",
    "",
    "OPEN INTEREST: " + formatUsd(currentOI),
    previousOI > 0
      ? "VS PREVIOUS 4:45: " + formatUsd(previousOI) + " · " + direction + " " + Math.abs(deltaPct).toFixed(2) + "%"
      : "VS PREVIOUS 4:45: FIRST SNAPSHOT",
    "",
    "➡️ NEXT · Polymarket 5M",
    nextUrl
  ];

  const previousDirection = state.previousDirection;
  const sameDirectionTwice = previousDirection && previousDirection === direction && direction !== "SAME →";

  if (!sameDirectionTwice) {
    console.log("OI alert skipped: direction is not repeated twice. Current=" + direction + " Previous=" + (previousDirection || "NONE"));
    writeState(nextState);
    gitCommitState(start);
    console.log("State saved for period=" + start);
    return;
  }

  await sendTelegram(lines.join("\n"));
  console.log("Telegram sent for period=" + start);
  writeState(nextState);
  gitCommitState(start);
  console.log("State saved for period=" + start);
}

async function main() {
  console.log("BTC 5M OI monitor started in continuous mode");
  while (true) {
    const current = periodStart(Math.floor(Date.now() / 1000));
    try {
      await monitorPeriod(current);
    } catch (err) {
      console.error("Period monitor error: " + err.stack);
      console.log("Keeping monitor alive; retrying in 15s");
      await sleep(15000);
      continue;
    }

    const next = current + PERIOD;
    const wait = Math.max(1000, (next + TARGET_OFFSET - Math.floor(Date.now() / 1000)) * 1000);
    console.log("Next period=" + next + " sleep=" + Math.round(wait / 1000) + "s");
    await sleep(wait);
  }
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});