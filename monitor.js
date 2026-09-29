const fs = require("fs");
const path = require("path");
const http = require("http");

const VERSION = "16.4.0-FRESH-COIN";
const POLL_MS = 3000;
const FEED_URL = "https://marginpad.io/api/v1/feed";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const STATE_FILE = process.env.STATE_FILE || "/data/marginpad-liquidation-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/marginpad-liquidation.jsonl";
const MAX_SEEN = 10000;
const LOG_MAX_BYTES = 20 * 1024 * 1024;
const LOG_KEEP_BYTES = 10 * 1024 * 1024;
const FEED_SUMMARY_LOG_MS = 60000;

const LIQUIDATION_THRESHOLD = 13;

let state;
let pollRunning = false;
let collectionStartedAt = null;
let lastFeedSummaryLogAt = 0;

function nowIso() { return new Date().toISOString(); }
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function normalizeCoin(value) {
  let symbol = String(value ?? "UNKNOWN").trim().toUpperCase();
  if (!symbol) return "UNKNOWN";

  symbol = symbol.replace(/[\\s_/:.-]+/g, "");

  const suffixes = [
    "USDT", "USDC", "BUSD", "FDUSD", "USDE", "USD", "PERP", "SWAP"
  ];

  for (const suffix of suffixes) {
    if (symbol.endsWith(suffix) && symbol.length > suffix.length) {
      symbol = symbol.slice(0, -suffix.length);
      break;
    }
  }

  return symbol || "UNKNOWN";
}

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
    strategy: "MARGINPAD_13_PLUS_SAME_COIN",
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

function sideLabel(side) {
  const s = String(side || "").toLowerCase();
  if (s === "long" || s === "long_liquidated") return "LONG";
  if (s === "short" || s === "short_liquidated") return "SHORT";
  return String(side || "LIQUIDATED").toUpperCase();
}

function formatNumber(v, max = 8) {
  const n = num(v);
  return n === null ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: max });
}

function formatUsd(v) {
  const n = num(v);
  return n === null ? "—" : "$" + n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log("TELEGRAM_NOT_CONFIGURED");
    return false;
  }

  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(8000)
    });

    const body = await response.text();
    if (!response.ok) {
      log("TELEGRAM_ERROR", {
        status: response.status,
        body: body.slice(0, 1000)
      });
      return false;
    }

    return true;
  } catch (e) {
    log("TELEGRAM_ERROR", { error: String(e.message || e) });
    return false;
  }
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

function liquidationMessage(event) {
  const exchange = String(event.exchange ?? event.source ?? event.venue ?? "UNKNOWN").toUpperCase();
  const symbol = normalizeCoin(event.symbol ?? event.coin);
  const side = sideLabel(event.side);
  const price = formatNumber(event.price);
  const qty = formatNumber(event.qty ?? event.size);
  const notional = formatUsd(event.notional);
  const eventMs = getEventMs(event);
  const time = eventMs === null
    ? "—"
    : new Date(eventMs).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
        timeZone: "Europe/Kyiv"
      });

  return [
    "LIQUIDATION",
    exchange + " | " + symbol,
    side,
    "PRICE: " + price,
    "SIZE: " + qty,
    "VALUE: " + notional,
    time
  ].join("\n");
}

async function sendLiquidationAlert(event) {
  const sent = await sendTelegram(liquidationMessage(event));

  if (sent) {
    state.alertsSent = Number(state.alertsSent || 0) + 1;
  }

  const exchange = String(event.exchange ?? event.source ?? event.venue ?? "UNKNOWN").toLowerCase();
  const symbol = normalizeCoin(event.symbol ?? event.coin);

  log(sent ? "LIQUIDATION_ALERT_SENT" : "LIQUIDATION_ALERT_FAILED", {
    exchange,
    symbol,
    side: sideLabel(event.side),
    price: num(event.price),
    qty: num(event.qty ?? event.size),
    notional: num(event.notional),
    eventTs: num(event.ts ?? event.timestamp ?? event.time),
    sent
  });
}

function eventBatchMessage(events, freshByExchange, thresholdLabel, symbol) {
  const lines = [
    String(symbol || "ALERT").toUpperCase(),
    "FRESH: " + events.length,
  ];

  for (const [exchange, count] of Object.entries(freshByExchange)) {
    lines.push(exchange.toUpperCase() + " — " + count);
  }

  const newest = events
    .map(getEventMs)
    .filter(v => v !== null)
    .sort((a, b) => b - a)[0];

  if (newest !== undefined) {
    lines.push(new Date(newest).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "Europe/Kyiv"
    }));
  }

  return lines.join("\n");
}

async function processFeed() {
  const body = await fetchFeed();
  const events = normalizeFeed(body);

  const feedSources = {};
  const eventTimes = [];
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  let fresh = 0;
  const freshByExchange = {};
  const freshEvents = [];

  for (const event of events) {
    const rawSource = String(event?.exchange ?? event?.source ?? event?.venue ?? "UNKNOWN");
    feedSources[rawSource] = (feedSources[rawSource] || 0) + 1;

    const eventMs = getEventMs(event);
    if (eventMs !== null) eventTimes.push(eventMs);

    const key = eventKey(event);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    state.seen.push(key);
    if (state.seen.length > MAX_SEEN) {
      state.seen = state.seen.slice(-MAX_SEEN);
    }

    fresh++;
    freshEvents.push(event);
    freshByExchange[rawSource] = (freshByExchange[rawSource] || 0) + 1;

    state.lastEventTs = num(event.ts ?? event.timestamp ?? event.time);
    state.lastEventKey = key;
  }

  const eventTimeSummary = eventTimes.length
    ? {
        feed_oldest_event: new Date(Math.min(...eventTimes)).toISOString(),
        feed_newest_event: new Date(Math.max(...eventTimes)).toISOString()
      }
    : {
        feed_oldest_event: null,
        feed_newest_event: null
      };

  let alertSent = false;
  const freshBySymbol = {};

  for (const event of freshEvents) {
    const symbol = normalizeCoin(event.symbol ?? event.coin);
    if (!freshBySymbol[symbol]) freshBySymbol[symbol] = [];
    freshBySymbol[symbol].push(event);
  }

  const alertedSymbols = [];

  for (const [symbol, symbolEvents] of Object.entries(freshBySymbol)) {
    const xyzEvents = symbolEvents.filter(event =>
      String(event.exchange ?? event.source ?? event.venue ?? "").toLowerCase() === "xyz"
    );
    const regularEvents = symbolEvents.filter(event =>
      String(event.exchange ?? event.source ?? event.venue ?? "").toLowerCase() !== "xyz"
    );

    if (xyzEvents.length >= 2) {
      const xyzByExchange = { xyz: xyzEvents.length };
      const sent = await sendTelegram(
        eventBatchMessage(xyzEvents, xyzByExchange, "2+ XYZ", symbol)
      );

      if (sent) {
        state.alertsSent = Number(state.alertsSent || 0) + 1;
        alertSent = true;
      }

      alertedSymbols.push(symbol);

      log(sent ? "2_PLUS_XYZ_ALERT_SENT" : "2_PLUS_XYZ_ALERT_FAILED", {
        symbol,
        fresh_liquidations: xyzEvents.length,
        fresh_by_exchange: xyzByExchange,
        sent,
        rule: "2+ fresh XYZ liquidation events for one coin in 1 MarginPad polling cycle"
      });
    }

    if (regularEvents.length >= LIQUIDATION_THRESHOLD) {
      const symbolByExchange = {};
      for (const event of regularEvents) {
        const exchange = String(event.exchange ?? event.source ?? event.venue ?? "UNKNOWN");
        symbolByExchange[exchange] = (symbolByExchange[exchange] || 0) + 1;
      }

      const sent = await sendTelegram(
        eventBatchMessage(regularEvents, symbolByExchange, LIQUIDATION_THRESHOLD + "+", symbol)
      );

      if (sent) {
        state.alertsSent = Number(state.alertsSent || 0) + 1;
        alertSent = true;
      }

      if (!alertedSymbols.includes(symbol)) alertedSymbols.push(symbol);

      log(sent ? "13_PLUS_SAME_COIN_ALERT_SENT" : "13_PLUS_SAME_COIN_ALERT_FAILED", {
        symbol,
        fresh_liquidations: regularEvents.length,
        fresh_by_exchange: symbolByExchange,
        sent,
        rule: "13+ fresh liquidation events for one coin in 1 MarginPad polling cycle, excluding XYZ"
      });
    }
  }

  log("FEED_PROCESSED", {
    feed_events: events.length,
    feed_sources: feedSources,
    fresh_liquidations: fresh,
    fresh_by_exchange: freshByExchange,
    fresh_by_symbol: Object.fromEntries(
      Object.entries(freshBySymbol).map(([symbol, symbolEvents]) => [symbol, symbolEvents.length])
    ),
    alert_sent: alertSent,
    alerted_symbols: alertedSymbols,
    ...eventTimeSummary,
    strategy: "13+ fresh liquidation events for one coin / 1 polling cycle; XYZ exception at 2+"
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

  server.on("error", e => log("HEALTH_SERVER_ERROR", {
    error: String(e.message || e)
  }));

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
  state.strategy = "MARGINPAD_13_PLUS_SAME_COIN_XYZ_2PLUS_NO_COUNT_PHRASE";
  state.seen = Array.isArray(state.seen) ? state.seen : [];

  collectionStartedAt = nowIso();

  log("LIQUIDATION_MONITOR_STARTING", {
    buildSha: BUILD_SHA,
    strategy: state.strategy,
    source: FEED_URL,
    pollingMs: POLL_MS,
    threshold: LIQUIDATION_THRESHOLD,
    logMaxBytes: LOG_MAX_BYTES,
    feedSummaryLogMs: FEED_SUMMARY_LOG_MS,
    monitor: "MARGINPAD_13_PLUS_SAME_COIN_XYZ_2PLUS_NO_COUNT_PHRASE"
  });

  startHealth();
  poll();
}

process.on("SIGTERM", () => log("MONITOR_STOPPING"));
process.on("SIGINT", () => log("MONITOR_STOPPING"));

main();
