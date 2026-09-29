const fs = require("fs");
const path = require("path");
const http = require("http");

const VERSION = "10.0.0-CASCADE16";
const POLL_MS = 3000;
const CASCADE_MIN_EVENTS = 16;
const CASCADE_GAP_MS = 3000;
const FEED_URL = "https://marginpad.io/api/v1/feed";
const EXCHANGE = "hyperliquid";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const STATE_FILE = process.env.STATE_FILE || "/data/marginpad-liquidation-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/marginpad-liquidation.jsonl";
const MAX_SEEN = 10000;

let state;
let pollRunning = false;
let collectionStartedAt = null;

function nowIso() { return new Date().toISOString(); }
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }

function log(event, data = {}) {
  const row = { ts: nowIso(), version: VERSION, event, ...data };
  console.log(JSON.stringify(row));
  try {
    ensureDir(LOG_FILE);
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + "\n");
  } catch {}
}

function defaultState() {
  return { version: VERSION, strategy: "MARGINPAD_HYPERLIQUID_CASCADES_16", updatedAt: nowIso(), seen: [], alertsSent: 0, lastEventTs: null, lastEventKey: null, cascades: {} };
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
  } catch (e) { log("STATE_WRITE_ERROR", { error: String(e.message || e) }); }
}

function eventKey(e) {
  const id = e.id ?? e.eventId ?? e.liquidationId;
  if (id !== undefined && id !== null && String(id) !== "") return "id:" + String(id);
  return [e.ts ?? e.timestamp ?? e.time ?? "", e.exchange ?? "", e.symbol ?? e.coin ?? "", e.side ?? "", e.price ?? "", e.qty ?? e.size ?? "", e.notional ?? ""].join("|");
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
  return n === null ? "—" : "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) { log("TELEGRAM_NOT_CONFIGURED"); return false; }
  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
    const body = await response.text();
    if (!response.ok) { log("TELEGRAM_ERROR", { status: response.status, body: body.slice(0, 1000) }); return false; }
    return true;
  } catch (e) { log("TELEGRAM_ERROR", { error: String(e.message || e) }); return false; }
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
  const response = await fetch(FEED_URL, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
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

function ensureCascade(symbol) {
  state.cascades = state.cascades || {};
  if (!state.cascades[symbol]) state.cascades[symbol] = { events: [], lastFreshAt: 0, lastAlertEventMs: 0 };
  return state.cascades[symbol];
}

async function flushFinishedCascades(now) {
  for (const [symbol, cascade] of Object.entries(state.cascades || {})) {
    if (!Array.isArray(cascade.events) || cascade.events.length < CASCADE_MIN_EVENTS) continue;
    if (!cascade.lastFreshAt || now - cascade.lastFreshAt < CASCADE_GAP_MS) continue;

    const events = cascade.events.slice();
    const latestEventMs = Math.max(...events.map(e => Number(e.eventMs) || 0));
    if (latestEventMs <= Number(cascade.lastAlertEventMs || 0)) {
      cascade.events = [];
      cascade.lastFreshAt = 0;
      continue;
    }

    const longCount = events.filter(e => e.side === "LONG").length;
    const shortCount = events.filter(e => e.side === "SHORT").length;
    const totalValue = events.reduce((sum, e) => sum + (Number(e.notional) || 0), 0);
    const totalQty = events.reduce((sum, e) => sum + (Number(e.qty) || 0), 0);
    const prices = events.map(e => e.price).filter(Number.isFinite);
    const minPrice = prices.length ? Math.min(...prices) : null;
    const maxPrice = prices.length ? Math.max(...prices) : null;

    const message = [
      symbol + " CASCADE",
      "EVENTS: " + events.length,
      "LONG: " + longCount + " | SHORT: " + shortCount,
      "VALUE: " + formatUsd(totalValue),
      "SIZE: " + formatNumber(totalQty),
      "PRICE RANGE: " + formatNumber(minPrice) + " - " + formatNumber(maxPrice)
    ].join("\n");

    const sent = await sendTelegram(message);
    if (sent) state.alertsSent = Number(state.alertsSent || 0) + 1;

    log(sent ? "LIQUIDATION_CASCADE_ALERT_SENT" : "LIQUIDATION_CASCADE_ALERT_FAILED", {
      exchange: EXCHANGE, symbol, events: events.length, longCount, shortCount,
      totalValue, totalQty, minPrice, maxPrice, gapMs: CASCADE_GAP_MS,
      lastEventTs: events[events.length - 1].eventTs
    });

    cascade.lastAlertEventMs = latestEventMs;
    cascade.events = [];
    cascade.lastFreshAt = 0;
  }
}

async function processFeed() {
  const body = await fetchFeed();
  const events = normalizeFeed(body);
  const exchangeCounts = {};
  for (const e of events) {
    const exchange = String(e?.exchange ?? e?.source ?? e?.venue ?? e?.market ?? "UNKNOWN").trim().toLowerCase() || "UNKNOWN";
    exchangeCounts[exchange] = (exchangeCounts[exchange] || 0) + 1;
  }
  const hyperliquid = events.filter(e => String(e?.exchange ?? e?.source ?? e?.venue ?? "").toLowerCase() === EXCHANGE);
  if (hyperliquid.length === 0) {
    log("FEED_NO_HYPERLIQUID", {
      received: events.length,
      exchangeCounts,
      sample: events.slice(0, 5)
    });
  }
  hyperliquid.sort((a, b) => (getEventMs(a) || 0) - (getEventMs(b) || 0));

  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  let fresh = 0;
  const now = Date.now();

  for (const event of hyperliquid) {
    const eventMs = getEventMs(event);
    if (eventMs === null) continue;
    const key = eventKey(event);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    state.seen.push(key);
    if (state.seen.length > MAX_SEEN) state.seen = state.seen.slice(-MAX_SEEN);
    fresh++;

    const symbol = String(event.symbol || event.coin || "UNKNOWN").toUpperCase();
    const cascade = ensureCascade(symbol);
    const lastEvent = cascade.events[cascade.events.length - 1];

    if (lastEvent && eventMs - Number(lastEvent.eventMs) > CASCADE_GAP_MS) {
      if (cascade.events.length < CASCADE_MIN_EVENTS) log("CASCADE_IGNORED", { exchange: EXCHANGE, symbol, events: cascade.events.length, required: CASCADE_MIN_EVENTS });
      cascade.events = [];
      cascade.lastFreshAt = 0;
    }

    cascade.events.push({
      eventMs,
      eventTs: num(event.ts ?? event.timestamp ?? event.time),
      side: sideLabel(event.side),
      price: num(event.price),
      qty: num(event.qty ?? event.size),
      notional: num(event.notional)
    });
    cascade.lastFreshAt = now;

    log("LIQUIDATION_RAW_EVENT", { exchange: EXCHANGE, symbol, rawEvent: event, cascadeEvents: cascade.events.length, required: CASCADE_MIN_EVENTS });

    if (cascade.events.length < CASCADE_MIN_EVENTS) {
      log("LIQUIDATION_BELOW_CASCADE_THRESHOLD", { exchange: EXCHANGE, symbol, events: cascade.events.length, required: CASCADE_MIN_EVENTS });
    } else {
      log("CASCADE_PENDING", { exchange: EXCHANGE, symbol, events: cascade.events.length, waitAfterLastPollMs: CASCADE_GAP_MS });
    }
  }

  await flushFinishedCascades(Date.now());
  log("FEED_PROCESSED", { received: events.length, hyperliquid: hyperliquid.length, fresh });
  saveState();
}

function diagnostics() {
  const pending = {};
  for (const [symbol, cascade] of Object.entries(state.cascades || {})) {
    if (Array.isArray(cascade.events) && cascade.events.length) pending[symbol] = cascade.events.length;
  }
  return {
    status: "ok", version: VERSION, buildSha: BUILD_SHA, strategy: state.strategy,
    exchange: EXCHANGE, pollingMs: POLL_MS, cascadeMinEvents: CASCADE_MIN_EVENTS,
    cascadeGapMs: CASCADE_GAP_MS, feed: FEED_URL, collectionStartedAt,
    updatedAt: state.updatedAt, alertsSent: state.alertsSent,
    lastEventTs: state.lastEventTs, lastEventKey: state.lastEventKey,
    seenEvents: state.seen.length, pendingCascades: pending
  };
}

function startHealth() {
  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((req, res) => {
    const requestPath = String(req.url || "/").split("?")[0];
    if (requestPath === "/" || requestPath === "/health" || requestPath === "/status") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify(diagnostics()));
    }
    if (requestPath === "/logs") {
      let rows = [];
      try { rows = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean).slice(-300).map(x => JSON.parse(x)); }
      catch (e) { rows = [{ event: "LOG_READ_ERROR", error: String(e.message || e) }]; }
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify({ status: "ok", events: rows }));
    }
    res.writeHead(404);
    res.end();
  });
  server.on("error", e => log("HEALTH_SERVER_ERROR", { error: String(e.message || e) }));
  server.listen(port, "0.0.0.0", () => log("HEALTH_LISTENING", { port, healthPath: "/health" }));
}

async function poll() {
  if (pollRunning) return;
  pollRunning = true;
  try { await processFeed(); }
  catch (e) { log("POLL_ERROR", { error: String(e.stack || e) }); }
  finally { pollRunning = false; setTimeout(poll, POLL_MS); }
}

function main() {
  ensureDir(STATE_FILE);
  ensureDir(LOG_FILE);
  state = loadState();
  state.version = VERSION;
  state.strategy = "MARGINPAD_HYPERLIQUID_CASCADES_16";
  state.seen = Array.isArray(state.seen) ? state.seen : [];
  state.cascades = state.cascades && typeof state.cascades === "object" ? state.cascades : {};
  collectionStartedAt = nowIso();
  log("LIQUIDATION_MONITOR_STARTING", {
    buildSha: BUILD_SHA, strategy: state.strategy, source: FEED_URL,
    exchange: EXCHANGE, pollingMs: POLL_MS, cascadeMinEvents: CASCADE_MIN_EVENTS,
    cascadeGapMs: CASCADE_GAP_MS, monitor: "MARGINPAD_HYPERLIQUID_CASCADE_16"
  });
  startHealth();
  poll();
}

process.on("SIGTERM", () => log("MONITOR_STOPPING"));
process.on("SIGINT", () => log("MONITOR_STOPPING"));
main();
