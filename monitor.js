const fs = require("fs");
const path = require("path");
const http = require("http");

const VERSION = "26.1.0-AGGR-CLEAN";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const AGGR_URL = process.env.AGGR_URL || "http://127.0.0.1:9090/liquidations";
const STATE_FILE = process.env.STATE_FILE || "/data/aggr-liquidation-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/aggr-liquidation.jsonl";
const SYMBOLS = new Set(["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE"]);
const MAX_SEEN = 10000;
const MAX_ALERTED_LINKS = 10000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_BYTES = 1 * 1024 * 1024;
const FEED_SUMMARY_LOG_MS = 60000;
const LIQUIDATION_VALUE_THRESHOLD = 500000;

let state;
let bucket = [];
let groupTimer = null;
let aggrConnected = false;
let aggrEvents = 0;
let aggrLastEventAt = null;
let aggrReconnectTimer = null;
let skippedEvents = 0;
let ignoredEvents = 0;
let acceptedSinceSummary = 0;
let aggrRequest = null;
let alertInFlight = new Set();

function nowIso() { return new Date().toISOString(); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

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
        fs.writeFileSync(LOG_FILE, start >= 0 ? buffer.subarray(start + 1) : buffer);
      }
    } catch {}
  } catch {}
}

let lastFeedSummaryLogAt = 0;
function log(event, data = {}) {
  if (event === "FEED_STATUS") {
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
    strategy: "AGGR_LIQUIDATIONS",
    updatedAt: nowIso(),
    seen: [],
    alertedLinks: [],
    alertedPeriodKey: null,
    alertsSent: 0,
    valueBySymbol: {},
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
    body: JSON.stringify({ chat_id: chatId, text }),
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

function polymarket5mUrl(symbol, nowMs = Date.now()) {
  const startEpoch = Math.floor(nowMs / 300000) * 300;
  return "https://polymarket.com/event/" + symbol.toLowerCase() + "-updown-5m-" + startEpoch;
}

async function fetchPolymarketClobPrices(symbol, nowMs = Date.now()) {
  const slug = symbol.toLowerCase() + "-updown-5m-" + (Math.floor(nowMs / 300000) * 300);
  try {
    const gammaResponse = await fetch(
      "https://gamma-api.polymarket.com/events?slug=" + encodeURIComponent(slug),
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000) }
    );
    if (!gammaResponse.ok) throw new Error("Gamma HTTP " + gammaResponse.status);
    const gammaBody = await gammaResponse.json();
    const event = Array.isArray(gammaBody) ? gammaBody[0] : gammaBody;
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    const market = markets.find(m => !m.closed && m.active !== false) || markets[0];
    if (!market) throw new Error("market not found");

    let tokenIds = market.clobTokenIds;
    if (typeof tokenIds === "string") tokenIds = JSON.parse(tokenIds);
    if (!Array.isArray(tokenIds) || tokenIds.length < 2) throw new Error("CLOB token IDs not found");

    const [upResponse, downResponse] = await Promise.all([
      fetch("https://clob.polymarket.com/midpoint?token_id=" + encodeURIComponent(tokenIds[0]), {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000)
      }),
      fetch("https://clob.polymarket.com/midpoint?token_id=" + encodeURIComponent(tokenIds[1]), {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(5000)
      })
    ]);
    if (!upResponse.ok || !downResponse.ok) {
      throw new Error("CLOB HTTP " + upResponse.status + "/" + downResponse.status);
    }
    const [upBody, downBody] = await Promise.all([upResponse.json(), downResponse.json()]);
    const up = num(upBody?.mid);
    const down = num(downBody?.mid);
    if (up === null || down === null) throw new Error("CLOB midpoint missing");
    return { up, down, slug };
  } catch (e) {
    log("POLYMARKET_CLOB_PRICE_ERROR", { symbol, slug, error: String(e.message || e) });
    return null;
  }
}

function eventKey(e) {
  if (e.id != null && String(e.id)) return "aggr:" + String(e.exchange || "") + ":" + String(e.id);
  return [
    e.ts || e.timestamp || "",
    e.exchange || "",
    e.symbol || e.pair || "",
    e.side || "",
    e.price || "",
    e.qty || e.size || ""
  ].join("|");
}

function normalizeAggrEvent(raw) {
  const symbol = String(raw?.symbol || raw?.pair || "").toUpperCase()
    .replace(/USDT|USDC|USD|PERP|[-_]/g, "")
    .replace("SWAP", "");
  if (!SYMBOLS.has(symbol)) return null;

  const side = String(raw?.side || "").toLowerCase();
  if (side !== "buy" && side !== "sell") return null;

  const price = num(raw?.price);
  const qty = num(raw?.size ?? raw?.qty ?? raw?.amount);
  if (price === null || qty === null || qty <= 0) return null;

  const ts = num(raw?.timestamp ?? raw?.ts ?? raw?.time) ?? Date.now();
  const exchange = String(raw?.exchange || "AGGR").toUpperCase();

  return {
    id: raw?.id == null ? "" : String(raw.id),
    ts: ts < 1e12 ? ts * 1000 : ts,
    exchange,
    symbol,
    side,
    price,
    qty,
    notional: price * qty
  };
}

async function recordLiquidations(events) {
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);
  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    state.seen.push(key);
    state.valueBySymbol[event.symbol] = Number(state.valueBySymbol[event.symbol] || 0) + event.notional;
    acceptedSinceSummary++;

    if (state.valueBySymbol[event.symbol] < LIQUIDATION_VALUE_THRESHOLD) continue;

    await flushValueAlert(event.symbol, event);
  }
  if (state.seen.length > MAX_SEEN) state.seen.splice(0, state.seen.length - MAX_SEEN);
  saveState();
}

async function flushValueAlert(symbol, triggerEvent) {
  const value = Number(state.valueBySymbol[symbol] || 0);
  if (value < LIQUIDATION_VALUE_THRESHOLD) return;

  const marketNowMs = Date.now();
  const link = polymarket5mUrl(symbol, marketNowMs);

  if (state.alertedLinks.includes(link) || alertInFlight.has(link)) {
    return;
  }

  alertInFlight.add(link);
  try {
    const clob = await fetchPolymarketClobPrices(symbol, marketNowMs);
    if (clob && (clob.up < 0.20 || clob.up > 0.80 || clob.down < 0.20 || clob.down > 0.80)) {
      skippedEvents++;
      return;
    }

    const clobLine = clob
      ? "UP: " + clob.up.toFixed(3) + " | DOWN: " + clob.down.toFixed(3)
      : "UP: — | DOWN: —";
    const directionArrow = clob ? (clob.up <= clob.down ? "⬆️" : "⬇️") : "";

    const text = [
      symbol + (directionArrow ? " " + directionArrow : ""),
      "VALUE: $" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
      clobLine,
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
      }).format(new Date(triggerEvent.ts)),
      link
    ].join("\n");

    const sent = await sendTelegram(text);
    log(sent ? "LIQUIDATION_ALERT_SENT" : "LIQUIDATION_ALERT_FAILED", {
      source: "AGGR",
      symbol,
      value,
      dedupeKey: link
    });

    if (sent) {
      state.alertsSent = Number(state.alertsSent || 0) + 1;
      state.alertedLinks.push(link);
      if (state.alertedLinks.length > MAX_ALERTED_LINKS) {
        state.alertedLinks.splice(0, state.alertedLinks.length - MAX_ALERTED_LINKS);
      }
      state.valueBySymbol[symbol] = 0;
      state.lastEventTs = triggerEvent.ts;
      state.lastEventKey = eventKey(triggerEvent);
      saveState();
    }
  } finally {
    alertInFlight.delete(link);
  }
}

function connectAggr() {
  if (aggrRequest) {
    try { aggrRequest.destroy(); } catch {}
    aggrRequest = null;
  }

  log("AGGR_CONNECTING", { url: AGGR_URL });

  const req = http.get(AGGR_URL, response => {
    if (response.statusCode !== 200) {
      log("AGGR_HTTP_ERROR", { status: response.statusCode });
      response.resume();
      aggrConnected = false;
      scheduleAggrReconnect();
      return;
    }

    aggrConnected = true;
    log("AGGR_CONNECTED", { url: AGGR_URL });

    let buffer = "";
    response.setEncoding("utf8");

    response.on("data", chunk => {
      buffer += chunk;
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        const line = frame.split("\n").find(x => x.startsWith("data:"));
        if (!line) continue;
        try {
          const raw = JSON.parse(line.slice(5).trim());
          const event = normalizeAggrEvent(raw);
          if (!event) {
            ignoredEvents++;
            continue;
          }
          aggrEvents++;
          acceptedSinceSummary++;
          aggrLastEventAt = nowIso();
          recordLiquidations([event]).catch(e => log("LIQUIDATION_VALUE_ERROR", { error: String(e.stack || e) }));
        } catch (e) {
          log("AGGR_EVENT_PARSE_ERROR", { error: String(e.message || e), frame: frame.slice(0, 1000) });
        }
      }
    });

    response.on("end", () => {
      aggrConnected = false;
      aggrRequest = null;
      log("AGGR_DISCONNECTED", { reason: "STREAM_END" });
      scheduleAggrReconnect();
    });
    response.on("error", e => {
      aggrConnected = false;
      aggrRequest = null;
      log("AGGR_STREAM_ERROR", { error: String(e.message || e) });
      scheduleAggrReconnect();
    });
  });

  aggrRequest = req;
  req.on("error", e => {
    aggrConnected = false;
    aggrRequest = null;
    log("AGGR_CONNECTION_ERROR", { error: String(e.message || e) });
    scheduleAggrReconnect();
  });
}

function scheduleAggrReconnect() {
  if (aggrReconnectTimer) return;
  aggrReconnectTimer = setTimeout(() => {
    aggrReconnectTimer = null;
    connectAggr();
  }, 3000);
}

function diagnostics() {
  return {
    status: "ok",
    version: VERSION,
    buildSha: BUILD_SHA,
    strategy: state.strategy,
    source: "AGGR",
    aggrUrl: AGGR_URL,
    aggrConnected,
    aggrEvents,
    aggrLastEventAt,
    alertsSent: state.alertsSent,
    lastEventTs: state.lastEventTs,
    lastEventKey: state.lastEventKey,
    seenEvents: state.seen.length,
    valueBySymbol: state.valueBySymbol || {},
    alertedLinks: state.alertedLinks || [],
    liquidationValueThreshold: LIQUIDATION_VALUE_THRESHOLD
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
  server.listen(port, "0.0.0.0", () => log("HEALTH_LISTENING", { port, healthPath: "/health" }));
}

function main() {
  ensureDir(STATE_FILE);
  ensureDir(LOG_FILE);
  state = loadState();

  if (state.strategy !== "AGGR_LIQUIDATIONS" || state.version !== VERSION) {
    state.seen = [];
    state.alertedLinks = [];
    state.alertedPeriodKey = null;
    state.valueBySymbol = {};
    state.alertsSent = 0;
    state.lastEventTs = null;
    state.lastEventKey = null;
  }

  state.version = VERSION;
  state.strategy = "AGGR_LIQUIDATIONS";
  state.seen = Array.isArray(state.seen) ? state.seen : [];
  state.alertedLinks = Array.isArray(state.alertedLinks) ? state.alertedLinks : [];
  state.alertedPeriodKey = state.alertedPeriodKey == null ? null : String(state.alertedPeriodKey);
  state.valueBySymbol = state.valueBySymbol && typeof state.valueBySymbol === "object" ? state.valueBySymbol : {};

  log("LIQUIDATION_MONITOR_STARTING", {
    buildSha: BUILD_SHA,
    strategy: state.strategy,
    source: "AGGR",
    aggrUrl: AGGR_URL,
    symbols: [...SYMBOLS],
    liquidationValueThreshold: LIQUIDATION_VALUE_THRESHOLD,
    resetAfterAlert: true,
    multipleCoinsPer5m: true
  });

  startHealth();
  connectAggr();

  setInterval(() => {
    log("FEED_STATUS", {
      source: "AGGR",
      aggrConnected,
      aggrEvents,
      acceptedSinceSummary,
      ignoredEvents,
      skippedEvents,
      aggrLastEventAt,
      valueBySymbol: state.valueBySymbol || {}
    });
    acceptedSinceSummary = 0;
    ignoredEvents = 0;
    skippedEvents = 0;
  }, FEED_SUMMARY_LOG_MS);
}

process.on("SIGTERM", () => log("MONITOR_STOPPING"));
process.on("SIGINT", () => log("MONITOR_STOPPING"));

main();
