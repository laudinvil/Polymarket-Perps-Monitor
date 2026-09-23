const fs = require("fs");
const { execFileSync } = require("child_process");

const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const STATE_FILE = "state/btc-5m-oi.json";
const PERIOD = 300;
const TARGET_OFFSET = 270;
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

function getOutcomeTokenId(event, outcome) {
  const markets = Array.isArray(event && event.markets) ? event.markets : [];
  const market = markets.find(function(m) {
    const q = String(m.question || "").toLowerCase();
    const s = String(m.slug || "").toLowerCase();
    return s.indexOf("btc-updown-5m") >= 0 || q.indexOf("bitcoin") >= 0 || q.indexOf("btc") >= 0;
  }) || markets[0];
  if (!market) return null;

  let outcomes = market.outcomes;
  let tokenIds = market.clobTokenIds || market.clob_token_ids;
  try { if (typeof outcomes === "string") outcomes = JSON.parse(outcomes); } catch (_) {}
  try { if (typeof tokenIds === "string") tokenIds = JSON.parse(tokenIds); } catch (_) {}
  if (!Array.isArray(outcomes) || !Array.isArray(tokenIds)) return null;

  const index = outcomes.findIndex(function(value) {
    return String(value).toUpperCase() === outcome;
  });
  return index >= 0 ? tokenIds[index] : null;
}

async function getNextClobPrice(start, outcome) {
  const nextStart = start + PERIOD;
  const slug = "btc-updown-5m-" + nextStart;
  const event = await getJson(GAMMA_API + "/events/slug/" + slug);
  const tokenId = getOutcomeTokenId(event, outcome);
  if (!tokenId) throw new Error("CLOB token not found for next BTC 5M " + outcome);
  const response = await getJson(CLOB_API + "/midpoint?token_id=" + encodeURIComponent(tokenId));
  const price = Number(response && response.mid);
  if (!Number.isFinite(price)) throw new Error("CLOB midpoint unavailable for next BTC 5M " + outcome);
  return price;
}

function getTradeSide(row) {
  const outcome = String(row.outcome || "").trim().toUpperCase();
  if (outcome === "UP" || outcome === "YES") return "UP";
  if (outcome === "DOWN" || outcome === "NO") return "DOWN";
  return null;
}

async function getPeriodVolume(conditionId, start, end) {
  let cursor = null;
  let pages = 0;
  let totalRows = 0;
  let upVolume = 0;
  let upTurnover = 0;
  let downTurnover = 0;

  while (true) {
    const cursorParam = cursor ? "&cursor=" + encodeURIComponent(cursor) : "";
    const url = DATA_API + "/v2/trades?condition=" + encodeURIComponent(conditionId) + "&limit=1000" + cursorParam;
    const response = await getJson(url);
    const rows = Array.isArray(response && response.data) ? response.data : [];
    const pagination = response && response.pagination ? response.pagination : {};

    pages++;
    totalRows += rows.length;
    let reachedOlderTrades = false;

    for (const row of rows) {
      if (!row) continue;

      const ts = Number(row.timestamp != null ? row.timestamp : row.ts != null ? row.ts : row.match_time);
      if (!Number.isFinite(ts)) continue;

      const seconds = ts > 1e12 ? ts / 1000 : ts;

      if (seconds < start) {
        reachedOlderTrades = true;
        continue;
      }

      if (seconds >= end) continue;

      const side = getTradeSide(row);
      const size = Number(row.size);
      const price = Number(row.price);
      if (!side || !Number.isFinite(size) || !Number.isFinite(price)) continue;

      const turnover = size * price;
      if (side === "UP") {
        upVolume += size;
        upTurnover += turnover;
      }
      if (side === "DOWN") downTurnover += turnover;
    }

    console.log(
      "Volume page=" + pages +
      " rows=" + rows.length +
      " totalRows=" + totalRows +
      " hasMore=" + Boolean(pagination.has_more) +
      " upVolume=" + upVolume.toFixed(2) +
      " upTurnover=" + upTurnover.toFixed(2) +
      " downTurnover=" + downTurnover.toFixed(2)
    );

    if (reachedOlderTrades || !pagination.has_more || !pagination.next_cursor) break;
    cursor = pagination.next_cursor;
  }

  const moneyImbalance = upTurnover - downTurnover;
  const totalTurnover = upTurnover + downTurnover;
  const upImbalance = totalTurnover > 0 ? (moneyImbalance / totalTurnover) * 100 : 0;

  console.log(
    "Period volume complete: pages=" + pages +
    " rows=" + totalRows +
    " upVolume=" + upVolume.toFixed(2) +
    " upTurnover=" + upTurnover.toFixed(2) +
    " downTurnover=" + downTurnover.toFixed(2) +
    " moneyImbalance=" + moneyImbalance.toFixed(2) +
    " upImbalance=" + upImbalance.toFixed(2) + "%"
  );

  return {
    upVolume: upVolume,
    upTurnover: upTurnover,
    downTurnover: downTurnover,
    moneyImbalance: moneyImbalance,
    upImbalance: upImbalance
  };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch (_) { return {}; }
}

function writeState(state) {
  fs.mkdirSync("state", { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
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

    try {
      execFileSync("git", ["push"], { stdio: "pipe" });
    } catch (pushErr) {
      const pushMessage = String(pushErr && (pushErr.stderr || pushErr.message) || pushErr);
      if (pushMessage.indexOf("fetch first") < 0 && pushMessage.indexOf("non-fast-forward") < 0) throw pushErr;

      console.log("State push raced with another main commit; rebasing state commit");
      const stateBackup = fs.readFileSync(STATE_FILE, "utf8");
      execFileSync("git", ["fetch", "origin", "main"], { stdio: "pipe" });
      execFileSync("git", ["reset", "--hard", "origin/main"], { stdio: "pipe" });
      fs.writeFileSync(STATE_FILE, stateBackup);
      execFileSync("git", ["add", STATE_FILE]);
      execFileSync("git", ["commit", "-m", "Update BTC 5M OI state " + period], { stdio: "pipe" });
      execFileSync("git", ["push", "origin", "HEAD:main"], { stdio: "pipe" });
    }
  } catch (err) {
    const message = String(err && (err.stderr || err.message) || err);
    if (message.indexOf("nothing to commit") < 0) throw err;
  }
}

async function monitorPeriod(start) {
  const targetTime = start + TARGET_OFFSET;
  const now = Math.floor(Date.now() / 1000);
  if (now < targetTime) {
    console.log("Waiting for 4:30. Period=" + start + " wait=" + (targetTime - now) + "s");
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
  const volume = await getPeriodVolume(market.conditionId, start, snapshotTime + 1);
  const previousMarket = await getCurrentMarket(start - PERIOD);
  const previousVolume = await getPeriodVolume(previousMarket.conditionId, start - PERIOD, start);
  const nextUrl = POLY_URL + (start + PERIOD);

  const previousUpVolume = Number(state.upVolume);
  const upVolumeChange = Number.isFinite(previousUpVolume) && previousUpVolume > 0
    ? ((volume.upVolume - previousUpVolume) / previousUpVolume) * 100
    : null;

  const nextState = {
    periodStart: start,
    snapshotOffset: TARGET_OFFSET,
    upVolume: volume.upVolume,
    upTurnover: volume.upTurnover,
    downTurnover: volume.downTurnover,
    moneyImbalance: volume.moneyImbalance,
    upImbalance: volume.upImbalance,
    previousUpVolume: Number.isFinite(previousUpVolume) ? previousUpVolume : null,
    previousPeriodUpVolume: previousVolume.upVolume,
    updatedAt: new Date().toISOString()
  };

  const changeText = upVolumeChange === null
    ? ""
    : " " + (upVolumeChange >= 0 ? "+" : "") + upVolumeChange.toFixed(2) + "%";

  const lines = [
    "🔥 BTC · 5M",
    "",
    "UP VOLUME: " + new Intl.NumberFormat("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2}).format(volume.upVolume),
    "UP TURNOVER: $" + new Intl.NumberFormat("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2}).format(volume.upTurnover),
    "MONEY IMBALANCE UP: $" + new Intl.NumberFormat("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2}).format(volume.moneyImbalance) + " (" + volume.upImbalance.toFixed(2) + "%)" + changeText,
    "",
    "➡️ NEXT · Polymarket 5M",
    nextUrl
  ];

  await sendTelegram(lines.join("\n"));
  console.log("Telegram sent for period=" + start + " UP volume=" + volume.upVolume.toFixed(2) + " UP turnover=" + volume.upTurnover.toFixed(2));
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
