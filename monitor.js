const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const API = "https://gamma-api.polymarket.com";
const MONITOR_VERSION = "2.0.0";
const START_MS = Date.parse("2026-08-14T00:00:00Z");
const POLL_MS = 10_000;
const STATE_FILE = process.env.STATE_FILE || "/data/chainlink-imbalance-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/chainlink-imbalance.jsonl";

const ASSETS = [
  { key: "BTC", slug: "btc-updown-5m" },
  { key: "ETH", slug: "eth-updown-5m" },
  { key: "SOL", slug: "sol-updown-5m" },
  { key: "BNB", slug: "bnb-updown-5m" },
  { key: "XRP", slug: "xrp-updown-5m" },
  { key: "DOGE", slug: "doge-updown-5m" },
  { key: "HYPE", slug: "hype-updown-5m" }
];

let db = null;

function nowIso() { return new Date().toISOString(); }

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
  console.log(JSON.stringify(record));
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

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "Polymarket-Chainlink-Imbalance/2.0" }
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonField(v, fallback) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}

function isTargetMarket(m, asset) {
  if (!m || typeof m.slug !== "string") return false;
  if (!m.slug.startsWith(asset.slug + "-") || !m.slug.match(/-\\d+$/)) return false;

  const start = Date.parse(m.startDate || "");
  const end = Date.parse(m.endDate || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < START_MS || end - start < 4 * 60 * 1000 || end - start > 6 * 60 * 1000) return false;

  const raw = m.raw;
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
  const data = await getJson(API + "/markets?slug=" + encodeURIComponent(slug));
  return Array.isArray(data) ? data[0] : null;
}

async function backfill(state) {
  if (state.initialized) return state;

  log("BACKFILL_START", { start: new Date(START_MS).toISOString(), assets: ASSETS.map(a => a.key) });
  let offset = 0;
  let pages = 0;
  const seen = new Set();
  const counts = Object.fromEntries(ASSETS.map(a => [a.key, 0]));

  while (true) {
    const url = API + "/markets?closed=true&tag_slug=crypto&q=" + encodeURIComponent("Up or Down") +
      "&start_date_min=" + encodeURIComponent(new Date(START_MS).toISOString()) +
      "&limit=100&offset=" + offset + "&order=endDate&ascending=true";

    const rows = await getJson(url);
    if (!Array.isArray(rows) || rows.length === 0) break;
    pages++;

    for (const m of rows) {
      for (const asset of ASSETS) {
        if (!isTargetMarket(m, asset) || seen.has(m.id)) continue;
        const w = winnerOf(m);
        if (!w) continue;
        seen.add(m.id);
        counts[asset.key] += w === "Up" ? 1 : -1;
      }
    }

    log("BACKFILL_PAGE", { pages, offset, rows: rows.length, counts });
    if (rows.length < 100) break;
    offset += 100;
  }

  state.counts = counts;
  state.initialized = true;
  state.lastBackfillAt = nowIso();
  await saveState(state);
  log("BACKFILL_DONE", { pages, counts });
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

  const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false })
  });
  if (!r.ok) throw new Error("Telegram HTTP " + r.status);
}

async function persistPeriod(periodKey, periodStart, results, state) {
  if (!db) return;
  await db.query(
    "INSERT INTO monitor_periods(period_key,period_start,processed_at,results,counts,leader) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(period_key) DO NOTHING",
    [periodKey, new Date(periodStart).toISOString(), nowIso(), JSON.stringify(results), JSON.stringify(state.counts), JSON.stringify(state.leader)]
  );
}

async function processClosedPeriod(state) {
  const now = Date.now();
  const currentStart = Math.floor(now / 300000) * 300000;
  const periodStart = currentStart - 300000;
  if (periodStart < START_MS) return;

  const periodKey = "period-" + Math.floor(periodStart / 1000);
  if (state.periods[periodKey]) return;

  const results = {};
  for (const asset of ASSETS) {
    const slug = asset.slug + "-" + Math.floor(periodStart / 1000);
    try {
      const m = await fetchMarketBySlug(slug);
      if (!m) {
        log("PERIOD_WAIT", { periodKey, asset: asset.key, reason: "market_not_found", slug });
        return;
      }
      const w = winnerOf(m);
      if (!w) {
        log("PERIOD_WAIT", { periodKey, asset: asset.key, reason: "winner_not_final", slug });
        return;
      }
      if (!isTargetMarket(m, asset)) {
        log("PERIOD_REJECTED", { periodKey, asset: asset.key, reason: "not_verified_twap60", slug });
        return;
      }
      results[asset.key] = w;
    } catch (e) {
      log("PERIOD_ERROR", { periodKey, asset: asset.key, error: String(e.message || e) });
      return;
    }
  }

  if (Object.keys(results).length !== ASSETS.length) return;

  for (const asset of ASSETS) state.counts[asset.key] += results[asset.key] === "Up" ? 1 : -1;
  state.periods[periodKey] = results;
  state.lastProcessedPeriod = periodKey;
  state.lastProcessedAt = nowIso();

  const top = ranking(state.counts)[0];
  state.leader = top;
  state.diagnostic = {
    lastCycleAt: nowIso(),
    lastResults: results,
    processedAssets: Object.keys(results).length,
    pollingMs: POLL_MS,
    storage: db ? "postgres+file" : "file"
  };

  await saveState(state);
  await persistPeriod(periodKey, periodStart, results, state);

  const nextStart = currentStart + 300000;
  const link = "https://polymarket.com/event/" + top.asset.toLowerCase() + "-updown-5m-" + Math.floor(nextStart / 1000);
  const lines = [
    "5M CHAINLINK TWAP 60s",
    "",
    ...ASSETS.map(a => a.key + " → " + results[a.key]),
    "",
    ...ranking(state.counts).map(x => x.asset + ": " + (x.score >= 0 ? "+" : "") + x.score),
    "",
    "IMBALANCE: " + top.asset + " " + (top.score >= 0 ? "+" : "") + top.score,
    link
  ];

  try {
    await sendTelegram(lines.join("\\n"));
    log("ALERT_SENT", { period: periodKey, results, counts: state.counts, leader: top });
  } catch (e) {
    delete state.periods[periodKey];
    for (const asset of ASSETS) state.counts[asset.key] -= results[asset.key] === "Up" ? 1 : -1;
    state.lastProcessedPeriod = null;
    await saveState(state);
    log("TELEGRAM_ERROR", { period: periodKey, error: String(e.message || e) });
  }
}

async function main() {
  ensureDir(STATE_FILE);
  ensureDir(LOG_FILE);
  await initDb();

  let state = await restoreAndMigrate();
  log("MONITOR_STARTING", {
    version: MONITOR_VERSION,
    pollingMs: POLL_MS,
    assets: ASSETS.map(a => a.key),
    persistentState: true,
    postgres: !!db,
    startDate: new Date(START_MS).toISOString()
  });

  try {
    state = await backfill(state);
  } catch (e) {
    log("BACKFILL_ERROR", { error: String(e.message || e) });
  }

  await processClosedPeriod(state).catch(e => log("CYCLE_ERROR", { error: String(e.message || e) }));

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
