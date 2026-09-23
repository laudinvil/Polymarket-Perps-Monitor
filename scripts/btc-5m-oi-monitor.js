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

async function getPeriodTraders(conditionId, start, end) {
  let cursor = null;
  const traders = new Set();
  let pages = 0;
  let totalRows = 0;

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

      const ts = Number(row.timestamp != null ? row.timestamp : row.ts);
      const trader = row.proxyWallet || row.proxy_wallet || row.wallet || row.user || row.maker_address || row.maker;
      if (!Number.isFinite(ts) || !trader) continue;

      const seconds = ts > 1e12 ? ts / 1000 : ts;

      if (seconds < start) {
        reachedOlderTrades = true;
        continue;
      }

      if (seconds >= end) continue;

      traders.add(String(trader).toLowerCase());
    }

    console.log(
      "Traders page=" + pages +
      " rows=" + rows.length +
      " totalRows=" + totalRows +
      " hasMore=" + Boolean(pagination.has_more) +
      " traders=" + traders.size
    );

    if (reachedOlderTrades || !pagination.has_more || !pagination.next_cursor) break;
    cursor = pagination.next_cursor;
  }

  console.log(
    "Period traders complete: pages=" + pages +
    " rows=" + totalRows +
    " result=" + traders.size
  );

  return traders;
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
  const traders = await getPeriodTraders(market.conditionId, start, snapshotTime + 1);
  const previousMarket = await getCurrentMarket(start - PERIOD);
  const previousPeriodTraders = await getPeriodTraders(previousMarket.conditionId, start - PERIOD, start);
  const nextUrl = POLY_URL + (start + PERIOD);

  const newTraders = [...traders].filter(function(trader) {
    return !previousPeriodTraders.has(trader);
  }).length;

  const previousNewTraders = Number(state.newTraders);
  const changePercent = Number.isFinite(previousNewTraders) && previousNewTraders > 0
    ? Math.min(100, ((newTraders - previousNewTraders) / previousNewTraders) * 100)
    : null;

  const comparison = Number.isFinite(previousNewTraders)
    ? (newTraders > previousNewTraders ? "MORE" : newTraders < previousNewTraders ? "LESS" : "SAME")
    : null;

  const nextState = {
    periodStart: start,
    snapshotOffset: TARGET_OFFSET,
    traders: traders.size,
    traderList: [...traders],
    newTraders: newTraders,
    previousNewTraders: Number.isFinite(previousNewTraders) ? previousNewTraders : null,
    updatedAt: new Date().toISOString()
  };

  const changeText = comparison === "MORE"
    ? "⬆️"
    : comparison === "LESS"
      ? "⬇️"
      : "➡️";

  const changePercentText = changePercent === null ? "" : " " + (changePercent >= 0 ? "+" : "") + changePercent.toFixed(2) + "%";

  const lines = [
    "🔥 BTC · 5M",
    "",
    "NEW TRADERS: " + new Intl.NumberFormat("en-US").format(newTraders),
    "PREVIOUS: " + new Intl.NumberFormat("en-US").format(previousNewTraders),
    "CHANGE: " + changeText + changePercentText,
    "",
    "➡️ NEXT · Polymarket 5M",
    nextUrl
  ];

  await sendTelegram(lines.join("\n"));
  console.log("Telegram sent for period=" + start + " new traders comparison=" + comparison);
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
