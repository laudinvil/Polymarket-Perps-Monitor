const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const http = require("http");
let chainlinkSdkPromise = null;
let chainlinkClientPromise = null;
async function getChainlinkDecoder() {
  if (!chainlinkSdkPromise) chainlinkSdkPromise = import("@chainlink/data-streams-sdk");
  return chainlinkSdkPromise;
}
async function getChainlinkClient() {
  if (!chainlinkClientPromise) {
    chainlinkClientPromise = getChainlinkDecoder().then(({ createClient }) => {
      if (!CHAINLINK_API_KEY || !CHAINLINK_API_SECRET) throw new Error("Chainlink credentials missing");
      return createClient({
        apiKey: CHAINLINK_API_KEY,
        userSecret: CHAINLINK_API_SECRET,
        endpoint: CHAINLINK_ENDPOINT,
        wsEndpoint: "wss://ws.dataengine.chain.link",
        timeout: 8000,
        retryAttempts: 2,
        retryDelay: 500
      });
    });
  }
  return chainlinkClientPromise;
}

const API = "https://gamma-api.polymarket.com";
const MONITOR_VERSION = "2.8.3";
const CHAINLINK_ENDPOINT = process.env.CHAINLINK_ENDPOINT || "https://api.dataengine.chain.link";
const CHAINLINK_API_KEY = process.env.CHAINLINK_CLIENT_ID || process.env.STREAMS_API_KEY || process.env.CHAINLINK_API_KEY || "";
const CHAINLINK_API_SECRET = process.env.CHAINLINK_CLIENT_SECRET || process.env.STREAMS_API_SECRET || process.env.CHAINLINK_API_SECRET || "";
const CHAINLINK_DISCOVERY_CACHE_MS = 5 * 60 * 1000;
let chainlinkDiscoveryCache = { at: 0, feeds: [] };
const START_MS = Date.parse("2026-08-14T00:00:00Z");
const POLL_MS = 10_000;
const GAMMA_MIN_INTERVAL_MS = 250;
const CHAINLINK_MIN_INTERVAL_MS = 1000;
let lastGammaRequestAt = 0;
let lastChainlinkRequestAt = 0;
let cycleBusy = false;
const marketCache = new Map();
const reportCache = new Map();
const bulkReportCache = new Map();
async function pace(kind) {
  const min = kind === "chainlink" ? CHAINLINK_MIN_INTERVAL_MS : GAMMA_MIN_INTERVAL_MS;
  const last = kind === "chainlink" ? lastChainlinkRequestAt : lastGammaRequestAt;
  const wait = Math.max(0, min - (Date.now() - last));
  if (wait) await new Promise(r => setTimeout(r, wait));
  if (kind === "chainlink") lastChainlinkRequestAt = Date.now();
  else lastGammaRequestAt = Date.now();
}
const STATE_FILE = process.env.STATE_FILE || "/data/chainlink-imbalance-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/chainlink-imbalance.jsonl";
const RUNTIME_LOG_FILE = process.env.RUNTIME_LOG_FILE || "/data/deplexo-runtime.log";

const ASSETS = [
  { key: "BTC", slug: "btc-updown-5m", symbol: "BTC" },
  { key: "ETH", slug: "eth-updown-5m", symbol: "ETH" },
  { key: "SOL", slug: "sol-updown-5m", symbol: "SOL" },
  { key: "BNB", slug: "bnb-updown-5m", symbol: "BNB" },
  { key: "XRP", slug: "xrp-updown-5m", symbol: "XRP" },
  { key: "DOGE", slug: "doge-updown-5m", symbol: "DOGE" },
  { key: "HYPE", slug: "hype-updown-5m", symbol: "HYPE" }
];

let db = null;
let runtimeState = null;

function nowIso() { return new Date().toISOString(); }
function tailFile(file, maxBytes = 120000) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

function runtimeLog(record) {
  try {
    ensureDir(RUNTIME_LOG_FILE);
    fs.appendFileSync(RUNTIME_LOG_FILE, JSON.stringify(record) + "\n");
  } catch {}
}

function startHealthServer() {
  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((req, res) => {
    if (req.url === "/logs") {
      const payload = { status: "ok", version: MONITOR_VERSION, logFile: RUNTIME_LOG_FILE, runtime: tailFile(RUNTIME_LOG_FILE), monitor: tailFile(LOG_FILE) };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify(payload));
    }
    if (req.url === "/status") {
      const payload = { status: "ok", version: MONITOR_VERSION, uptimeSec: Math.floor(process.uptime()), pollingMs: POLL_MS, chainlink: !!(CHAINLINK_API_KEY && CHAINLINK_API_SECRET), postgres: !!db, initialized: !!runtimeState?.initialized, lastProcessedPeriod: runtimeState?.lastProcessedPeriod || null, leader: runtimeState?.leader || null, counts: runtimeState?.counts || Object.fromEntries(ASSETS.map(a => [a.key, 0])), updatedAt: runtimeState?.updatedAt || null };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify(payload));
    }
    if (req.url === "/health" || req.url === "/") {
      const payload = {
        status: "ok",
        version: MONITOR_VERSION,
        pollingMs: POLL_MS,
        chainlink: !!(CHAINLINK_API_KEY && CHAINLINK_API_SECRET),
        postgres: !!db,
        initialized: !!runtimeState?.initialized,
        lastProcessedPeriod: runtimeState?.lastProcessedPeriod || null,
        leader: runtimeState?.leader || null,
        counts: runtimeState?.counts || Object.fromEntries(ASSETS.map(a => [a.key, 0])),
        uptimeSec: Math.floor(process.uptime()),
        updatedAt: runtimeState?.updatedAt || null
      };
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      return res.end(JSON.stringify(payload));
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  server.listen(port, "0.0.0.0", () => log("HEALTH_LISTENING", { port }));
  server.on("error", e => log("HEALTH_ERROR", { error: String(e.message || e), port }));
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

async function initDb() {
  const url =
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.POSTGRESQL_URL ||
    process.env.BLITZ_DATABASE_URL ||
    process.env.BLITZ_POSTGRES_URL;

  if (!url) {
    log("PERSISTENCE_WARNING", { message: "No PostgreSQL connection variable found; using persistent /data files only" });
    return;
  }

  db = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  try {
    await db.connect();
    await db.query(`
      CREATE TABLE IF NOT EXISTS monitor_state (
        id INTEGER PRIMARY KEY,
        version TEXT NOT NULL,
        saved_at TIMESTAMPTZ NOT NULL,
        state JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS monitor_snapshots (
        id BIGSERIAL PRIMARY KEY,
        version TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        reason TEXT NOT NULL,
        state JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS monitor_periods (
        period_key TEXT PRIMARY KEY,
        period_start TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ NOT NULL,
        results JSONB NOT NULL,
        counts JSONB NOT NULL,
        leader JSONB
      );
      CREATE TABLE IF NOT EXISTS monitor_logs (
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL,
        event TEXT NOT NULL,
        payload JSONB NOT NULL
      );
    `);
    log("POSTGRES_READY", { backend: "Blitz/PostgreSQL" });
  } catch (e) {
    db = null;
    log("POSTGRES_ERROR", { error: String(e.message || e) });
  }
}

function appendFileLog(record) {
  try {
    ensureDir(LOG_FILE);
    fs.appendFileSync(LOG_FILE, JSON.stringify(record) + "\n");
  } catch {}
}

function log(event, data = {}) {
  const record = { ts: nowIso(), version: MONITOR_VERSION, event, ...data };
  const line = JSON.stringify(record);
  console.log(line);
  runtimeLog(record);
  appendFileLog(record);
  if (db) {
    db.query(
      "INSERT INTO monitor_logs(ts,event,payload) VALUES($1,$2,$3)",
      [record.ts, event, JSON.stringify(data)]
    ).catch(() => {});
  }
}

function defaultState() {
  return {
    version: MONITOR_VERSION,
    startMs: START_MS,
    initialized: false,
    counts: Object.fromEntries(ASSETS.map(a => [a.key, 0])),
    periods: {},
    lastProcessedPeriod: null,
    lastProcessedAt: null,
    leader: null,
    diagnostic: {},
    updatedAt: nowIso()
  };
}

function loadFileState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return defaultState();
  }
}

function saveFileState(state) {
  ensureDir(STATE_FILE);
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

async function loadState() {
  if (db) {
    try {
      const r = await db.query("SELECT state FROM monitor_state WHERE id=1");
      if (r.rows[0]?.state) return r.rows[0].state;
    } catch (e) {
      log("STATE_DB_READ_ERROR", { error: String(e.message || e) });
    }
  }
  return loadFileState();
}

async function saveState(state) {
  state.updatedAt = nowIso();
  saveFileState(state);
  if (db) {
    try {
      await db.query(
        "INSERT INTO monitor_state(id,version,saved_at,state) VALUES(1,$1,$2,$3) ON CONFLICT(id) DO UPDATE SET version=EXCLUDED.version,saved_at=EXCLUDED.saved_at,state=EXCLUDED.state",
        [MONITOR_VERSION, state.updatedAt, JSON.stringify(state)]
      );
    } catch (e) {
      log("STATE_DB_WRITE_ERROR", { error: String(e.message || e) });
    }
  }
}

async function snapshotState(state, reason) {
  const snapshot = JSON.parse(JSON.stringify(state));
  const file = STATE_FILE.replace(/\.json$/, "") + "-snapshots.jsonl";
  try {
    ensureDir(file);
    fs.appendFileSync(file, JSON.stringify({ ts: nowIso(), reason, version: state.version, state: snapshot }) + "\n");
  } catch {}
  if (db) {
    try {
      await db.query(
        "INSERT INTO monitor_snapshots(version,created_at,reason,state) VALUES($1,$2,$3,$4)",
        [state.version || "unknown", nowIso(), reason, JSON.stringify(snapshot)]
      );
    } catch (e) {
      log("SNAPSHOT_DB_ERROR", { error: String(e.message || e) });
    }
  }
  log("STATE_SNAPSHOT", {
    reason,
    previousVersion: state.version || "unknown",
    counts: state.counts,
    lastProcessedPeriod: state.lastProcessedPeriod,
    leader: state.leader
  });
}

async function restoreAndMigrate() {
  let state = await loadState();
  if (!state || typeof state !== "object") state = defaultState();

  if (!state.counts) state.counts = Object.fromEntries(ASSETS.map(a => [a.key, 0]));
  for (const a of ASSETS) if (!Number.isFinite(Number(state.counts[a.key]))) state.counts[a.key] = 0;
  if (!state.periods) state.periods = {};
  if (state.backfillIncomplete) state.initialized = false;

  if (state.version !== MONITOR_VERSION) {
    await snapshotState(state, "PRE_VERSION_CHANGE");
    log("VERSION_RESTORE", { from: state.version || "unknown", to: MONITOR_VERSION });
    state.version = MONITOR_VERSION;
  }

  state.version = MONITOR_VERSION;
  state.diagnostic = state.diagnostic || {};
  await saveState(state);
  return state;
}

async function getJson(url, headers = {}) {
  if (url.startsWith(API)) await pace("gamma");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "Polymarket-Chainlink-Imbalance/2.1", ...headers }
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function hmacHeaders(method, fullPath) {
  if (!CHAINLINK_API_KEY || !CHAINLINK_API_SECRET) return {};
  const crypto = require("crypto");
  const ts = Date.now().toString();
  const bodyHash = crypto.createHash("sha256").update("").digest("hex");
  const message = [method.toUpperCase(), fullPath, bodyHash, CHAINLINK_API_KEY, ts].join(" ");
  const signature = crypto.createHmac("sha256", CHAINLINK_API_SECRET).update(message).digest("hex");
  return {
    Authorization: CHAINLINK_API_KEY,
    "X-Authorization-Timestamp": ts,
    "X-Authorization-Signature-SHA256": signature
  };
}

async function chainlinkJson(fullPath) {
  const headers = { accept: "application/json", ...hmacHeaders("GET", fullPath) };
  return getJson(CHAINLINK_ENDPOINT + fullPath, headers);
}

async function getJsonWithHeaders(url, headers = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "Polymarket-Chainlink-Imbalance/2.1", ...headers }
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error("HTTP " + r.status + (body ? " " + body.slice(0, 300) : ""));
    }
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

async function chainlinkJsonDirect(fullPath) {
  await pace("chainlink");
  return getJsonWithHeaders(CHAINLINK_ENDPOINT + fullPath, hmacHeaders("GET", fullPath));
}

async function fetchChainlinkBulkReports(feedIds, timestamp) {
  const unique = Array.from(new Set(feedIds.filter(Boolean)));
  if (!unique.length) return new Map();

  const targetSec = Math.floor(timestamp / 1000);
  const key = targetSec + ":" + unique.join(",");
  const cached = new Map();
  for (const feedId of unique) {
    const item = bulkReportCache.get(feedId + ":" + targetSec);
    if (item) cached.set(feedId, item);
  }
  if (cached.size === unique.length) return cached;

  const pathName = "/api/v1/reports/bulk?feedIDs=" +
    unique.map(encodeURIComponent).join(",") + "&timestamp=" + targetSec;
  const data = await chainlinkJsonDirect(pathName);
  const reports = Array.isArray(data?.reports) ? data.reports : [];
  for (const report of reports) {
    if (!report?.feedID || !report?.fullReport) continue;
    const normalized = {
      feedId: report.feedID,
      validFromTimestamp: Number(report.validFromTimestamp),
      observationsTimestamp: Number(report.observationsTimestamp),
      fullReport: report.fullReport,
      requestedTimestamp: targetSec
    };
    bulkReportCache.set(report.feedID + ":" + targetSec, normalized);
    cached.set(report.feedID, normalized);
  }
  log("CHAINLINK_BULK", {
    timestamp: targetSec,
    requested: unique.length,
    returned: reports.length,
    partial: reports.length !== unique.length
  });
  return cached;
}

async function discoverChainlinkFeeds() {
  const now = Date.now();
  if (chainlinkDiscoveryCache.feeds.length && now - chainlinkDiscoveryCache.at < CHAINLINK_DISCOVERY_CACHE_MS) {
    return chainlinkDiscoveryCache.feeds;
  }
  if (!CHAINLINK_API_KEY || !CHAINLINK_API_SECRET) {
    throw new Error("Chainlink credentials missing");
  }

  let feeds = [];
  let source = "sdk";
  try {
    const client = await getChainlinkClient();
    const listed = await client.listFeeds();
    feeds = Array.isArray(listed)
      ? listed
      : Array.isArray(listed?.feeds)
        ? listed.feeds
        : Array.isArray(listed?.data)
          ? listed.data
          : [];
    if (!feeds.length) {
      log("CHAINLINK_SDK_DISCOVERY_EMPTY", {
        responseType: typeof listed,
        responseKeys: listed && typeof listed === "object" ? Object.keys(listed) : []
      });
    }
  } catch (error) {
    source = "rest";
    log("CHAINLINK_SDK_DISCOVERY_ERROR", { error: error.message });
  }

  if (!feeds.length) {
    const data = await chainlinkJsonDirect("/api/v1/discovery?status=live&hidden=true");
    feeds = Array.isArray(data?.feeds) ? data.feeds : [];
  }

  const normalized = feeds.map(f => ({
    name: f.name,
    feedId: f.feedId || f.feedID,
    baseAsset: f.baseAsset || f.base_asset,
    quoteAsset: f.quoteAsset || f.quote_asset,
    attributeType: f.attributeType || f.attribute_type,
    feedType: f.feedType || f.feed_type,
    schemaVersion: f.schemaVersion
  }));
  chainlinkDiscoveryCache = { at: now, feeds: normalized };
  log("CHAINLINK_DISCOVERY", {
    source,
    feeds: normalized.length,
    cryptoUsd: normalized
      .filter(f => String(f.quoteAsset || "").toUpperCase() === "USD" && String(f.baseAsset || "").length)
      .map(f => ({ baseAsset: f.baseAsset, name: f.name, feedId: f.feedId, attributeType: f.attributeType, feedType: f.feedType, schemaVersion: f.schemaVersion }))
  });
  return normalized;
}
async function resolveTwap60Feed(asset) {
  const explicit = process.env["CHAINLINK_FEED_" + asset.key] || process.env["CHAINLINK_TWAP60_" + asset.key];
  if (explicit) return { feedId: explicit, source: "env" };

  const feeds = await discoverChainlinkFeeds();
  const symbol = asset.symbol.toLowerCase();
  const candidates = feeds.filter(f => {
    const name = String(f.name || "").toLowerCase();
    const base = String(f.baseAsset || "").toLowerCase();
    const quote = String(f.quoteAsset || "").toLowerCase();
    return base === symbol && quote === "usd" && /twap/.test(name) && /60/.test(name);
  });
  if (!candidates.length) throw new Error("No live Chainlink TWAP60 feed discovered for " + asset.key);
  const preferred = candidates.find(f => /twap-?60s|60s-?twap|twap.*60/.test(String(f.name || "").toLowerCase())) || candidates[0];
  return { feedId: preferred.feedId, name: preferred.name, schemaVersion: preferred.schemaVersion, source: "discovery" };
}

async function decodeTwapReport(fullReport, feedId) {
  const { decodeReport } = await getChainlinkDecoder();
  const decoded = decodeReport(fullReport, feedId);
  if (!decoded || typeof decoded.price !== "bigint") {
    throw new Error("Chainlink decoded report has no bigint price");
  }
  return decoded;
}

async function fetchChainlinkReport(feedId, timestamp) {
  const targetSec = Math.floor(timestamp / 1000);
  const cacheKey = feedId + ":" + targetSec;
  if (bulkReportCache.has(cacheKey)) return bulkReportCache.get(cacheKey);
  if (reportCache.has(cacheKey)) return reportCache.get(cacheKey);
  const offsets = [0, -1, -2, -5, -10, -30, -60];
  const candidates = [];
  const seen = new Set();

  for (const offset of offsets) {
    const requested = targetSec + offset;
    if (requested <= 0 || seen.has(requested)) continue;
    seen.add(requested);
    try {
      const pathName = "/api/v1/reports?feedID=" + encodeURIComponent(feedId) + "&timestamp=" + requested;
      const data = await chainlinkJsonDirect(pathName);
      if (!data?.report?.fullReport) continue;
      const report = {
        feedId: data.report.feedID,
        validFromTimestamp: Number(data.report.validFromTimestamp),
        observationsTimestamp: Number(data.report.observationsTimestamp),
        fullReport: data.report.fullReport
      };
      if (!Number.isFinite(report.validFromTimestamp) || !Number.isFinite(report.observationsTimestamp)) continue;
      candidates.push({ requested, report });
      if (report.validFromTimestamp <= targetSec && report.observationsTimestamp <= targetSec) break;
    } catch {}
  }

  if (!candidates.length) throw new Error("Chainlink report missing near " + targetSec);

  const atOrBefore = candidates
    .filter(x => x.report.validFromTimestamp <= targetSec && x.report.observationsTimestamp <= targetSec)
    .sort((a, b) => b.report.validFromTimestamp - a.report.validFromTimestamp);

  const chosen = atOrBefore[0] || candidates
    .sort((a, b) => Math.abs(a.report.validFromTimestamp - targetSec) - Math.abs(b.report.validFromTimestamp - targetSec))[0];

  if (!chosen) throw new Error("No usable Chainlink report near " + targetSec);
  const result = { ...chosen.report, requestedTimestamp: targetSec, requestedQuery: chosen.requested };
  reportCache.set(cacheKey, result);
  return result;
}

async function verifyTwapSettlement(asset, market, periodStart) {
  if (!CHAINLINK_API_KEY || !CHAINLINK_API_SECRET) {
    throw new Error("Chainlink credentials missing");
  }

  const marketStart = Date.parse(market.startDate || "");
  const marketEnd = Date.parse(market.endDate || "");
  if (!Number.isFinite(marketStart) || !Number.isFinite(marketEnd)) {
    throw new Error("market start/end timestamps missing");
  }

  const feed = await resolveTwap60Feed(asset);
  const start = await fetchChainlinkReport(feed.feedId, marketStart);
  const end = await fetchChainlinkReport(feed.feedId, marketEnd);
  const openDecoded = await decodeTwapReport(start.fullReport, start.feedId);
  const closeDecoded = await decodeTwapReport(end.fullReport, end.feedId);
  const openPrice = openDecoded.price;
  const closePrice = closeDecoded.price;
  const expected = closePrice >= openPrice ? "Up" : "Down";
  const actual = winnerOf(market);

  const diagnostics = {
    feedId: feed.feedId,
    feedName: feed.name || null,
    schemaVersion: feed.schemaVersion || "V2",
    marketStart: new Date(marketStart).toISOString(),
    marketEnd: new Date(marketEnd).toISOString(),
    open: {
      requested: Math.floor(marketStart / 1000),
      query: start.requestedQuery,
      observed: start.observationsTimestamp,
      validFrom: start.validFromTimestamp,
      price: openPrice.toString(),
      decodedObservations: openDecoded.observationsTimestamp
    },
    close: {
      requested: Math.floor(marketEnd / 1000),
      query: end.requestedQuery,
      observed: end.observationsTimestamp,
      validFrom: end.validFromTimestamp,
      price: closePrice.toString(),
      decodedObservations: closeDecoded.observationsTimestamp
    },
    expected,
    marketWinner: actual,
    match: actual ? actual === expected : null
  };

  if (actual && actual !== expected) {
    throw new Error("Chainlink mismatch: expected " + expected + ", market=" + actual);
  }
  return diagnostics;
}

function parseJsonField(v, fallback) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function isTargetMarket(m, asset) {
  if (!m || typeof m.slug !== "string") return false;
  if (!m.slug.startsWith(asset.slug + "-") || !m.slug.match(/-\d+$/)) return false;

  const start = Date.parse(m.startDate || "");
  const end = Date.parse(m.endDate || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < START_MS || end - start < 4 * 60 * 1000 || end - start > 6 * 60 * 1000) return false;

  const raw = typeof m.raw === "string" ? parseJsonField(m.raw, {}) : (m.raw || {});
  const cfg = raw && raw.cryptoMarketConfig;
  const lookback = cfg && Number(cfg.twapLookbackSeconds);
  const resolution = String(m.resolutionSource || "").toLowerCase();
  const description = String(m.description || "").toLowerCase();
  const explicitly60 = lookback === 60 || resolution.includes("twap-60s") || description.includes("twap-60s");
  if (!explicitly60) return false;

  const q = String(m.question || "").toLowerCase();
  return q.includes("up or down") || m.slug.includes("updown-5m");
}

function winnerOf(m) {
  const outcomes = parseJsonField(m.outcomes, []);
  const prices = parseJsonField(m.outcomePrices, []);
  const winner = String(m.winner || "").toLowerCase();

  if (winner === "up" || winner === "down") return winner[0].toUpperCase() + winner.slice(1);

  for (let i = 0; i < outcomes.length; i++) {
    const o = String(outcomes[i]).toLowerCase();
    const p = Number(prices[i]);
    if ((o === "up" || o === "down") && p >= 0.999) return o[0].toUpperCase() + o.slice(1);
  }
  return null;
}

async function fetchMarketBySlug(slug) {
  if (marketCache.has(slug)) return marketCache.get(slug);
  const data = await getJson(API + "/markets?slug=" + encodeURIComponent(slug));
  const market = Array.isArray(data) ? data[0] : null;
  if (market) marketCache.set(slug, market);
  return market;
}

async function getHistoricalBoundaryReports(feedId, assetKey, fromMs, toMs, state) {
  const boundaries = [];
  const first = Math.ceil(fromMs / 300000) * 300000;
  for (let t = first; t <= toMs; t += 300000) boundaries.push(Math.floor(t / 1000));

  const found = new Map();
  let boundaryIndex = 0;
  let cursor = Math.floor(fromMs / 1000);
  let pages = 0;
  const limit = 10000;

  while (cursor <= Math.floor(toMs / 1000) && boundaryIndex < boundaries.length) {
    let payload = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        payload = await chainlinkJsonDirect(
          "/api/v1/reports/page?feedID=" + encodeURIComponent(feedId) +
          "&startTimestamp=" + cursor + "&limit=" + limit
        );
        break;
      } catch (e) {
        log("CHAINLINK_BACKFILL_RETRY", {
          asset: assetKey,
          feedId,
          cursor,
          attempt,
          error: String(e.message || e)
        });
        if (attempt < 4) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      }
    }

    const reports = Array.isArray(payload?.reports) ? payload.reports : [];
    if (!reports.length) break;
    pages++;

    for (const report of reports) {
      const validFrom = Number(report.validFromTimestamp);
      const observed = Number(report.observationsTimestamp);
      if (!Number.isFinite(validFrom) || !Number.isFinite(observed)) continue;

      while (boundaryIndex < boundaries.length && observed > boundaries[boundaryIndex]) {
        boundaryIndex++;
      }
      if (boundaryIndex >= boundaries.length) break;

      const boundary = boundaries[boundaryIndex];
      if (validFrom <= boundary && observed <= boundary) {
        found.set(boundary, report);
      }
    }

    const last = reports[reports.length - 1];
    const lastObserved = Number(last?.observationsTimestamp);
    if (!Number.isFinite(lastObserved) || lastObserved < cursor) break;
    cursor = lastObserved + 1;

    state.backfillChainlinkPages = Number(state.backfillChainlinkPages || 0) + 1;
    state.backfillChainlinkCursor = state.backfillChainlinkCursor || {};
    state.backfillChainlinkCursor[assetKey] = cursor;
    await saveState(state);

    log("CHAINLINK_BACKFILL_PAGE", {
      asset: assetKey,
      pages,
      cursor,
      reports: reports.length,
      boundariesFound: found.size,
      totalBoundaries: boundaries.length
    });

    if (reports.length < limit) break;
  }

  return { boundaries, found, pages };
}

async function backfill(state) {
  if (state.initialized && !state.backfillIncomplete) return state;

  log("BACKFILL_START", {
    start: new Date(START_MS).toISOString(),
    assets: ASSETS.map(a => a.key),
    source: "chainlink_reports_page_bulk",
    verification: "chainlink_twap60",
    gammaRole: "metadata_and_optional_winner_crosscheck"
  });

  const endMs = Math.floor(Date.now() / 300000) * 300000;
  const counts = state.backfillCounts && typeof state.backfillCounts === "object"
    ? Object.fromEntries(ASSETS.map(a => [a.key, Number(state.backfillCounts[a.key] || 0)]))
    : Object.fromEntries(ASSETS.map(a => [a.key, 0]));

  const processed = new Set(Array.isArray(state.backfillProcessedPeriods) ? state.backfillProcessedPeriods : []);
  const feeds = {};
  for (const asset of ASSETS) {
    const feed = await resolveTwap60Feed(asset);
    feeds[asset.key] = feed;
    log("CHAINLINK_BACKFILL_FEED", { asset: asset.key, feedId: feed.feedId, source: feed.source });
  }

  for (const asset of ASSETS) {
    const result = await getHistoricalBoundaryReports(
      feeds[asset.key].feedId,
      asset.key,
      START_MS,
      endMs,
      state
    );

    const boundaryReports = result.found;
    const boundaries = result.boundaries;
    let added = 0;
    let undetermined = 0;

    for (let i = 1; i < boundaries.length; i++) {
      const closeTs = boundaries[i];
      const openTs = boundaries[i - 1];
      const periodKey = "period-" + asset.key + "-" + openTs;
      if (processed.has(periodKey)) continue;

      const openReport = boundaryReports.get(openTs);
      const closeReport = boundaryReports.get(closeTs);
      if (!openReport || !closeReport) {
        undetermined++;
        continue;
      }

      try {
        const openDecoded = await decodeTwapReport(openReport.fullReport, openReport.feedID);
        const closeDecoded = await decodeTwapReport(closeReport.fullReport, closeReport.feedID);
        const winner = closeDecoded.price >= openDecoded.price ? "Up" : "Down";
        counts[asset.key] += winner === "Up" ? 1 : -1;
        processed.add(periodKey);
        added++;
      } catch (e) {
        undetermined++;
        log("CHAINLINK_BACKFILL_DECODE_ERROR", {
          asset: asset.key,
          periodKey,
          error: String(e.message || e)
        });
      }
    }

    state.backfillCounts = counts;
    state.backfillProcessedPeriods = Array.from(processed);
    state.backfillIncomplete = true;
    await saveState(state);

    log("CHAINLINK_BACKFILL_ASSET_DONE", {
      asset: asset.key,
      feedId: feeds[asset.key].feedId,
      pages: result.pages,
      boundaries: boundaries.length,
      added,
      undetermined,
      counts
    });
  }

  state.counts = counts;
  state.initialized = true;
  state.backfillIncomplete = false;
  state.backfillSource = "chainlink_reports_page_bulk";
  state.backfillVerification = "chainlink_twap60";
  state.backfillProcessedPeriods = Array.from(processed);
  state.lastBackfillAt = nowIso();
  await saveState(state);

  log("BACKFILL_DONE", {
    counts,
    processedPeriods: processed.size,
    source: "chainlink_reports_page_bulk",
    verification: "chainlink_twap60"
  });
  return state;
}

function ranking(counts) {
  return ASSETS.map(a => ({ asset: a.key, score: Number(counts[a.key] || 0) }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.asset.localeCompare(b.asset));
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (r.ok) return;
      const body = await r.text().catch(() => "");
      lastError = new Error("Telegram HTTP " + r.status + (body ? " " + body.slice(0, 200) : ""));
      if (r.status !== 429 && r.status < 500) break;
      await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    } catch (e) {
      lastError = e;
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError || new Error("Telegram send failed");
}

async function persistPeriod(periodKey, periodStart, results, state) {
  if (!db) return;
  await db.query(
    "INSERT INTO monitor_periods(period_key,period_start,processed_at,results,counts,leader) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(period_key) DO NOTHING",
    [periodKey, new Date(periodStart).toISOString(), nowIso(), JSON.stringify(results), JSON.stringify(state.counts), JSON.stringify(state.leader)]
  );
}

async function processClosedPeriod(state) {
  if (cycleBusy) return;
  cycleBusy = true;
  try {
    const now = Date.now();
    const currentStart = Math.floor(now / 300000) * 300000;
    const periodStart = currentStart - 300000;
    if (periodStart < START_MS) return;

    const periodKey = "period-" + Math.floor(periodStart / 1000);
    if (state.periods[periodKey]) return;

    const results = {};
    try {
      const feeds = [];
      for (const asset of ASSETS) {
        const feed = await resolveTwap60Feed(asset);
        if (feed?.feedId) feeds.push(feed.feedId);
      }
      await fetchChainlinkBulkReports(feeds, periodStart);
      await fetchChainlinkBulkReports(feeds, currentStart);
    } catch (e) {
      log("CHAINLINK_BULK_FALLBACK", {
        periodKey,
        error: String(e.message || e)
      });
    }
    for (const asset of ASSETS) {
      const slug = asset.slug + "-" + Math.floor(periodStart / 1000);
      try {
        const m = await fetchMarketBySlug(slug);
        if (!m) {
          log("PERIOD_WAIT", { periodKey, asset: asset.key, reason: "market_not_found", slug });
          return;
        }
        if (!isTargetMarket(m, asset)) {
          log("PERIOD_REJECTED", { periodKey, asset: asset.key, reason: "not_verified_twap60", slug });
          return;
        }
        const marketWinner = winnerOf(m);
        let chainlink;
        try {
          chainlink = await verifyTwapSettlement(asset, m, periodStart);
        } catch (e) {
          log("PERIOD_WAIT", {
            periodKey,
            asset: asset.key,
            reason: "chainlink_settlement_unavailable",
            slug,
            marketWinner,
            error: String(e.message || e)
          });
          return;
        }
        const w = chainlink.expected;
        if (marketWinner && marketWinner !== w) {
          log("PERIOD_ERROR", {
            periodKey,
            asset: asset.key,
            reason: "chainlink_market_winner_mismatch",
            slug,
            chainlinkWinner: w,
            marketWinner
          });
          return;
        }
        results[asset.key] = { winner: w, marketWinner: marketWinner || null, chainlink };
      } catch (e) {
        log("PERIOD_ERROR", { periodKey, asset: asset.key, error: String(e.message || e) });
        return;
      }
    }

    if (Object.keys(results).length !== ASSETS.length) return;

    const winners = Object.fromEntries(ASSETS.map(a => [a.key, results[a.key].winner]));
    for (const asset of ASSETS) state.counts[asset.key] += winners[asset.key] === "Up" ? 1 : -1;
    state.periods[periodKey] = results;
    state.lastProcessedPeriod = periodKey;
    state.lastProcessedAt = nowIso();

    const top = ranking(state.counts)[0];
    state.leader = top;
    state.diagnostic = {
      lastCycleAt: nowIso(),
      lastResults: winners,
      lastChainlink: Object.fromEntries(ASSETS.map(a => [a.key, results[a.key].chainlink])),
      processedAssets: Object.keys(results).length,
      pollingMs: POLL_MS,
      storage: db ? "postgres+file" : "file"
    };

    await saveState(state);
    await persistPeriod(periodKey, periodStart, winners, state);

    const nextStart = currentStart + 300000;
    const nextSlug = top.asset.toLowerCase() + "-updown-5m-" + Math.floor(nextStart / 1000);
    let nextMarket = null;
    try { nextMarket = await fetchMarketBySlug(nextSlug); } catch (e) {
      log("NEXT_MARKET_LOOKUP_ERROR", { asset: top.asset, slug: nextSlug, error: String(e.message || e) });
    }
    const link = nextMarket?.slug
      ? "https://polymarket.com/event/" + nextMarket.slug
      : "https://polymarket.com/event/" + nextSlug;
    const lines = [
      "5M CHAINLINK TWAP 60s",
      "",
      ...ASSETS.map(a => a.key + " → " + winners[a.key]),
      "",
      ...ranking(state.counts).map(x => x.asset + ": " + (x.score >= 0 ? "+" : "") + x.score),
      "",
      "IMBALANCE: " + top.asset + " " + (top.score >= 0 ? "+" : "") + top.score,
      link
    ];

    try {
      await sendTelegram(lines.join("\n"));
      log("ALERT_SENT", { period: periodKey, results: winners, chainlink: state.diagnostic.lastChainlink, counts: state.counts, leader: top });
    } catch (e) {
      delete state.periods[periodKey];
      for (const asset of ASSETS) state.counts[asset.key] -= winners[asset.key] === "Up" ? 1 : -1;
      state.lastProcessedPeriod = null;
      await saveState(state);
      log("TELEGRAM_ERROR", { period: periodKey, error: String(e.message || e) });
    }
  } finally {
    cycleBusy = false;
  }
}

async function main() {
  ensureDir(STATE_FILE);
  ensureDir(LOG_FILE);
  await initDb();

  let state = await restoreAndMigrate();
  runtimeState = state;
  startHealthServer();
  log("MONITOR_STARTING", {
    version: MONITOR_VERSION,
    pollingMs: POLL_MS,
    assets: ASSETS.map(a => a.key),
    persistentState: true,
    postgres: !!db,
    chainlink: !!(CHAINLINK_API_KEY && CHAINLINK_API_SECRET),
    startDate: new Date(START_MS).toISOString()
  });

  try {
    state = await backfill(state);
    runtimeState = state;
  } catch (e) {
    log("BACKFILL_ERROR", { error: String(e.message || e) });
  }

  await processClosedPeriod(state).catch(e => log("CYCLE_ERROR", { error: String(e.message || e) }));
  runtimeState = state;

  setInterval(async () => {
    try {
      state = await loadState();
      await processClosedPeriod(state);
    } catch (e) {
      log("CYCLE_ERROR", { error: String(e.message || e) });
    }
  }, POLL_MS);

  setInterval(() => {
    log("HEARTBEAT", {
      pollingMs: POLL_MS,
      lastProcessedPeriod: state.lastProcessedPeriod,
      leader: state.leader,
      counts: state.counts
    });
  }, 60_000);
}

process.on("SIGTERM", async () => {
  log("SHUTDOWN");
  if (db) await db.end().catch(() => {});
  process.exit(0);
});

process.on("SIGINT", async () => {
  log("SHUTDOWN");
  if (db) await db.end().catch(() => {});
  process.exit(0);
});

main().catch(e => {
  log("FATAL", { error: String(e.stack || e) });
  process.exit(1);
});