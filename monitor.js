const fs = require("fs");
const path = require("path");

const API = "https://gamma-api.polymarket.com";
const STATE_FILE = process.env.STATE_FILE || "/data/chainlink-imbalance-state.json";
const START_MS = Date.parse("2026-08-14T00:00:00Z");
const POLL_MS = 15000;

const ASSETS = [
  { key: "BTC", slug: "btc-updown-5m" },
  { key: "ETH", slug: "eth-updown-5m" },
  { key: "SOL", slug: "sol-updown-5m" },
  { key: "BNB", slug: "bnb-updown-5m" },
  { key: "XRP", slug: "xrp-updown-5m" },
  { key: "DOGE", slug: "doge-updown-5m" },
  { key: "HYPE", slug: "hype-updown-5m" }
];

function log(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...data }));
}

function ensureDir() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

function save(state) {
  ensureDir();
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      version: 1,
      startMs: START_MS,
      initialized: false,
      counts: Object.fromEntries(ASSETS.map(a => [a.key, 0])),
      processed: {}
    };
  }
}

async function getJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { "accept": "application/json", "user-agent": "Polymarket-Chainlink-Imbalance/1.0" }
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
  if (!m.slug.startsWith(asset.slug + "-")) return false;
  if (!m.slug.match(/-\\d+$/)) return false;
  const start = Date.parse(m.startDate || "");
  const end = Date.parse(m.endDate || "");
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  if (start < START_MS || end - start < 4 * 60 * 1000 || end - start > 6 * 60 * 1000) return false;

  const raw = m.raw;
  const cfg = raw && raw.cryptoMarketConfig;
  const lookback = cfg && Number(cfg.twapLookbackSeconds);
  if (lookback && lookback !== 60) return false;

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
    if ((o === "up" || o === "down") && p >= 0.999) {
      return o[0].toUpperCase() + o.slice(1);
    }
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

  // Gamma supports date filtering, pagination and tag filtering. We fetch the
  // crypto archive once, then keep only the seven 5m markets using 60s TWAP.
  const seen = new Set();
  let offset = 0;
  let pages = 0;
  const counts = Object.fromEntries(ASSETS.map(a => [a.key, 0]));

  while (true) {
    const url = API + "/markets?closed=true&tag_slug=crypto" +
      "&start_date_min=" + encodeURIComponent(new Date(START_MS).toISOString()) +
      "&limit=100&offset=" + offset + "&order=endDate&ascending=true";
    const rows = await getJson(url);
    if (!Array.isArray(rows) || rows.length === 0) break;

    pages++;
    let oldestBeyond = false;

    for (const m of rows) {
      const end = Date.parse(m.endDate || "");
      if (Number.isFinite(end) && end < START_MS) continue;
      if (Number.isFinite(end) && end > Date.now() + 24 * 60 * 60 * 1000) oldestBeyond = true;

      for (const asset of ASSETS) {
        if (!isTargetMarket(m, asset)) continue;
        if (seen.has(m.id)) continue;
        const w = winnerOf(m);
        if (!w) continue;
        seen.add(m.id);
        counts[asset.key] += w === "Up" ? 1 : -1;
        state.processed[m.slug] = w;
      }
    }

    log("BACKFILL_PAGE", { pages, offset, rows: rows.length, counts });

    if (rows.length < 100 || oldestBeyond) break;
    offset += 100;
  }

  state.counts = counts;
  state.initialized = true;
  state.lastBackfillAt = new Date().toISOString();
  save(state);
  log("BACKFILL_DONE", { pages, counts });
  return state;
}

function ranking(counts) {
  return ASSETS
    .map(a => ({ asset: a.key, score: Number(counts[a.key] || 0) }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.asset.localeCompare(b.asset));
}

function nextSlug(asset) {
  const now = Date.now();
  const nextStart = Math.floor(now / 300000) * 300000 + 300000;
  return asset.slug + "-" + Math.floor(nextStart / 1000);
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");

  const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      disable_web_page_preview: false
    })
  });
  if (!r.ok) throw new Error("Telegram HTTP " + r.status);
}

async function processClosedPeriods(state) {
  for (const asset of ASSETS) {
    const now = Date.now();
    const currentStart = Math.floor(now / 300000) * 300000;
    const candidates = [currentStart - 300000, currentStart - 600000];

    for (const start of candidates) {
      if (start < START_MS) continue;
      const slug = asset.slug + "-" + Math.floor(start / 1000);
      if (state.processed[slug]) continue;

      try {
        const m = await fetchMarketBySlug(slug);
        if (!m) continue;

        const mStart = Date.parse(m.startDate || "");
        const mEnd = Date.parse(m.endDate || "");
        if (!Number.isFinite(mStart) || !Number.isFinite(mEnd) || mStart < START_MS) continue;

        const w = winnerOf(m);
        if (!w) continue;

        state.counts[asset.key] += w === "Up" ? 1 : -1;
        state.processed[slug] = w;
        state.lastProcessedAt = new Date().toISOString();
        save(state);

        const top = ranking(state.counts)[0];
        const leader = ASSETS.find(a => a.key === top.asset);
        const link = "https://polymarket.com/event/" + nextSlug(leader);

        const lines = [
          "5M CHAINLINK TWAP 60s",
          "",
          asset.key + " → " + w,
          "",
          ...ranking(state.counts).map(x => x.asset + ": " + (x.score >= 0 ? "+" : "") + x.score),
          "",
          "IMBALANCE: " + top.asset + " " + (top.score >= 0 ? "+" : "") + top.score,
          link
        ];

        await sendTelegram(lines.join("\n"));
        log("ALERT_SENT", { asset: asset.key, winner: w, counts: state.counts, leader: top });
      } catch (e) {
        log("PERIOD_ERROR", { asset: asset.key, slug, error: String(e.message || e) });
      }
    }
  }
}

async function main() {
  log("MONITOR_START", {
    start: new Date(START_MS).toISOString(),
    twapSeconds: 60,
    assets: ASSETS.map(a => a.key),
    pollMs: POLL_MS
  });

  let state = load();
  state = await backfill(state);

  while (true) {
    try {
      await processClosedPeriods(state);
    } catch (e) {
      log("LOOP_ERROR", { error: String(e.message || e) });
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

main().catch(e => {
  log("FATAL", { error: String(e.stack || e) });
  process.exit(1);
});
