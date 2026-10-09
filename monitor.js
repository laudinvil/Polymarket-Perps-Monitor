const http = require("http");
const WebSocket = require("ws");

const VERSION = "26.10.09-BTC-5M-BINANCE-ORDERBOOK";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const SYMBOL = "BTCUSDT";
const PERIOD_MS = 5 * 60 * 1000;
const BOOK_RANGE = 0.001;
const WS_URL = "wss://fstream.binance.com/public/ws/btcusdt@depth20@100ms";

let socket = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let stopping = false;
let currentBook = null;
let wsConnected = false;
let wsMessages = 0;
let lastMessageAt = null;
let alertsSent = 0;
let alertsFailed = 0;
let lastReportPeriod = Math.floor(Date.now() / PERIOD_MS) * PERIOD_MS;
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
function calculateBook(payload) {
  const bids = parseLevels(payload.bids || payload.b, true);
  const asks = parseLevels(payload.asks || payload.a, false);
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
function connect() {
  if (stopping) return;
  log("BINANCE_WS_CONNECTING", { url: WS_URL, symbol: SYMBOL, stream: "partial-depth-20", updateSpeed: "100ms" });
  const ws = new WebSocket(WS_URL);
  socket = ws;
  ws.on("open", function() {
    if (socket !== ws) return;
    wsConnected = true;
    reconnectAttempt = 0;
    log("BINANCE_WS_CONNECTED", { symbol: SYMBOL });
  });
  ws.on("message", function(raw) {
    if (socket !== ws) return;
    let payload;
    try { payload = JSON.parse(raw.toString()); } catch (_) { return; }
    if (payload && payload.data) payload = payload.data;
    if (!payload || (!Array.isArray(payload.bids) && !Array.isArray(payload.b))) return;
    const book = calculateBook(payload);
    if (!book) return;
    currentBook = book;
    wsMessages++;
    lastMessageAt = nowIso();
  });
  ws.on("error", function(error) {
    log("BINANCE_WS_ERROR", { error: String(error && error.message || error) });
  });
  ws.on("close", function(code, reason) {
    if (socket !== ws) return;
    socket = null;
    wsConnected = false;
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
function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return Promise.resolve(false);
  return fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000)
  }).then(function(response) { return response.ok; }).catch(function() { return false; });
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
    return;
  }
  const imbalance = fmtSignedPct(book.imbalancePct);
  const lines = [
    "BTC ORDER BOOK 5m",
    "BID: $" + fmtPrice(book.bestBid) + " | " + fmtUsd(book.bestBidValue),
    "ASK: $" + fmtPrice(book.bestAsk) + " | " + fmtUsd(book.bestAskValue),
    "SPREAD: $" + book.spread.toFixed(1) + " | " + book.spreadBps.toFixed(2) + " bps",
    "BOOK ±0.1%: BID " + fmtUsd(book.bidLocal) + " | ASK " + fmtUsd(book.askLocal),
    "IMBALANCE: " + imbalance,
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
    bookAgeMs: book ? Date.now() - book.timestamp : null,
    book: book,
    bookRangePct: 0.1,
    alertsSent: alertsSent,
    alertsFailed: alertsFailed,
    nextReportAt: new Date(lastReportPeriod + PERIOD_MS).toISOString(),
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
    log("ORDERBOOK_STATUS", {
      wsConnected: wsConnected,
      messagesLastMinute: wsMessages,
      lastMessageAt: lastMessageAt,
      bookAgeMs: currentBook ? Date.now() - currentBook.timestamp : null,
      alertsSent: alertsSent,
      alertsFailed: alertsFailed
    });
    wsMessages = 0;
  }, 60000);
  setInterval(function() {
    const currentPeriod = Math.floor(Date.now() / PERIOD_MS) * PERIOD_MS;
    if (currentPeriod !== lastReportPeriod) {
      lastReportPeriod = currentPeriod;
      reportForNextMarket(currentPeriod).catch(function(error) {
        log("ORDERBOOK_REPORT_ERROR", { error: String(error && error.message || error) });
      });
    }
  }, 250);
  log("ORDERBOOK_MONITOR_STARTING", {
    source: "BINANCE_USDS_M_FUTURES_WEBSOCKET",
    symbol: SYMBOL,
    period: "5m",
    reportCadence: "each 5m boundary",
    strategy: "send fresh order-book snapshot for the next Polymarket 5m market; no volume thresholds",
    bookRangePct: 0.1,
    levels: 20
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
