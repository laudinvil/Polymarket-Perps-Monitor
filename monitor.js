const fs = require("fs");
const path = require("path");
const http = require("http");

const VERSION = "9.0.0";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const POLL_MS = 3000;
const FEED_URL = "https://marginpad.io/api/v1/feed";
const EXCHANGE = "hyperliquid";
const STATE_FILE = process.env.STATE_FILE || "/data/marginpad-liquidation-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/marginpad-liquidation.jsonl";
const MAX_SEEN = 10000;

let state = null;
let pollRunning = false;
let collectionStartedAt = null;

function nowIso() { return new Date().toISOString(); }
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

function log(event, data = {}) {
  const row = { ts: nowIso(), version: VERSION, event, ...data };
  console.log(JSON.stringify(row));
  try {
    ensureDir(LOG_FILE);
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + "\n");
  } catch {}
}

function defaultState() {
  return {
    version: VERSION,
    strategy: "MARGINPAD_HYPERLIQUID_ALL_LIQUIDATIONS",
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

function seenSet() {
  return new Set(Array.isArray(state.seen) ? state.seen : []);
}

function remember(key) {
  state.seen = Array.isArray(state.seen) ? state.seen : [];
  state.seen.push(key);
  if (state.seen.length > MAX_SEEN) state.seen = state.seen.slice(-MAX_SEEN);
}

function eventKey(e) {
  // MarginPad's feed is an observed liquidation stream. Prefer a native id
  // when present; otherwise use the complete event fingerprint.
  const nativeId = e.id ?? e.eventId ?? e.liquidationId;
  if (nativeId !== undefined && nativeId !== null && String(nativeId) !== "") {
    return "id:" + String(nativeId);
  }
  return [
    e.ts ?? e.timestamp ?? "",
    e.exchange ?? "",
    e.symbol ?? "",
    e.side ?? "",
    e.price ?? "",
    e.qty ?? e.size ?? "",
    e.notional ?? ""
  ].join("|");
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatUsd(v) {
  const n = num(v);
  if (n === null) return "—";
  return "$" + n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatPrice(v) {
  const n = num(v);
  if (n === null) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8
  });
}

function formatQty(v) {
  const n = num(v);
  if (n === null) return "—";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 8
  });
}

function eventTime(e) {
  const raw = num(e.ts ?? e.timestamp ?? e.time);
  if (raw === null) return "—";
  const ms = raw < 1e12 ? raw * 1000 : raw;
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour12: false,
    timeZone: "Europe/Kyiv"
  });
}

function sideLabel(side) {
  const s = String(side || "").toLowerCase();
  if (s === "long_liquidated" || s === "long") return "LONG";
  if (s === "short_liquidated" || s === "short") return "SHORT";
  return String(side || "LIQUIDATED").toUpperCase();
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
      log("TELEGRAM_ERROR", { status: response.status, body: body.slice(0, 1000) });
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

async function processFeed() {
  const body = await fetchFeed();
  const events = normalizeFeed(body);
  const seen = seenSet();

  const hyperliquid = events.filter(e =>
    String(e?.exchange || "").toLowerCase() === EXCHANGE
  );

  hyperliquid.sort((a, b) =>
    (num(a.ts ?? a.timestamp ?? a.time) || 0) -
    (num(b.ts ?? b.timestamp ?? b.time) || 0)
  );

  let fresh = 0;

  for (const event of hyperliquid) {
    const rawTs = num(event.ts ?? event.timestamp ?? event.time);
    const eventMs = rawTs === null ? null : (rawTs < 1e12 ? rawTs * 1000 : rawTs);
    if (eventMs === null) continue;
    const key = eventKey(event);
    if (!key || seen.has(key)) continue;

    remember(key);
    seen.add(key);
    fresh++;

    const symbol = String(event.symbol || event.coin || "UNKNOWN").toUpperCase();
    const side = sideLabel(event.side);
    const price = formatPrice(event.price);
    const qty = formatQty(event.qty ?? event.size);
    const notional = formatUsd(event.notional);
    const message = [
      symbol + " " + side,
      "PRICE: " + price,
      "SIZE: " + qty,
      "VALUE: " + notional
    ].join("\n");

    log("LIQUIDATION_RAW_EVENT", {\n      exchange: EXCHANGE,\n      symbol,\n      event: event\n    });\n\n    const sent = await sendTelegram(message);

    state.alertsSent = Number(state.alertsSent || 0) + (sent ? 1 : 0);
    state.lastEventTs = event.ts ?? event.timestamp ?? event.time ?? null;
    state.lastEventKey = key;

    log(sent ? "LIQUIDATION_ALERT_SENT" : "LIQUIDATION_ALERT_FAILED", {
      exchange: EXCHANGE,
      symbol,
      side: event.side,
      price: event.price ?? null,
      qty: event.qty ?? event.size ?? null,
      notional: event.notional ?? null,
      eventTs: event.ts ?? event.timestamp ?? event.time ?? null,
      eventKey: key
    });

    saveState();
  }

  if (fresh > 0) {
    log("FEED_PROCESSED", {
      received: events.length,
      hyperliquid: hyperliquid.length,
      fresh
    });
  }
}

function runtimeDiagnostics() {
  return {
    status: "ok",
    version: VERSION,
    buildSha: BUILD_SHA,
    strategy: state.strategy,
    exchange: EXCHANGE,
    pollingMs: POLL_MS,
    feed: FEED_URL,
    collectionStartedAt,
    updatedAt: state.updatedAt,
    alertsSent: state.alertsSent,
    lastEventTs: state.lastEventTs,
    lastEventKey: state.lastEventKey,
    seenEvents: Array.isArray(state.seen) ? state.seen.length : 0
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
      return res.end(JSON.stringify(runtimeDiagnostics()));
    }

    if (requestPath === "/logs") {
      const url = new URL(req.url || "/logs", "http://127.0.0.1");
      const requested = Number(url.searchParams.get("lines") || 300);
      const lines = Math.max(1, Math.min(1000, Number.isFinite(requested) ? requested : 300));
      let rows = [];
      try {
        rows = fs.readFileSync(LOG_FILE, "utf8")
          .split("\n")
          .filter(Boolean)
          .slice(-lines)
          .map(x => {
            try { return JSON.parse(x); } catch { return { raw: x }; }
          });
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
  server.listen(port, "0.0.0.0", () =>
    log("HEALTH_LISTENING", { port, healthPath: "/health" })
  );
}

async function poll() {
  if (pollRunning) return;
  pollRunning = true;
  const started = Date.now();
  try {
    await processFeed();
  } catch (e) {
    log("POLL_ERROR", { error: String(e.stack || e) });
  } finally {
    pollRunning = false;
    const elapsedMs = Date.now() - started;
    setTimeout(poll, Math.max(0, POLL_MS - elapsedMs));
  }
}

async function main() {
  ensureDir(STATE_FILE);
  ensureDir(LOG_FILE);

  state = loadState();
  if (state.version !== VERSION) {
    const previous = state.version || "unknown";
    state.version = VERSION;
    state.strategy = "MARGINPAD_HYPERLIQUID_ALL_LIQUIDATIONS";
    log("VERSION_CHANGE", { from: previous, to: VERSION });
    saveState();
  }

  collectionStartedAt = nowIso();

  log("LIQUIDATION_MONITOR_STARTING", {
    version: VERSION,
    buildSha: BUILD_SHA,
    strategy: "MARGINPAD_HYPERLIQUID_ALL_LIQUIDATIONS",
    monitor: "MARGINPAD_HYPERLIQUID_ONLY",
    source: FEED_URL,
    exchange: EXCHANGE,
    pollingMs: POLL_MS,
    allSymbols: true,
    links: false,
    persistentState: true,
    sharedDedupe: false
  });

  startHealth();
  await poll();
  setInterval(() => {
    log("HEARTBEAT", runtimeDiagnostics());
  }, 60_000);
}

function shutdown() {
  log("MONITOR_STOPPING");
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

main().catch(e => {
  log("FATAL", { error: String(e.stack || e) });
  process.exit(1);
});
