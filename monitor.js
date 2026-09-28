const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const VERSION = "4.5.0";
const POLL_MS = 10_000;
const PERIOD_MS = 300_000;
const RTDS_URL = "wss://ws-live-data.polymarket.com";
const GAMMA = "https://gamma-api.polymarket.com";

const ASSETS = [
  { key: "BTC", symbol: "btc/usd", slug: "btc-updown-5m" },
  { key: "ETH", symbol: "eth/usd", slug: "eth-updown-5m" },
  { key: "SOL", symbol: "sol/usd", slug: "sol-updown-5m" },
  { key: "BNB", symbol: "bnb/usd", slug: "bnb-updown-5m" },
  { key: "XRP", symbol: "xrp/usd", slug: "xrp-updown-5m" },
  { key: "DOGE", symbol: "doge/usd", slug: "doge-updown-5m" },
  { key: "HYPE", symbol: "hype/usd", slug: "hype-updown-5m" }
];

const STATE_FILE = process.env.STATE_FILE || "/data/chainlink-twap60-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/chainlink-twap60.jsonl";

const sockets = new Map();
const reconnectTimers = new Map();
const heartbeatTimers = new Map();
let connected = false;
let state = null;
let collectionStartedAt = null;
const latest = new Map();
const history = new Map();
let onlineAlertSent = false;

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
    version: VERSION, initialized: true,
    counts: Object.fromEntries(ASSETS.map(a => [a.key, 0])),
    periods: {}, lastProcessedPeriod: null, leader: null,
    updatedAt: nowIso(), source: "Polymarket RTDS Chainlink TWAP60",
    pollingMs: POLL_MS
  };
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s && typeof s === "object") return s;
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

function snapshot(reason) {
  const file = STATE_FILE.replace(/\.json$/, "") + "-snapshots.jsonl";
  try {
    ensureDir(file);
    fs.appendFileSync(file, JSON.stringify({ ts: nowIso(), reason, version: VERSION, state }) + "\n");
  } catch {}
  log("STATE_SNAPSHOT", {
    reason, counts: state.counts,
    lastProcessedPeriod: state.lastProcessedPeriod, leader: state.leader
  });
}

function startHealth() {
  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((req, res) => {
    if (req.url === "/status" || req.url === "/health" || req.url === "/") {
      const payload = {
        status: "ok", version: VERSION,
        source: "Polymarket RTDS Chainlink TWAP60",
        websocket: connected, collectionStartedAt, pollingMs: POLL_MS,
        assets: ASSETS.map(a => ({ asset: a.key, symbol: a.symbol, latest: latest.get(a.key) || null })),
        lastProcessedPeriod: state.lastProcessedPeriod, leader: state.leader,
        counts: state.counts, uptimeSec: Math.floor(process.uptime()), updatedAt: state.updatedAt
      };
      res.writeHead(200, {"content-type":"application/json","cache-control":"no-store"});
      return res.end(JSON.stringify(payload));
    }
    if (req.url === "/logs") {
      let text = "";
      try { text = fs.readFileSync(LOG_FILE, "utf8").slice(-120000); } catch {}
      res.writeHead(200, {"content-type":"text/plain; charset=utf-8","cache-control":"no-store"});
      return res.end(text);
    }
    res.writeHead(404); res.end();
  });
  server.listen(port, "0.0.0.0", () => log("HEALTH_LISTENING", { port }));
}

function connectRtds() {
  for (const asset of ASSETS) connectAssetRtds(asset);
}

function connectAssetRtds(asset) {
  const existing = sockets.get(asset.key);
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;

  clearTimeout(reconnectTimers.get(asset.key));
  log("RTDS_CONNECTING", { url: RTDS_URL, asset: asset.key });

  const socket = new WebSocket(RTDS_URL);
  sockets.set(asset.key, socket);

  socket.on("open", () => {
    connected = true;
    if (!collectionStartedAt) {
      collectionStartedAt = Date.now();
      log("COLLECTION_STARTED", { at: collectionStartedAt, nextPeriodStart: currentPeriodStart() + PERIOD_MS });
    }

    log("RTDS_CONNECTED", { asset: asset.key });

    // RTDS currently rejects a multi-symbol TWAP subscription batch.
    // Use one WebSocket/subscription per asset so one bad symbol cannot
    // suppress the other six streams.
    const subscription = {
      action: "subscribe",
      subscriptions: [{
        topic: "crypto_prices_twap_sixty",
        type: "update",
        filters: JSON.stringify({ symbol: asset.symbol })
      }]
    };
    socket.send(JSON.stringify(subscription));
    log("RTDS_SUBSCRIBED", {
      topic: "crypto_prices_twap_sixty",
      asset: asset.key,
      symbol: asset.symbol,
      windowSeconds: 60
    });

    clearInterval(heartbeatTimers.get(asset.key));
    heartbeatTimers.set(asset.key, setInterval(() => {
      const current = sockets.get(asset.key);
      if (current && current.readyState === WebSocket.OPEN) {
        try { current.send("PING"); } catch {}
      }
    }, 5000));
  });

  socket.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.message) {
      log("RTDS_MESSAGE", { asset: asset.key, message: msg.message });
      return;
    }

    const p = msg.payload;
    if (!p || msg.topic !== "crypto_prices_twap_sixty") return;
    if (Number(p.window_s) !== 60) {
      log("TWAP_REJECTED", { asset: asset.key, reason: "window_not_60", payload: p });
      return;
    }

    const symbol = String(p.symbol || "").toLowerCase();
    if (symbol !== asset.symbol) return;

    let ts = Number(p.timestamp);
    const exact = String(p.full_accuracy_value || "");
    if (!Number.isFinite(ts) || !exact) return;
    if (ts > 0 && ts < 1_000_000_000_000) ts *= 1000;

    const value = Number(exact) / 1e18;
    if (!Number.isFinite(value)) return;

    const point = { ts, value, exact, receivedAt: Date.now() };
    latest.set(asset.key, point);

    let arr = history.get(asset.key);
    if (!arr) { arr = []; history.set(asset.key, arr); }
    const last = arr[arr.length - 1];
    if (!last || ts > last.ts) arr.push(point);

    const cutoff = Date.now() - 12 * 60 * 1000;
    while (arr.length && arr[0].ts < cutoff) arr.shift();

    if (!last || ts > last.ts) {
      log("TWAP60_UPDATE", {
        asset: asset.key, symbol, observationTimestamp: ts, value, windowSeconds: 60
      });
    }
  });

  socket.on("close", (code, reason) => {
    connected = Array.from(sockets.values()).some(x => x && x.readyState === WebSocket.OPEN);
    clearInterval(heartbeatTimers.get(asset.key));
    heartbeatTimers.delete(asset.key);
    if (sockets.get(asset.key) === socket) sockets.delete(asset.key);
    log("RTDS_CLOSED", { asset: asset.key, code, reason: reason ? reason.toString() : "" });
    scheduleReconnect(asset);
  });

  socket.on("error", e => log("RTDS_ERROR", { asset: asset.key, error: String(e.message || e) }));
}

function scheduleReconnect(asset) {
  if (reconnectTimers.get(asset.key)) return;
  reconnectTimers.set(asset.key, setTimeout(() => {
    reconnectTimers.delete(asset.key);
    connectAssetRtds(asset);
  }, 3000));
}

function pointAtOrBefore(assetKey, targetMs) {
  const arr = history.get(assetKey) || [];
  let best = null;
  for (const p of arr) {
    if (p.ts <= targetMs) best = p;
    else break;
  }
  return best;
}

function pointAtOrAfter(assetKey, targetMs) {
  const arr = history.get(assetKey) || [];
  for (const p of arr) {
    if (p.ts >= targetMs) return p;
  }
  return null;
}

function boundaryPoints(assetKey, openTargetMs, closeTargetMs) {
  // TWAP observations are timestamped rolling observations, not guaranteed to
  // land exactly on the 5m clock boundary. Use the last observation available
  // at/before each boundary. No expanding tolerance window is used.
  const open = pointAtOrBefore(assetKey, openTargetMs) || pointAtOrAfter(assetKey, openTargetMs);
  const close = pointAtOrBefore(assetKey, closeTargetMs) || pointAtOrAfter(assetKey, closeTargetMs);
  return { open, close };
}

function currentPeriodStart() { return Math.floor(Date.now() / PERIOD_MS) * PERIOD_MS; }

function ranking() {
  return ASSETS.map(a => ({ asset: a.key, score: Number(state.counts[a.key] || 0) }))
    .sort((a,b) => Math.abs(b.score)-Math.abs(a.score) || a.asset.localeCompare(b.asset));
}

async function gammaMarket(slug) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(GAMMA + "/markets?slug=" + encodeURIComponent(slug), {
      signal: controller.signal, headers: { accept: "application/json" }
    });
    if (!r.ok) {
      log("GAMMA_ERROR", { slug, status: r.status });
      return null;
    }
    const data = await r.json();
    const market = Array.isArray(data) ? data[0] || null : null;
    log("GAMMA_RESULT", { slug, found: !!market, marketSlug: market?.slug || null });
    return market;
  } catch (e) {
    log("GAMMA_ERROR", { slug, error: String(e.message || e) });
    return null;
  } finally { clearTimeout(timer); }
}

async function sendTelegram(text, kind = "PERIOD_ALERT") {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  log("TELEGRAM_TARGET", { kind, chatConfigured: !!chat, chatIdTail: chat ? String(chat).slice(-4) : null });
  log("TELEGRAM_ATTEMPT", { kind, configured: !!token && !!chat, textPreview: text.slice(0, 300) });

  if (!token || !chat) {
    log("TELEGRAM_NOT_CONFIGURED", { kind });
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      signal: controller.signal,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      log("TELEGRAM_ERROR", { kind, status: r.status, body: body.slice(0, 1000) });
      return false;
    }
    let data = null;
    try { data = await r.json(); } catch {}
    clearTimeout(timeout);
    if (!data || data.ok !== true) {
      log("TELEGRAM_ERROR", { kind, status: r.status, body: JSON.stringify(data).slice(0, 1000) });
      return false;
    }
    log("TELEGRAM_SENT", { kind, messageId: data?.result?.message_id || null });
    return true;
  } catch (e) {
    clearTimeout(timeout);
    log("TELEGRAM_ERROR", { kind, error: String(e.message || e) });
    return false;
  }
}

async function sendOnlineAlert() {
  // Startup connectivity is logged only; Telegram is reserved for actual period alerts.
  log("ONLINE_READY", {
    assets:Object.fromEntries(ASSETS.map(a => [a.key, latest.get(a.key) || null]))
  });
  return false;
}

async function processClosedPeriod() {
  const start = currentPeriodStart();
  const closedStart = start - PERIOD_MS;
  const periodKey = "period-" + Math.floor(closedStart / 1000);

  const savedPeriod = state.periods[periodKey] || {};
  const savedCount = Object.keys(savedPeriod).length;
  const alreadySent = !!state.periodAlerted?.[periodKey]?.sent;

  // Once Telegram has confirmed delivery, this period is finished.
  if (savedCount >= ASSETS.length && alreadySent) return;

  if (savedCount > 0) {
    log("PERIOD_RETRY_PARTIAL", {
      periodKey,
      savedAssets: Object.keys(savedPeriod)
    });
  }

  const closeBoundary = start;
  const results = {};
  const missing = [];

  for (const asset of ASSETS) {
    const { open, close } = boundaryPoints(asset.key, closedStart, closeBoundary);
    if (!open || !close) {
      missing.push({ asset:asset.key, open:!!open, close:!!close, latest:latest.get(asset.key)||null });
      continue;
    }
    const winner = close.value >= open.value ? "Up" : "Down";
    results[asset.key] = {
      winner, open:open.value, close:close.value, change:close.value-open.value,
      openTimestamp:open.ts, closeTimestamp:close.ts
    };
  }

  log("PERIOD_BOUNDARY_CHECK", {
    periodKey,
    closedStart,
    closeBoundary,
    available:Object.keys(results),
    missing:missing.map(x => ({
      asset:x.asset,
      open:x.open,
      close:x.close,
      latestTs:x.latest?.ts || null
    }))
  });

  if (!Object.keys(results).length) {
    log("PERIOD_WAIT", {
      periodKey, reason:"no_twap60_boundary_observation_available", missing, retry:true
    });
    return;
  }

  if (missing.length) {
    log("PERIOD_PARTIAL", {
      periodKey,
      reason:"some_assets_missing_boundary",
      missing,
      available:Object.keys(results),
      alerting:true
    });
  }

  const newResults = {};
  for (const asset of ASSETS) {
    if (results[asset.key] && !savedPeriod[asset.key]) {
      newResults[asset.key] = results[asset.key];
      state.counts[asset.key] += results[asset.key].winner === "Up" ? 1 : -1;
    }
  }

  const mergedResults = { ...savedPeriod, ...newResults };
  const newlyComplete = Object.keys(mergedResults).length >= ASSETS.length;

  // If there is no new RTDS data but this period is already saved, still retry
  // Telegram delivery. Only a confirmed send ends processing.
  // Once this period was delivered, only newly arrived asset results may
  // justify another message. Otherwise the 10s polling loop would spam Telegram.
  if (alreadySent && !Object.keys(newResults).length) {
    return;
  }

  if (!Object.keys(newResults).length && !newlyComplete && savedCount === 0) {
    log("PERIOD_WAIT", {
      periodKey,
      reason:"no_new_twap60_assets",
      savedAssets:Object.keys(savedPeriod),
      available:Object.keys(results),
      retry:true
    });
    return;
  }

  state.periods[periodKey] = mergedResults;
  state.lastProcessedPeriod = periodKey;
  state.leader = ranking()[0];
  saveState();

  // Never send a trading alert from a partial 5m period. The alert must
  // contain all seven assets; partial results remain persisted and are merged
  // when the missing TWAP60 boundaries arrive.
  if (!newlyComplete) {
    // Avoid writing the same diagnostic every 10 seconds. Blitz has no
    // request/credit meter, but unnecessary persistent log writes consume
    // storage and I/O.
    const waitSig = Object.keys(mergedResults).sort().join(",");
    if (state.lastPartialWaitSignature !== periodKey + "|" + waitSig) {
      state.lastPartialWaitSignature = periodKey + "|" + waitSig;
      saveState();
      log("PERIOD_WAIT", {
        periodKey,
        reason:"period_partial_waiting_for_all_assets",
        available:Object.keys(mergedResults),
        missing:ASSETS.filter(a => !mergedResults[a.key]).map(a => a.key),
        counts:state.counts,
        retry:true
      });
    }
    return;
  }

  // If a period is complete but Telegram was unavailable, retry it on every
  // 10-second cycle. Do not require another RTDS observation.
  const alertAttempt = state.periodAlerted?.[periodKey]?.attempts || 0;
  state.periodAlerted = state.periodAlerted || {};
  state.periodAlerted[periodKey] = {
    ...(state.periodAlerted[periodKey] || {}),
    attempts: alertAttempt + 1,
    lastAttemptAt: nowIso()
  };
  saveState();

  const nextStart = start;
  const top = state.leader;
  const nextSlug = top.asset.toLowerCase() + "-updown-5m-" + Math.floor(nextStart / 1000);

  log("PERIOD_READY_TO_ALERT", {
    periodKey, nextStart, leader:top, nextSlug,
    results:mergedResults, newResults, complete:newlyComplete, counts:state.counts
  });

  // The score must choose the current 5m market direction, but a missing Gamma
  // response must never block the Telegram alert.
  const market = await gammaMarket(nextSlug);
  const link = market?.slug
    ? "https://polymarket.com/event/" + market.slug
    : "https://polymarket.com/event/" + nextSlug;

  // The alert describes the just-closed 5m period, not the cumulative
  // lifetime counters. Cumulative counters remain in state for statistics.
  const periodRanking = ASSETS.map(a => {
    const result = mergedResults[a.key];
    const score = result?.winner === "Up" ? 1 : result?.winner === "Down" ? -1 : 0;
    return { asset:a.key, score };
  }).sort((a,b) => Math.abs(b.score)-Math.abs(a.score) || a.asset.localeCompare(b.asset));

  const periodTop = periodRanking[0];
  const lines = [
    "5M CHAINLINK TWAP 60s",
    "",
    ...periodRanking.map(x => x.asset + ": " + (x.score >= 0 ? "+" : "") + x.score),
    "",
    "NEXT: " + periodTop.asset + " " + (periodTop.score >= 0 ? "UP" : "DOWN"),
    link
  ];

  const sent = await sendTelegram(lines.join("\n"), "PERIOD_ALERT");
  if (sent) {
    state.periodAlerted[periodKey] = {
      ...(state.periodAlerted[periodKey] || {}),
      sentAt: nowIso(),
      complete: newlyComplete,
      sent: true
    };
    saveState();
  }
  log("PERIOD_PROCESSED", {
    periodKey, results:mergedResults, newResults, complete:newlyComplete, counts:state.counts, leader:periodTop, telegram:sent,
    source:"crypto_prices_twap_sixty", marketSlug:market?.slug||null
  });
  snapshot("POST_PERIOD_" + periodKey);
}

async function poll() {
  if (!connected) connectRtds();
  try {
    await processClosedPeriod();
  } catch (e) {
    log("CYCLE_ERROR", { error:String(e.stack||e) });
  }
}

async function main() {
  ensureDir(STATE_FILE); ensureDir(LOG_FILE);
  state = loadState();

  if (state.version !== VERSION) {
    snapshot("PRE_VERSION_CHANGE");
    log("VERSION_CHANGE", { from:state.version||"unknown", to:VERSION });
    state.version = VERSION; saveState();
  }

  log("MONITOR_STARTING", {
    version:VERSION, source:"Polymarket RTDS / Chainlink crypto_prices_twap_sixty",
    pollingMs:POLL_MS, windowSeconds:60, assets:ASSETS.map(a=>a.key),
    persistentState:true, postgres:false
  });

  startHealth(); connectRtds();
  log("STARTUP_TELEGRAM_RESULT", { sent:false, reason:"startup_message_disabled_actual_alerts_only" });
  await poll();
  setInterval(poll, POLL_MS);

  setInterval(() => log("HEARTBEAT", {
    websocket:connected, pollingMs:POLL_MS, collectionStartedAt,
    latest:Object.fromEntries(ASSETS.map(a=>[a.key,latest.get(a.key)||null])),
    lastProcessedPeriod:state.lastProcessedPeriod, leader:state.leader, counts:state.counts
  }), 60_000);
}

process.on("SIGTERM", () => { for (const t of heartbeatTimers.values()) clearInterval(t); for (const socket of sockets.values()) { try { socket.close(); } catch {} } process.exit(0); });
process.on("SIGINT", () => { clearInterval(heartbeatTimer); if (ws) ws.close(); process.exit(0); });

main().catch(e => { log("FATAL", { error:String(e.stack||e) }); process.exit(1); });
