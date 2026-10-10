const http = require("http");
const https = require("https");
const WebSocket = require("ws");

const VERSION = "26.10.09-BTC-5M-BINANCE-ORDERBOOK";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const SYMBOL = "BTCUSDT";
const PERIOD_MS = 5 * 60 * 1000;
const ALERT_LEAD_MS = 5000;
const MAX_DIFF_PCT = 25;
const BOOK_RANGE = 0.0005;
const WS_URL = "wss://fstream.binance.com/public/ws/btcusdt@depth@500ms";
const SNAPSHOT_URL = "https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=1000";

let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let stopping = false;
let currentBook = null;
let bookBids = new Map();
let bookAsks = new Map();
let bookUpdateId = null;
let bufferedDepthEvents = [];
let snapshotLoading = false;
let wsConnected = false;
let wsMessages = 0;
let lastMessageAt = null;
let networkRxBytesTotal = 0;
let networkRxBytesMinute = 0;
let networkRxMinuteStartedAt = Date.now();
let networkRxLastMinuteBytes = 0;
let networkRxLastMinuteAt = null;
let snapshotCount = 0;
let snapshotBytesTotal = 0;
let alertsSent = 0;
let alertsFailed = 0;
let lastReportPeriod = null;
let reportInFlight = false;
let nextReportAttemptAt = 0;
let logTimer = null;

function nowIso() { return new Date().toISOString(); }
function log(event, data) {
  console.log(JSON.stringify(Object.assign({
    ts: nowIso(),
    component: "BINANCE_ORDERBOOK_MONITOR",
    version: VERSION,
    event: event
  }, data || {})));
}
function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
function fmtPrice(value) {
  return Number(value).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function fmtUsd(value) {
  if (value >= 1000000) return "$" + (value / 1000000).toFixed(2) + "M";
  if (value >= 1000) return "$" + (value / 1000).toFixed(2) + "K";
  return "$" + value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSignedPct(value) {
  return (value > 0 ? "+" : "") + value.toFixed(1) + "%";
}
function marketUrl(periodStart) {
  return "https://polymarket.com/event/btc-updown-5m-" + Math.floor(periodStart / 1000);
}
function parseLevels(levels, descending) {
  if (!Array.isArray(levels)) return [];
  return levels.map(function(level) {
    if (!Array.isArray(level) || level.length < 2) return null;
    const price = number(level[0]);
    const qty = number(level[1]);
    if (price === null || qty === null || price <= 0 || qty <= 0) return null;
    return { price: price, qty: qty, value: price * qty };
  }).filter(Boolean).sort(function(a, b) {
    return descending ? b.price - a.price : a.price - b.price;
  });
}
function calculateBook() {
  const bids = Array.from(bookBids.entries()).map(function(entry) {
    return { price: Number(entry[0]), qty: entry[1], value: Number(entry[0]) * entry[1] };
  }).filter(function(level) { return level.qty > 0 && Number.isFinite(level.price); })
    .sort(function(a, b) { return b.price - a.price; });
  const asks = Array.from(bookAsks.entries()).map(function(entry) {
    return { price: Number(entry[0]), qty: entry[1], value: Number(entry[0]) * entry[1] };
  }).filter(function(level) { return level.qty > 0 && Number.isFinite(level.price); })
    .sort(function(a, b) { return a.price - b.price; });
  if (!bids.length || !asks.length) return null;
  const bestBid = bids[0];
  const bestAsk = asks[0];
  if (bestAsk.price < bestBid.price) return null;
  const mid = (bestBid.price + bestAsk.price) / 2;
  if (!(mid > 0)) return null;
  const spread = bestAsk.price - bestBid.price;
  const spreadBps = spread / mid * 10000;
  const bidLocal = bids.filter(function(level) { return level.price >= mid * (1 - BOOK_RANGE); })
    .reduce(function(sum, level) { return sum + level.value; }, 0);
  const askLocal = asks.filter(function(level) { return level.price <= mid * (1 + BOOK_RANGE); })
    .reduce(function(sum, level) { return sum + level.value; }, 0);
  const totalLocal = bidLocal + askLocal;
  const imbalancePct = totalLocal > 0 ? (bidLocal - askLocal) / totalLocal * 100 : 0;
  return {
    timestamp: Date.now(),
    updateId: bookUpdateId,
    bestBid: bestBid.price,
    bestBidValue: bestBid.value,
    bestAsk: bestAsk.price,
    bestAskValue: bestAsk.value,
    spread: spread,
    spreadBps: spreadBps,
    bidLocal: bidLocal,
    askLocal: askLocal,
    imbalancePct: imbalancePct,
    bidLevels: bids.length,
    askLevels: asks.length,
    mid: mid
  };
}
function applyDepthEvent(event, ws) {
  if (socket !== ws || bookUpdateId === null) return;
  const first = number(event.U);
  const last = number(event.u);
  if (first === null || last === null) return;
  if (last < bookUpdateId) return;
  if (first > bookUpdateId + 1) {
    log("BINANCE_BOOK_SEQUENCE_GAP", { expectedUpdateId: bookUpdateId + 1, firstUpdateId: first, lastUpdateId: last });
    currentBook = null;
    bookUpdateId = null;
    bufferedDepthEvents = [];
    try { ws.close(); } catch (_) {}
    return;
  }
  for (const level of Array.isArray(event.b) ? event.b : []) {
    if (!Array.isArray(level) || level.length < 2) continue;
    const price = number(level[0]);
    const qty = number(level[1]);
    if (price === null || qty === null || price <= 0 || qty < 0) continue;
    const key = String(price);
    if (qty === 0) bookBids.delete(key);
    else bookBids.set(key, qty);
  }
  for (const level of Array.isArray(event.a) ? event.a : []) {
    if (!Array.isArray(level) || level.length < 2) continue;
    const price = number(level[0]);
    const qty = number(level[1]);
    if (price === null || qty === null || price <= 0 || qty < 0) continue;
    const key = String(price);
    if (qty === 0) bookAsks.delete(key);
    else bookAsks.set(key, qty);
  }
  bookUpdateId = last;
  if (bookBids.size > 5000) {
    const keys = Array.from(bookBids.keys()).map(Number).sort(function(a, b) { return b - a; });
    for (const price of keys.slice(5000)) bookBids.delete(String(price));
  }
  if (bookAsks.size > 5000) {
    const keys = Array.from(bookAsks.keys()).map(Number).sort(function(a, b) { return a - b; });
    for (const price of keys.slice(5000)) bookAsks.delete(String(price));
  }
  currentBook = calculateBook();
  if (currentBook) {
    wsMessages++;
    lastMessageAt = nowIso();
  }
}
function fetchSnapshot(ws) {
  if (snapshotLoading || socket !== ws || ws.readyState !== WebSocket.OPEN) return;
  snapshotLoading = true;
  const request = https.get(SNAPSHOT_URL, { headers: { "Accept": "application/json", "User-Agent": "Polymarket-Perps-Monitor/1.0" } }, function(response) {
    let body = "";
    response.setEncoding("utf8");
    response.on("data", function(chunk) { networkRxBytesTotal += Buffer.byteLength(chunk); networkRxBytesMinute += Buffer.byteLength(chunk); body += chunk; });
    response.on("end", function() {
      snapshotLoading = false;
      if (socket !== ws) return;
      if (response.statusCode !== 200) {
        log("BINANCE_SNAPSHOT_HTTP_ERROR", { status: response.statusCode, body: body.slice(0, 200) });
        currentBook = null;
        try { ws.close(); } catch (_) {}
        return;
      }
      let snapshot;
      try { snapshot = JSON.parse(body); } catch (_) {
        log("BINANCE_SNAPSHOT_PARSE_ERROR", {});
        try { ws.close(); } catch (_) {}
        return;
      }
      snapshotCount++;
      snapshotBytesTotal += Buffer.byteLength(body);
      if (!snapshot || !Array.isArray(snapshot.bids) || !Array.isArray(snapshot.asks) || !Number.isFinite(Number(snapshot.lastUpdateId))) {
        log("BINANCE_SNAPSHOT_INVALID", { keys: snapshot && Object.keys(snapshot) });
        try { ws.close(); } catch (_) {}
        return;
      }
      bookBids = new Map();
      bookAsks = new Map();
      for (const level of snapshot.bids) {
        if (!Array.isArray(level) || level.length < 2) continue;
        const price = number(level[0]), qty = number(level[1]);
        if (price !== null && qty !== null && price > 0 && qty > 0) bookBids.set(String(price), qty);
      }
      for (const level of snapshot.asks) {
        if (!Array.isArray(level) || level.length < 2) continue;
        const price = number(level[0]), qty = number(level[1]);
        if (price !== null && qty !== null && price > 0 && qty > 0) bookAsks.set(String(price), qty);
      }
      bookUpdateId = Number(snapshot.lastUpdateId);
      const pending = bufferedDepthEvents;
      bufferedDepthEvents = [];
      for (const event of pending) {
        if (Number(event.u) <= bookUpdateId) continue;
        if (Number(event.U) > bookUpdateId + 1) {
          log("BINANCE_SNAPSHOT_RESYNC_REQUIRED", { snapshotUpdateId: bookUpdateId, firstUpdateId: event.U, lastUpdateId: event.u });
          bookUpdateId = null;
          currentBook = null;
          try { ws.close(); } catch (_) {}
          return;
        }
        applyDepthEvent(event, ws);
        if (socket !== ws || bookUpdateId === null) return;
      }
      currentBook = calculateBook();
      log("BINANCE_BOOK_SNAPSHOT_READY", {
        snapshotUpdateId: bookUpdateId,
        bidLevels: bookBids.size,
        askLevels: bookAsks.size,
        bufferedEventsApplied: pending.length
      });
    });
  });
  request.setTimeout(6000, function() { request.destroy(new Error("Binance depth snapshot timeout")); });
  request.on("error", function(error) {
    snapshotLoading = false;
    if (socket !== ws) return;
    log("BINANCE_SNAPSHOT_ERROR", { error: String(error && error.message || error) });
    currentBook = null;
    try { ws.close(); } catch (_) {}
  });
}
function connect() {
  if (stopping) return;
  log("BINANCE_WS_CONNECTING", { url: WS_URL, snapshotUrl: SNAPSHOT_URL, symbol: SYMBOL, stream: "diff-depth", updateSpeed: WS_URL.includes("@depth@500ms") ? "500ms" : "100ms" });
  const ws = new WebSocket(WS_URL);
  socket = ws;
  bufferedDepthEvents = [];
  bookUpdateId = null;
  currentBook = null;
  ws.on("open", function() {
    if (socket !== ws) return;
    wsConnected = true;
    reconnectAttempt = 0;
    log("BINANCE_WS_CONNECTED", { symbol: SYMBOL });
    fetchSnapshot(ws);
  });
  ws.on("message", function(raw) {
    if (socket !== ws) return;
    const payloadBytes = Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(String(raw));
    networkRxBytesTotal += payloadBytes;
    networkRxBytesMinute += payloadBytes;
    let payload;
    try { payload = JSON.parse(raw.toString()); } catch (_) { return; }
    if (payload && payload.data) payload = payload.data;
    if (!payload || !Array.isArray(payload.b) || !Array.isArray(payload.a) || payload.U === undefined || payload.u === undefined) return;
    if (bookUpdateId === null) {
      bufferedDepthEvents.push(payload);
      if (bufferedDepthEvents.length > 5000) {
        log("BINANCE_DEPTH_BUFFER_OVERFLOW", { bufferedEvents: bufferedDepthEvents.length });
        bufferedDepthEvents = [];
        try { ws.close(); } catch (_) {}
      }
      return;
    }
    applyDepthEvent(payload, ws);
  });
  ws.on("error", function(error) {
    log("BINANCE_WS_ERROR", { error: String(error && error.message || error) });
  });
  ws.on("close", function(code, reason) {
    if (socket !== ws) return;
    socket = null;
    wsConnected = false;
    snapshotLoading = false;
    currentBook = null;
    bookUpdateId = null;
    bufferedDepthEvents = [];
    log("BINANCE_WS_CLOSED", { code: code, reason: String(reason || "") });
    scheduleReconnect();
  });
}
function scheduleReconnect() {
  if (stopping || reconnectTimer) return;
  reconnectAttempt++;
  const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempt, 5)));
  reconnectTimer = setTimeout(function() {
    reconnectTimer = null;
    connect();
  }, delay);
}
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log("TELEGRAM_CONFIG_MISSING", { tokenConfigured: !!token, chatConfigured: !!chatId });
    return false;
  }
  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
    const body = await response.json().catch(function() { return null; });
    const sent = response.ok && !!(body && body.ok);
    if (!sent) log("TELEGRAM_SEND_ERROR", {
      httpStatus: response.status,
      telegramOk: body && body.ok,
      errorCode: body && body.error_code,
      description: body && body.description
    });
    return sent;
  } catch (error) {
    log("TELEGRAM_SEND_EXCEPTION", { error: String(error && error.message || error) });
    return false;
  }
}
async function reportForNextMarket(periodStart) {
  const book = currentBook;
  const ageMs = book ? Date.now() - book.timestamp : null;
  if (!book || ageMs === null || ageMs > 3000 || !wsConnected) {
    log("ORDERBOOK_REPORT_SKIPPED_STALE", {
      targetPeriodStart: new Date(periodStart).toISOString(),
      wsConnected: wsConnected,
      bookAgeMs: ageMs,
      lastMessageAt: lastMessageAt
    });
    return false;
  }
  const direction = "";
  const totalTopValue = book.bestBidValue + book.bestAskValue;
  const diffPct = totalTopValue > 0 ? (book.bestBidValue - book.bestAskValue) / totalTopValue * 100 : 0;
  if (Math.abs(diffPct) < 55) {
    log("ORDERBOOK_REPORT_SKIPPED_DIFF", {
      targetPeriodStart: new Date(periodStart).toISOString(),
      diffPct: Number(diffPct.toFixed(2)),
      minAbsDiffPct: 55,
      bookAgeMs: ageMs
    });
    return false;
  }
  const diffText = (diffPct > 0 ? "+" : "") + diffPct.toFixed(2) + "%";
  const lines = [
    "BTC 5m" + direction,
    "BID: $" + fmtPrice(book.bestBid) + " | " + fmtUsd(book.bestBidValue),
    "ASK: $" + fmtPrice(book.bestAsk) + " | " + fmtUsd(book.bestAskValue),
    "DIFF: " + diffText,
    "",
    marketUrl(periodStart)
  ];
  const sent = await sendTelegram(lines.join("\n"));
  if (sent) alertsSent++;
  else alertsFailed++;
  log(sent ? "ORDERBOOK_ALERT_SENT" : "ORDERBOOK_ALERT_FAILED", {
    targetPeriodStart: new Date(periodStart).toISOString(),
    marketUrl: marketUrl(periodStart),
    bookAgeMs: ageMs,
    bestBid: book.bestBid,
    bestBidValue: book.bestBidValue,
    bestAsk: book.bestAsk,
    bestAskValue: book.bestAskValue,
    spread: book.spread,
    spreadBps: book.spreadBps,
    bidLocal: book.bidLocal,
    askLocal: book.askLocal,
    imbalancePct: book.imbalancePct,
    bidLevels: book.bidLevels,
    askLevels: book.askLevels,
    telegramSent: sent
  });
  return sent;
}
function diagnostics() {
  const book = currentBook;
  return {
    status: wsConnected && book && Date.now() - book.timestamp <= 3000 ? "ok" : "waiting_for_fresh_book",
    version: VERSION,
    buildSha: BUILD_SHA,
    source: "BINANCE_USDS_M_FUTURES_WEBSOCKET",
    symbol: SYMBOL,
    websocketUrl: WS_URL,
    wsConnected: wsConnected,
    wsMessages: wsMessages,
    lastMessageAt: lastMessageAt,
    networkRxBytesSinceStart: networkRxBytesTotal,
    networkRxMBSinceStart: Number((networkRxBytesTotal / 1048576).toFixed(2)),
    networkRxLastMinuteBytes: networkRxLastMinuteBytes,
    networkRxLastMinuteMB: Number((networkRxLastMinuteBytes / 1048576).toFixed(3)),
    estimatedMonthlyRxGB: Number((networkRxLastMinuteBytes * 60 * 24 * 30 / 1073741824).toFixed(2)),
    snapshotCount: snapshotCount,
    snapshotBytesTotal: snapshotBytesTotal,
    bookAgeMs: book ? Date.now() - book.timestamp : null,
    book: book,
    bookRangePct: 0.05,
    alertsSent: alertsSent,
    alertsFailed: alertsFailed,
    nextReportAt: new Date((Math.floor(Date.now() / PERIOD_MS) + 1) * PERIOD_MS - ALERT_LEAD_MS).toISOString(),
    marketUrl: marketUrl(Math.floor(Date.now() / PERIOD_MS) * PERIOD_MS)
  };
}
function startHealth() {
  const port = Number(process.env.MONITOR_HEALTH_PORT || 8080);
  const server = http.createServer(function(req, res) {
    const pathname = String(req.url || "/").split("?")[0];
    if (pathname === "/" || pathname === "/health" || pathname === "/status" || pathname === "/stats") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(diagnostics()));
    }
    res.writeHead(404);
    res.end();
  });
  server.on("error", function(error) {
    log("HEALTH_SERVER_ERROR", { error: String(error && error.message || error), port: port });
  });
  server.listen(port, "0.0.0.0", function() {
    log("HEALTH_LISTENING", { port: port });
  });
}
function start() {
  startHealth();
  connect();
  logTimer = setInterval(function() {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - networkRxMinuteStartedAt);
    networkRxLastMinuteBytes = networkRxBytesMinute;
    networkRxLastMinuteAt = nowIso();
    const estimatedMonthlyRxGB = networkRxLastMinuteBytes * 60 * 24 * 30 / 1073741824;
    log("ORDERBOOK_STATUS", {
      wsConnected: wsConnected,
      messagesLastMinute: wsMessages,
      lastMessageAt: lastMessageAt,
      bookAgeMs: currentBook ? Date.now() - currentBook.timestamp : null,
      networkRxBytesLastInterval: networkRxLastMinuteBytes,
      networkRxIntervalSeconds: Number((elapsedMs / 1000).toFixed(1)),
      networkRxMBLastInterval: Number((networkRxLastMinuteBytes / 1048576).toFixed(3)),
      networkRxBytesSinceStart: networkRxBytesTotal,
      networkRxMBSinceStart: Number((networkRxBytesTotal / 1048576).toFixed(2)),
      estimatedMonthlyRxGB: Number(estimatedMonthlyRxGB.toFixed(2)),
      monthlyTransferLimitGB: 100,
      estimatedLimitUsagePct: Number((estimatedMonthlyRxGB / 100 * 100).toFixed(1)),
      snapshotCount: snapshotCount,
      snapshotBytesTotal: snapshotBytesTotal,
      alertsSent: alertsSent,
      alertsFailed: alertsFailed
    });
    networkRxBytesMinute = 0;
    networkRxMinuteStartedAt = now;
    wsMessages = 0;
  }, 60000);
  setInterval(function() {
    const now = Date.now();
    const targetPeriod = Math.round(now / PERIOD_MS) * PERIOD_MS;
    const millisecondsFromBoundary = now - targetPeriod;
    if (millisecondsFromBoundary < -ALERT_LEAD_MS || millisecondsFromBoundary > 0) return;
    if (targetPeriod === lastReportPeriod || reportInFlight || now < nextReportAttemptAt) return;
    reportInFlight = true;
    log("ORDERBOOK_ALERT_ATTEMPT", {
      attemptAt: nowIso(),
      targetPeriodStart: new Date(targetPeriod).toISOString(),
      millisecondsFromBoundary: millisecondsFromBoundary
    });
    reportForNextMarket(targetPeriod).then(function(sent) {
      if (sent) {
        lastReportPeriod = targetPeriod;
        nextReportAttemptAt = 0;
      } else {
        nextReportAttemptAt = Date.now() + 500;
      }
    }).catch(function(error) {
      nextReportAttemptAt = Date.now() + 500;
      log("ORDERBOOK_REPORT_ERROR", {
        error: String(error && error.message || error),
        attemptAt: nowIso(),
        targetPeriodStart: new Date(targetPeriod).toISOString()
      });
    }).finally(function() {
      reportInFlight = false;
    });
  }, 250);
  log("ORDERBOOK_MONITOR_STARTING", {
    source: "BINANCE_USDS_M_FUTURES_WEBSOCKET",
    symbol: SYMBOL,
    period: "5m",
    reportCadence: "from 2 seconds before up to the 5m boundary only; retries every 500ms and stop at the boundary",
    alertLeadMs: ALERT_LEAD_MS,
    websocketUpdateSpeed: "500ms to reduce transfer",
    transferMonitoring: "incoming application payload bytes; excludes TCP/TLS framing and some HTTP overhead",
    strategy: "send fresh order-book snapshot for the next Polymarket 5m market; no volume thresholds",
    bookRangePct: 0.1,
    snapshotDepth: 1000
  });
}
process.on("SIGTERM", function() {
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(logTimer);
  if (socket) {
    const ws = socket;
    socket = null;
    try { ws.close(); } catch (_) {}
  }
  process.exit(0);
});
process.on("SIGINT", function() {
  stopping = true;
  clearTimeout(reconnectTimer);
  clearInterval(logTimer);
  if (socket) {
    const ws = socket;
    socket = null;
    try { ws.close(); } catch (_) {}
  }
  process.exit(0);
});
start();
