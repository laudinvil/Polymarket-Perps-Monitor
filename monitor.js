const fs = require("fs");
const path = require("path");
const http = require("http");

const VERSION = "20.3.0-5PLUS-PER-SYMBOL";
const POLL_MS = 3000;
const FEED_URL = "https://marginpad.io/api/v1/feed";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const STATE_FILE = process.env.STATE_FILE || "/data/marginpad-liquidation-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/marginpad-liquidation.jsonl";
const MAX_SEEN = 10000;
const LOG_MAX_BYTES = 20 * 1024 * 1024;
const LOG_KEEP_BYTES = 10 * 1024 * 1024;
const FEED_SUMMARY_LOG_MS = 60000;

let state;
let pollRunning = false;
let collectionStartedAt = null;
let lastFeedSummaryLogAt = 0;

function nowIso() { return new Date().toISOString(); }
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function appendLogRow(row) {
  try {
    ensureDir(LOG_FILE);
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + "\n");
    try {
      const size = fs.statSync(LOG_FILE).size;
      if (size > LOG_MAX_BYTES) {
        const fd = fs.openSync(LOG_FILE, "r");
        const buffer = Buffer.alloc(LOG_KEEP_BYTES);
        fs.readSync(fd, buffer, 0, LOG_KEEP_BYTES, Math.max(0, size - LOG_KEEP_BYTES));
        fs.closeSync(fd);
        const start = buffer.indexOf(0x0a);
        const kept = start >= 0 ? buffer.subarray(start + 1) : buffer;
        fs.writeFileSync(LOG_FILE, kept);
      }
    } catch {}
  } catch {}
}

function log(event, data = {}) {
  if (event === "FEED_PROCESSED") {
    const now = Date.now();
    if (now - lastFeedSummaryLogAt < FEED_SUMMARY_LOG_MS) return;
    lastFeedSummaryLogAt = now;
  }
  const row = { ts: nowIso(), version: VERSION, event, ...data };
  console.log(JSON.stringify(row));
  appendLogRow(row);
}

function defaultState() {
  return {
    version: VERSION,
    strategy: "MARGINPAD_5_PLUS_PER_SYMBOL_PER_POLL",
    updatedAt: nowIso(),
    seen: [],
    alertsSent: 0,
    lastEventTs: null,
    lastEventKey: null
  };
}

function loadState() {
  try {
    const value = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (value && typeof value === "object") return value;
  } catch {}
  return defaultState();
}

function saveState() {
  state.updatedAt = nowIso();
  try {
    ensureDir(STATE_FILE);
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    log("STATE_WRITE_ERROR", { error: String(e.message || e) });
  }
}

function eventKey(e) {
  const id = e.id ?? e.eventId ?? e.liquidationId;
  if (id !== undefined && id !== null && String(id) !== "") return "id:" + String(id);
  return [
    e.ts ?? e.timestamp ?? e.time ?? "",
    e.exchange ?? e.source ?? e.venue ?? "",
    e.symbol ?? e.coin ?? "",
    e.side ?? "",
    e.price ?? "",
    e.qty ?? e.size ?? "",
    e.notional ?? ""
  ].join("|");
}

function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    log("TELEGRAM_NOT_CONFIGURED");
    return Promise.resolve(false);
  }

  return fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    }),
    signal: AbortSignal.timeout(8000)
  }).then(async response => {
    const body = await response.text();
    if (!response.ok) {
      log("TELEGRAM_ERROR", { status: response.status, body: body.slice(0, 1000) });
      return false;
    }
    return true;
  }).catch(e => {
    log("TELEGRAM_ERROR", { error: String(e.message || e) });
    return false;
  });
}

function normalizeFeed(body) {
  if (!body || typeof body !== "object") return [];
  if (Array.isArray(body.events)) return body.events;
  if (Array.isArray(body.data)) return body.data;
  if (body.data && Array.isArray(body.data.events)) return body.data.events;
  if (Array.isArray(body.result)) return body.result;
  return [];
}

async function fetchFeed() {
  const response = await fetch(FEED_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error("HTTP " + response.status + " " + body.slice(0, 300));
  }
  return response.json();
}

function getEventMs(event) {
  const raw = num(event.ts ?? event.timestamp ?? event.time);
  if (raw === null) return null;
  return raw < 1e12 ? raw * 1000 : raw;
}

function formatNumber(value, decimals = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  });
}

function formatCompactNumber(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const n = Number(value);
  if (Number.isInteger(n)) return n.toLocaleString("en-US");
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2
  });
}

function eventBatchMessage(events) {
  const bySymbol = {};
  for (const event of events) {
    const symbol = String(event?.symbol ?? event?.coin ?? "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
    if (!bySymbol[symbol]) bySymbol[symbol] = [];
    bySymbol[symbol].push(event);
  }

  const symbolBlocks = Object.entries(bySymbol)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([symbol, symbolEvents]) => {
      let longCount = 0;
      let shortCount = 0;
      let value = 0;
      let size = 0;
      const prices = [];
      const byExchange = {};

      for (const event of symbolEvents) {
        const side = String(event.side ?? event.direction ?? "").toUpperCase();
        if (side === "LONG" || side === "BUY") longCount++;
        else if (side === "SHORT" || side === "SELL") shortCount++;
        else log("UNKNOWN_LIQUIDATION_SIDE", {
          symbol,
          side: String(event.side ?? event.direction ?? ""),
          event_key: eventKey(event)
        });

        const notional = num(event.notional ?? event.value ?? event.amount);
        const qty = num(event.qty ?? event.size ?? event.quantity);
        const price = num(event.price);
        if (notional !== null) value += notional;
        if (qty !== null) size += qty;
        if (price !== null) prices.push(price);

        const exchange = String(event?.exchange ?? event?.source ?? event?.venue ?? "UNKNOWN").trim() || "UNKNOWN";
        byExchange[exchange] = (byExchange[exchange] || 0) + 1;
      }

      const exchangeLines = Object.entries(byExchange)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([exchange, count]) => exchange.toUpperCase() + ": " + count);

      const priceRange = prices.length
        ? Math.min(...prices).toLocaleString("en-US", { maximumFractionDigits: 8 }) +
          " - " + Math.max(...prices).toLocaleString("en-US", { maximumFractionDigits: 8 })
        : "—";

      return [
        symbol,
        "EVENTS: " + symbolEvents.length,
        "LONG: " + longCount + " | SHORT: " + shortCount,
        "VALUE: $" + formatNumber(value, 2),
        "SIZE: " + formatCompactNumber(size),
        "PRICE RANGE: " + priceRange,
        ...exchangeLines
      ].join("\n");
    });

  return symbolBlocks.join("\n\n");
}
async function processFeed() {
  const body = await fetchFeed();
  const events = normalizeFeed(body);

  const feedSources = {};
  const eventTimes = [];
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  const freshEvents = [];
  const freshByExchange = {};
  const freshBySymbol = {};
  const freshEventsBySymbol = {};
  let fresh = 0;

  for (const event of events) {
    const rawSource = String(event?.exchange ?? event?.source ?? event?.venue ?? "UNKNOWN");
    feedSources[rawSource] = (feedSources[rawSource] || 0) + 1;

    const eventMs = getEventMs(event);
    if (eventMs !== null) eventTimes.push(eventMs);

    const key = eventKey(event);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    state.seen.push(key);
    if (state.seen.length > MAX_SEEN) state.seen = state.seen.slice(-MAX_SEEN);

    fresh++;
    freshEvents.push(event);
    freshByExchange[rawSource] = (freshByExchange[rawSource] || 0) + 1;

    const symbol = String(event.symbol ?? event.coin ?? "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
    freshBySymbol[symbol] = (freshBySymbol[symbol] || 0) + 1;
    if (!freshEventsBySymbol[symbol]) freshEventsBySymbol[symbol] = [];
    freshEventsBySymbol[symbol].push(event);

    state.lastEventTs = num(event.ts ?? event.timestamp ?? event.time);
    state.lastEventKey = key;
  }

  let alertSent = false;
  let alertsSentThisCycle = 0;
  const eligibleBySymbol = {};
  const skippedBySymbol = {};

  // HARD RULE: threshold is per symbol, per single MarginPad poll.
  // Never accumulate events across polls. Never trigger on total feed count.
  for (const [symbol, symbolEvents] of Object.entries(freshEventsBySymbol)) {
    if (symbolEvents.length < 5) {
      skippedBySymbol[symbol] = {
        events: symbolEvents.length,
        required: 5,
        reason: "LESS_THAN_5_FRESH_EVENTS_IN_SINGLE_POLL"
      };
      continue;
    }

    const classified = symbolEvents.filter(event => {
      const side = String(event.side ?? event.direction ?? "").toUpperCase();
      return side === "LONG" || side === "SHORT" || side === "BUY" || side === "SELL";
    });

    if (classified.length === 0) {
      skippedBySymbol[symbol] = {
        events: symbolEvents.length,
        required: 5,
        reason: "NO_CLASSIFIED_LONG_SHORT_EVENTS"
      };
      log("ALERT_SKIPPED", {
        symbol,
        events: symbolEvents.length,
        reason: "NO_CLASSIFIED_LONG_SHORT_EVENTS"
      });
      continue;
    }

    eligibleBySymbol[symbol] = symbolEvents;
    const sent = await sendTelegram(eventBatchMessage(symbolEvents));
    if (sent) {
      state.alertsSent = Number(state.alertsSent || 0) + 1;
      alertsSentThisCycle++;
      alertSent = true;
    }

    log(sent ? "SYMBOL_ALERT_SENT" : "SYMBOL_ALERT_FAILED", {
      symbol,
      events: symbolEvents.length,
      sent,
      rule: "5+ fresh liquidation events for this symbol in ONE MarginPad poll"
    });
  }

  log("ALERT_GROUPING", {
    fresh_events: freshEvents.length,
    eligible_by_symbol: Object.fromEntries(Object.entries(eligibleBySymbol).map(([k,v]) => [k, v.length])),
    skipped_by_symbol: skippedBySymbol,
    fresh_by_symbol: freshBySymbol,
    alerts_sent_this_cycle: alertsSentThisCycle,
    rule: "ONE RAW EVENT PER TELEGRAM ALERT; NO AGGREGATION"
  });
  const eventTimeSummary = eventTimes.length
    ? {
        feed_oldest_event: new Date(Math.min(...eventTimes)).toISOString(),
        feed_newest_event: new Date(Math.max(...eventTimes)).toISOString()
      }
    : { feed_oldest_event: null, feed_newest_event: null };

  log("FEED_PROCESSED", {
    feed_events: events.length,
    feed_sources: feedSources,
    fresh_liquidations: fresh,
    fresh_by_exchange: freshByExchange,
    fresh_by_symbol: freshBySymbol,
    alert_sent: alertSent,
    ...eventTimeSummary,
    strategy: "5+ fresh liquidations for one symbol / 1 polling cycle; no accumulation across polls"
  });

  saveState();
}

function diagnostics() {
  return {
    status: "ok",
    version: VERSION,
    buildSha: BUILD_SHA,
    strategy: state.strategy,
    pollingMs: POLL_MS,
    feed: FEED_URL,
    collectionStartedAt,
    updatedAt: state.updatedAt,
    alertsSent: state.alertsSent,
    lastEventTs: state.lastEventTs,
    lastEventKey: state.lastEventKey,
    seenEvents: state.seen.length
  };
}

function startHealth() {
  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((req, res) => {
    const requestPath = String(req.url || "/").split("?")[0];

    if (requestPath === "/" || requestPath === "/health" || requestPath === "/status") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      return res.end(JSON.stringify(diagnostics()));
    }

    if (requestPath === "/logs") {
      let rows = [];
      try {
        rows = fs.readFileSync(LOG_FILE, "utf8")
          .split("\n")
          .filter(Boolean)
          .slice(-300)
          .map(x => JSON.parse(x));
      } catch (e) {
        rows = [{ event: "LOG_READ_ERROR", error: String(e.message || e) }];
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      return res.end(JSON.stringify({ status: "ok", events: rows }));
    }

    res.writeHead(404);
    res.end();
  });

  server.on("error", e => log("HEALTH_SERVER_ERROR", { error: String(e.message || e) }));
  server.listen(port, "0.0.0.0", () => log("HEALTH_LISTENING", {
    port,
    healthPath: "/health"
  }));
}

async function poll() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    await processFeed();
  } catch (e) {
    log("POLL_ERROR", { error: String(e.stack || e) });
  } finally {
    pollRunning = false;
    setTimeout(poll, POLL_MS);
  }
}

function main() {
  ensureDir(STATE_FILE);
  ensureDir(LOG_FILE);

  state = loadState();
  state.version = VERSION;
  state.strategy = "MARGINPAD_5_PLUS_PER_SYMBOL_PER_POLL";
  state.seen = Array.isArray(state.seen) ? state.seen : [];
  collectionStartedAt = nowIso();

  log("LIQUIDATION_MONITOR_STARTING", {
    buildSha: BUILD_SHA,
    strategy: state.strategy,
    source: FEED_URL,
    pollingMs: POLL_MS,
    logMaxBytes: LOG_MAX_BYTES,
    feedSummaryLogMs: FEED_SUMMARY_LOG_MS,
    monitor: "MARGINPAD_5_PLUS_PER_SYMBOL_PER_POLL"
  });

  startHealth();
  poll();
}

process.on("SIGTERM", () => log("MONITOR_STOPPING"));
process.on("SIGINT", () => log("MONITOR_STOPPING"));

main();
