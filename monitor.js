const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");
const zlib = require("zlib");

const VERSION = "24.0.0-OPENMARKET-SIMPLE";
const POLL_MS = 0;
const OPENMARKET_WS_URL = "wss://eu-de3.ws.api.openmarket.xyz/nonbook/ws?encoding=json";
const OPENMARKET_API_KEY = process.env.OPENMARKET_API_KEY || "";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const STATE_FILE = process.env.STATE_FILE || "/data/openmarket-liquidation-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/openmarket-liquidation.jsonl";
const MAX_SEEN = 10000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_BYTES = 1 * 1024 * 1024;
const FEED_SUMMARY_LOG_MS = 300000;
const EXCLUDED_EXCHANGES = new Set(["hyperliquid", "hyper_liquid", "hyperliquid_perps"]);
const OPENMARKET_EXCHANGES = [
  "BINANCE_FUTURES",
  "BYBIT",
  "OKX",
  "DERIBIT",
  "BITMEX",
  "BITGET",
  "GATE_IO_FUTURES"
];
const OPENMARKET_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT", "DOGEUSDT", "BNBUSDT", "HYPEUSDT"];

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
    strategy: "OPENMARKET_SIMPLE",
    updatedAt: nowIso(),
    seen: [],
    alertsSent: 0,
    lastEventTs: null,
    lastEventKey: null,
    warmedUp: false
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
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
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

function decodeOpenMarketMessage(data) {
  try {
    if (Buffer.isBuffer(data)) {
      try { return JSON.parse(data.toString("utf8")); } catch {}
      try { return JSON.parse(zlib.brotliDecompressSync(data).toString("utf8")); } catch {}
      try { return JSON.parse(zlib.gunzipSync(data).toString("utf8")); } catch {}
      return null;
    }
    if (typeof data === "string") return JSON.parse(data);
    return null;
  } catch {
    return null;
  }
}

function openMarketChannels() {
  return OPENMARKET_EXCHANGES.flatMap(exchange =>
    OPENMARKET_SYMBOLS.map(symbol => ({
      type: "LIQUIDATION",
      category: "*",
      exchange,
      symbol
    }))
  );
}

function normalizeOpenMarketPoint(point) {
  const p = point?.liquidation || point || {};
  const series = point?.series || {};
  const symbolRaw = String(
    series.coin || series.symbol || p.coin || p.symbol || point?.coin || point?.symbol || ""
  ).toUpperCase();
  const coin = symbolRaw.replace(/USDT|USDC|USD|PERP|[-_]/g, "").replace("SWAP","");
  const exchange = String(
    series.exchange || p.exchange || point?.exchange || point?.venue || ""
  ).trim();

  const side = String(
    p.side || p.direction || point?.side || point?.direction || ""
  ).trim().toUpperCase();

  const price = num(p.price ?? p.liquidationPrice ?? point?.price);
  const qty = num(p.amount ?? p.qty ?? p.quantity ?? p.size ?? point?.amount ?? point?.qty ?? point?.size);
  const id = p.id ?? point?.id;
  const ts = num(p.timestamp ?? p.time ?? point?.timestamp ?? point?.time) ?? Date.now();

  if (!exchange || !coin || !side || price === null || qty === null) return null;
  if (!["BTC","ETH","SOL","XRP","DOGE","BNB","HYPE"].includes(coin)) return null;
  if (EXCLUDED_EXCHANGES.has(exchange.toLowerCase())) return null;

  return {
    id: id == null ? "" : String(id),
    ts: ts < 1e12 ? ts * 1000 : ts,
    exchange,
    symbol: coin,
    side,
    price,
    qty,
    notional: price * qty
  };
}

function collectOpenMarketPoints(message) {
  const out = [];
  const seen = new Set();

  function walk(value, depth = 0) {
    if (!value || depth > 6) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    const event = normalizeOpenMarketPoint(value);
    if (event) {
      const key = eventKey(event);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(event);
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === "series" || key === "liquidation" || key === "data" || key === "result" || key === "points" || key === "items") {
        walk(child, depth + 1);
      }
    }
  }

  walk(message);
  return out;
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
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function polymarket5mUrl(symbol, nowMs = Date.now()) {
  const startEpoch = Math.floor(nowMs / 300000) * 300;
  return "https://polymarket.com/event/" + String(symbol).toLowerCase() + "-updown-5m-" + startEpoch;
}

async function fetchPolymarketClobPrices(symbol, nowMs = Date.now()) {
  const slug = String(symbol).toLowerCase() + "-updown-5m-" + (Math.floor(nowMs / 300000) * 300);
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
    log("POLYMARKET_CLOB_PRICE_ERROR", {
      symbol,
      slug,
      error: String(e.message || e)
    });
    return null;
  }
}

function eventBatchMessage(events) {
  const bySymbol = {};
  for (const event of events) {
    const symbol = String(event?.symbol ?? event?.coin ?? "UNKNOWN").trim().toUpperCase() || "UNKNOWN";
    if (!bySymbol[symbol]) bySymbol[symbol] = [];
    bySymbol[symbol].push(event);
  }

  const allowed = new Set(["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE"]);
  const candidates = Object.entries(bySymbol)
    .filter(([symbol]) => allowed.has(symbol))
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  if (!candidates.length) return "";

  const [symbol, symbolEvents] = candidates[0];
  let longCount = 0;
  let shortCount = 0;
  let value = 0;
  let size = 0;
  const prices = [];
  const byExchange = {};

  for (const event of symbolEvents) {
    const side = String(event.side ?? event.direction ?? "").trim().toLowerCase();
    if (
      side === "long" ||
      side === "buy" ||
      side === "long_liquidated" ||
      side === "long-liquidated" ||
      side === "long liquidation"
    ) longCount++;
    else if (
      side === "short" ||
      side === "sell" ||
      side === "short_liquidated" ||
      side === "short-liquidated" ||
      side === "short liquidation"
    ) shortCount++;
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

  const kyivTime = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Kyiv", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date());

  return [
    symbol,
    kyivTime,
    "LIQS: " + symbolEvents.length,
    "LONG: " + longCount + " | SHORT: " + shortCount,
    "VALUE: $" + formatNumber(value, 2),
    ...exchangeLines,
    polymarket5mUrl(symbol)
  ].join("\n");
}

function eventKey(e) {
  if (e.id) return "openmarket:" + e.exchange + ":" + e.id;
  return [
    e.ts ?? "",
    e.exchange ?? "",
    e.symbol ?? "",
    e.side ?? "",
    e.price ?? "",
    e.qty ?? ""
  ].join("|");
}

function buildAlertForEvents(events) {
  const bySymbol = {};
  for (const event of events) {
    if (!bySymbol[event.symbol]) bySymbol[event.symbol] = [];
    bySymbol[event.symbol].push(event);
  }

  const ranked = Object.entries(bySymbol)
    .sort((a,b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  if (!ranked.length) return null;

  const [symbol, symbolEvents] = ranked[0];
  const longCount = symbolEvents.filter(e => e.side === "SELL").length;
  const shortCount = symbolEvents.filter(e => e.side === "BUY").length;
  const value = symbolEvents.reduce((sum,e) => sum + (e.notional || 0), 0);
  const byExchange = {};
  for (const e of symbolEvents) byExchange[e.exchange] = (byExchange[e.exchange] || 0) + 1;

  const exchangeLines = Object.entries(byExchange)
    .sort((a,b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([exchange,count]) => exchange.toUpperCase() + ": " + count);

  const kyivTime = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Kyiv",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(new Date());

  return {
    symbol,
    count: symbolEvents.length,
    text: [
      symbol,
      kyivTime,
      "LIQS: " + symbolEvents.length,
      "LONG: " + longCount + " | SHORT: " + shortCount,
      "VALUE: $" + formatNumber(value, 2),
      ...exchangeLines,
      polymarket5mUrl(symbol)
    ].join("\n")
  };
}

let openMarketWs = null;
let reconnectTimer = null;
let bucket = [];
let bucketTimer = null;
let bucketFlushScheduled = false;
let wsConnectedAt = null;

async function flushOpenMarketBucket() {
  if (!bucket.length) return;
  const events = bucket;
  bucket = [];

  const fresh = [];
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);

  for (const event of events) {
    const key = eventKey(event);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    state.seen.push(key);
    fresh.push(event);
  }

  if (!fresh.length) return;

  const bySymbol = {};
  for (const e of fresh) {
    if (!bySymbol[e.symbol]) bySymbol[e.symbol] = [];
    bySymbol[e.symbol].push(e);
  }

  const ranked = Object.entries(bySymbol)
    .sort((a,b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  const [symbol, symbolEvents] = ranked[0];
  const alert = buildAlertForEvents(symbolEvents);
  if (!alert) return;

  const sent = await sendTelegram(alert.text);
  if (sent) state.alertsSent = Number(state.alertsSent || 0) + 1;

  log(sent ? "TOP_SYMBOL_ALERT_SENT" : "TOP_SYMBOL_ALERT_FAILED", {
    source: "OPENMARKET",
    symbol,
    events: symbolEvents.length
  });
  saveState();
}

function scheduleBucketFlush() {}

function connectOpenMarket() {
  if (!OPENMARKET_API_KEY) {
    log("OPENMARKET_API_KEY_MISSING");
    return;
  }

  openMarketWs = new WebSocket(OPENMARKET_WS_URL);
  log("OPENMARKET_CONNECTING", {
    url: OPENMARKET_WS_URL,
    exchanges: OPENMARKET_EXCHANGES,
    symbols: OPENMARKET_SYMBOLS,
    excluded_exchanges: Array.from(EXCLUDED_EXCHANGES)
  });

  openMarketWs.on("open", () => {
    wsConnectedAt = nowIso();
    log("OPENMARKET_CONNECTED_NO_AUTH");
    openMarketWs.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "public/subscribe",
      params: {
        channels: openMarketChannels(),
        compression: "brotli",
        version: "v2"
      }
    }));
  });

  openMarketWs.on("message", data => {
    const message = decodeOpenMarketMessage(data);
    if (!message) {
      log("OPENMARKET_DECODE_ERROR");
      return;
    }

    if (message.error) {
      log("OPENMARKET_ERROR", { error: message.error });
      return;
    }

    if (message.id === 2) {
      log("OPENMARKET_SUBSCRIBE_RESULT", { result: message.result ?? message });
      return;
    }

    const points = collectOpenMarketPoints(message);
    if (!points.length) {
      if (message?.method || message?.channel || message?.type || message?.data) {
        log("OPENMARKET_MESSAGE_NO_POINTS", {
          method: message.method ?? null,
          channel: message.channel ?? null,
          type: message.type ?? null,
          has_data: message.data != null,
          data_type: Array.isArray(message.data) ? "array" : typeof message.data,
          keys: Object.keys(message).slice(0, 20)
        });
      }
      return;
    }

    for (const event of points) bucket.push(event);
    flushOpenMarketBucket().catch(e => log("OPENMARKET_FLUSH_ERROR", { error: String(e.stack || e) }));

    log("OPENMARKET_LIQUIDATIONS", {
      received_events: points.length,
      symbols: [...new Set(points.map(e => e.symbol))],
      exchanges: [...new Set(points.map(e => e.exchange))]
    });
  });

  openMarketWs.on("close", (code, reason) => {
    log("OPENMARKET_CLOSED", {
      code,
      reason: Buffer.isBuffer(reason) ? reason.toString() : String(reason || ""),
      connected_at: wsConnectedAt
    });
    openMarketWs = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectOpenMarket, 3000);
  });

  openMarketWs.on("error", e => {
    log("OPENMARKET_WS_ERROR", { error: String(e.message || e) });
  });
}

function diagnostics() {
  return {
    status: "ok",
    version: VERSION,
    buildSha: BUILD_SHA,
    strategy: state.strategy,
    pollingMs: 0,
    feed: OPENMARKET_WS_URL,
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

function startLiquidationStream() {
  scheduleBucketFlush();
  connectOpenMarket();
}

function main() {
  ensureDir(STATE_FILE);
  ensureDir(LOG_FILE);
  state = loadState();

  // A strategy change must never inherit the previous strategy's dedupe cache.
  // Otherwise a rolling feed can contain only events already marked as seen,
  // producing zero fresh events and therefore zero alerts after deployment.
  const strategy = "OPENMARKET_SIMPLE";
  if (state.strategy !== strategy || state.version !== VERSION) {
    state.seen = [];
    state.alertsSent = 0;
    state.lastEventTs = null;
    state.lastEventKey = null;
    state.warmedUp = false;
  }

  state.version = VERSION;
  state.strategy = strategy;
  state.seen = Array.isArray(state.seen) ? state.seen : [];
  collectionStartedAt = nowIso();

  log("LIQUIDATION_MONITOR_STARTING", {
    buildSha: BUILD_SHA,
    strategy: state.strategy,
    source: OPENMARKET_WS_URL,
    pollingMs: POLL_MS,
    logMaxBytes: LOG_MAX_BYTES,
    logKeepBytes: LOG_KEEP_BYTES,
    feedSummaryLogMs: FEED_SUMMARY_LOG_MS,
    monitor: "OPENMARKET_SIMPLE"
  });

  startHealth();
  startLiquidationStream();
}

process.on("SIGTERM", () => log("MONITOR_STOPPING"));
process.on("SIGINT", () => log("MONITOR_STOPPING"));

main();
