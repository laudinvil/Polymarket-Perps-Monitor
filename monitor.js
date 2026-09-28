const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const VERSION = "4.0.0";
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

let ws = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let connected = false;
let state = null;
let lastCycle = 0;
const latest = new Map();
const history = new Map();

function nowIso() { return new Date().toISOString(); }

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

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
    initialized: true,
    counts: Object.fromEntries(ASSETS.map(a => [a.key, 0])),
    periods: {},
    lastProcessedPeriod: null,
    leader: null,
    updatedAt: nowIso(),
    source: "Polymarket RTDS Chainlink TWAP60",
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
  } catch (e) {
    log("STATE_WRITE_ERROR", { error: String(e.message || e) });
  }
}

function snapshot(reason) {
  const file = STATE_FILE.replace(/\.json$/, "") + "-snapshots.jsonl";
  try {
    ensureDir(file);
    fs.appendFileSync(file, JSON.stringify({
      ts: nowIso(),
      reason,
      version: VERSION,
      state
    }) + "\n");
  } catch {}
  log("STATE_SNAPSHOT", {
    reason,
    counts: state.counts,
    lastProcessedPeriod: state.lastProcessedPeriod,
    leader: state.leader
  });
}

function startHealth() {
  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((req, res) => {
    if (req.url === "/status" || req.url === "/health" || req.url === "/") {
      const payload = {
        status: "ok",
        version: VERSION,
        source: "Polymarket RTDS Chainlink TWAP60",
        websocket: connected,
        pollingMs: POLL_MS,
        assets: ASSETS.map(a => ({
          asset: a.key,
          symbol: a.symbol,
          latest: latest.get(a.key) || null
        })),
        lastProcessedPeriod: state.lastProcessedPeriod,
        leader: state.leader,
        counts: state.counts,
        uptimeSec: Math.floor(process.uptime()),
        updatedAt: state.updatedAt
      };
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      return res.end(JSON.stringify(payload));
    }
    if (req.url === "/logs") {
      let text = "";
      try {
        const b = fs.readFileSync(LOG_FILE, "utf8");
        text = b.slice(-120000);
      } catch {}
      res.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      });
      return res.end(text);
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(port, "0.0.0.0", () => log("HEALTH_LISTENING", { port }));
}

function connectRtds() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  clearTimeout(reconnectTimer);
  log("RTDS_CONNECTING", { url: RTDS_URL });

  ws = new WebSocket(RTDS_URL);

  ws.on("open", () => {
    connected = true;
    log("RTDS_CONNECTED");

    const subscriptions = ASSETS.map(a => ({
      topic: "crypto_prices_twap_sixty",
      type: "update",
      filters: JSON.stringify({ symbol: a.symbol })
    }));

    ws.send(JSON.stringify({
      action: "subscribe",
      subscriptions
    }));

    log("RTDS_SUBSCRIBED", {
      topic: "crypto_prices_twap_sixty",
      symbols: ASSETS.map(a => a.symbol),
      windowSeconds: 60
    });

    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send("PING"); } catch {}
      }
    }, 5000);
  });

  ws.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.message) {
      log("RTDS_MESSAGE", { message: msg.message });
      return;
    }

    const p = msg.payload;
    if (!p || msg.topic !== "crypto_prices_twap_sixty") return;
    if (Number(p.window_s) !== 60) {
      log("TWAP_REJECTED", { reason: "window_not_60", payload: p });
      return;
    }

    const symbol = String(p.symbol || "").toLowerCase();
    const asset = ASSETS.find(a => a.symbol === symbol);
    if (!asset) return;

    const ts = Number(p.timestamp);
    const exact = String(p.full_accuracy_value || "");
    if (!Number.isFinite(ts) || !exact) return;

    const value = Number(exact) / 1e18;
    if (!Number.isFinite(value)) return;

    const point = {
      ts,
      value,
      exact,
      receivedAt: Date.now()
    };

    latest.set(asset.key, point);

    let arr = history.get(asset.key);
    if (!arr) {
      arr = [];
      history.set(asset.key, arr);
    }

    const last = arr[arr.length - 1];
    if (!last || ts > last.ts) arr.push(point);

    const cutoff = Date.now() - 12 * 60 * 1000;
    while (arr.length && arr[0].ts < cutoff) arr.shift();

    if (!last || ts > last.ts) {
      log("TWAP60_UPDATE", {
        asset: asset.key,
        symbol,
        observationTimestamp: ts,
        value,
        windowSeconds: 60
      });
    }
  });

  ws.on("close", (code, reason) => {
    connected = false;
    clearInterval(heartbeatTimer);
    log("RTDS_CLOSED", {
      code,
      reason: reason ? reason.toString() : ""
    });
    scheduleReconnect();
  });

  ws.on("error", e => {
    log("RTDS_ERROR", { error: String(e.message || e) });
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectRtds();
  }, 3000);
}

function pointAtOrBefore(assetKey, targetMs, maxAgeMs = 20_000) {
  const arr = history.get(assetKey) || [];
  let candidate = null;
  for (const p of arr) {
    if (p.ts <= targetMs) candidate = p;
    else break;
  }
  if (!candidate) return null;
  if (targetMs - candidate.ts > maxAgeMs) return null;
  return candidate;
}

function currentPeriodStart() {
  return Math.floor(Date.now() / PERIOD_MS) * PERIOD_MS;
}

function ranking() {
  return ASSETS
    .map(a => ({ asset: a.key, score: Number(state.counts[a.key] || 0) }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.asset.localeCompare(b.asset));
}

async function gammaMarket(slug) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(GAMMA + "/markets?slug=" + encodeURIComponent(slug), {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!r.ok) return null;
    const data = await r.json();
    return Array.isArray(data) ? data[0] || null : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) {
    log("TELEGRAM_NOT_CONFIGURED");
    return false;
  }

  try {
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text,
        disable_web_page_preview: false
      })
    });
    if (!r.ok) {
      log("TELEGRAM_ERROR", { status: r.status, body: await r.text().catch(() => "") });
      return false;
    }
    return true;
  } catch (e) {
    log("TELEGRAM_ERROR", { error: String(e.message || e) });
    return false;
  }
}

async function processClosedPeriod() {
  const start = currentPeriodStart();
  const closedStart = start - PERIOD_MS;
  const periodKey = "period-" + Math.floor(closedStart / 1000);

  if (state.periods[periodKey]) return;
  if (closedStart <= lastCycle) return;
  lastCycle = closedStart;

  const closeBoundary = start;
  const results = {};
  const missing = [];

  for (const asset of ASSETS) {
    const open = pointAtOrBefore(asset.key, closedStart, 20_000);
    const close = pointAtOrBefore(asset.key, closeBoundary, 20_000);

    if (!open || !close) {
      missing.push({
        asset: asset.key,
        open: !!open,
        close: !!close,
        latest: latest.get(asset.key) || null
      });
      continue;
    }

    const winner = close.value >= open.value ? "Up" : "Down";
    results[asset.key] = {
      winner,
      open: open.value,
      close: close.value,
      change: close.value - open.value,
      openTimestamp: open.ts,
      closeTimestamp: close.ts
    };
  }

  if (missing.length) {
    log("PERIOD_WAIT", {
      periodKey,
      reason: "missing_twap60_boundary",
      missing
    });
    return;
  }

  for (const asset of ASSETS) {
    state.counts[asset.key] += results[asset.key].winner === "Up" ? 1 : -1;
  }

  state.periods[periodKey] = results;
  state.lastProcessedPeriod = periodKey;
  state.leader = ranking()[0];
  saveState();

  const top = state.leader;
  const nextStart = start + PERIOD_MS;
  const nextSlug = top.asset.toLowerCase() + "-updown-5m-" + Math.floor(nextStart / 1000);

  let market = await gammaMarket(nextSlug);
  const link = market?.slug
    ? "https://polymarket.com/event/" + market.slug
    : "https://polymarket.com/event/" + nextSlug;

  const lines = [
    "5M CHAINLINK TWAP 60s",
    "",
    ...ASSETS.map(a => {
      const r = results[a.key];
      return a.key + " → " + r.winner + " (" + r.open.toFixed(6) + " → " + r.close.toFixed(6) + ")";
    }),
    "",
    ...ranking().map(x => x.asset + ": " + (x.score >= 0 ? "+" : "") + x.score),
    "",
    "IMBALANCE: " + top.asset + " " + (top.score >= 0 ? "+" : "") + top.score,
    link
  ];

  const sent = await sendTelegram(lines.join("\n"));

  log("PERIOD_PROCESSED", {
    periodKey,
    results,
    counts: state.counts,
    leader: top,
    telegram: sent,
    source: "crypto_prices_twap_sixty"
  });

  snapshot("POST_PERIOD_" + periodKey);
}

async function poll() {
  if (!connected) connectRtds();

  try {
    await processClosedPeriod();
  } catch (e) {
    log("CYCLE_ERROR", { error: String(e.stack || e) });
  }
}

async function main() {
  ensureDir(STATE_FILE);
  ensureDir(LOG_FILE);

  state = loadState();

  if (state.version !== VERSION) {
    snapshot("PRE_VERSION_CHANGE");
    log("VERSION_CHANGE", {
      from: state.version || "unknown",
      to: VERSION
    });
    state.version = VERSION;
    saveState();
  }

  log("MONITOR_STARTING", {
    version: VERSION,
    source: "Polymarket RTDS / Chainlink crypto_prices_twap_sixty",
    pollingMs: POLL_MS,
    windowSeconds: 60,
    assets: ASSETS.map(a => a.key),
    persistentState: true,
    postgres: false
  });

  startHealth();
  connectRtds();

  await poll();

  setInterval(poll, POLL_MS);

  setInterval(() => {
    log("HEARTBEAT", {
      websocket: connected,
      pollingMs: POLL_MS,
      latest: Object.fromEntries(
        ASSETS.map(a => [a.key, latest.get(a.key) || null])
      ),
      lastProcessedPeriod: state.lastProcessedPeriod,
      leader: state.leader,
      counts: state.counts
    });
  }, 60_000);
}

process.on("SIGTERM", () => {
  clearInterval(heartbeatTimer);
  if (ws) ws.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  clearInterval(heartbeatTimer);
  if (ws) ws.close();
  process.exit(0);
});

main().catch(e => {
  log("FATAL", { error: String(e.stack || e) });
  process.exit(1);
});
