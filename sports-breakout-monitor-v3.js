const http = require("http");

const VERSION = "3.2.0";
const POLL_MS = 10000;
const WINDOW_MS = 60000;
const MAX_RANGE = 0.03;
const BREAKOUT = 0.003;
const RUNTIME_MS = 5 * 60 * 60 * 1000 + 45 * 60 * 1000;
const MAX_CANDIDATES = 500;

const GAMMA_URL = "https://gamma-api.polymarket.com/events?tag_id=100639&related_tags=true&active=true&closed=false&limit=500";
const CLOB_PRICE_URL = "https://clob.polymarket.com/price";
const EVENT_URL = "https://polymarket.com/event/";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = Number(process.env.PORT || 8080);

const startedAt = Date.now();
const states = new Map();
const alertedMarkets = new Map();
let polling = false;
let alertsSent = 0;
let lastPollAt = null;
let lastError = null;
let emptyPolls = 0;

function log(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), version: VERSION, event, ...data }));
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function arr(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; }
}
function norm(v) { return String(v || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }

function explicitLive(event) {
  if (event?.ended === true || event?.closed === true) return false;
  if (event?.live === true) return true;
  const status = norm(event?.gameStatus || event?.status);
  if (["live", "in progress", "inprogress", "playing", "ongoing", "started", "halftime", "half time"].includes(status)) return true;
  if (["ended", "finished", "final", "cancelled", "canceled", "postponed", "suspended"].includes(status)) return false;
  const start = Date.parse(event?.gameStartTime || event?.startTime || event?.startDate || "");
  return Number.isFinite(start) && start <= Date.now() && Date.now() - start <= 12 * 60 * 60 * 1000;
}

function tokenIds(market) { return arr(market?.clobTokenIds).map(String).filter(Boolean); }
function outcomes(market) { return arr(market?.outcomes).map(String); }

function liveMarkets(events) {
  const out = [];
  for (const event of events) {
    if (!explicitLive(event)) continue;
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    for (const market of markets) {
      if (!market || market.closed === true || market.active === false || market.acceptingOrders === false) continue;
      const ids = tokenIds(market);
      if (!ids.length) continue;
      const outs = outcomes(market);
      const marketKey = String(market.id || market.conditionId || event.id);
      for (let i = 0; i < ids.length; i++) {
        out.push({
          key: marketKey + ":" + ids[i],
          marketKey,
          tokenId: ids[i],
          outcome: outs[i] || "OUTCOME " + (i + 1),
          title: String(event.title || event.name || market.question || "SPORTS"),
          url: String(event.slug || market.slug || "").trim() ? EVENT_URL + String(event.slug || market.slug).trim() : String(event.url || market.url || ""),
          marketType: String(market.sportsMarketType || market.marketType || ""),
          gameStatus: String(event.gameStatus || market.gameStatus || "")
        });
      }
    }
  }
  return Array.from(new Map(out.map(x => [x.key, x])).values()).slice(0, MAX_CANDIDATES);
}

async function json(url) {
  const r = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "Polymarket-Sports-Breakout-Monitor/3.1" },
    signal: AbortSignal.timeout(8000)
  });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function clobPrice(tokenId) {
  try {
    const body = await json(CLOB_PRICE_URL + "?token_id=" + encodeURIComponent(tokenId) + "&side=BUY");
    const p = num(body?.price ?? body?.data?.price);
    return p != null && p > 0 && p < 1 ? p : null;
  } catch (e) {
    log("CLOB_ERROR", { tokenId, error: String(e.message || e) });
    return null;
  }
}

async function prices(candidates) {
  const result = new Map();
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= candidates.length) return;
      const c = candidates[i];
      const p = await clobPrice(c.tokenId);
      if (p != null) result.set(c.key, p);
    }
  }
  await Promise.all(Array.from({ length: 10 }, worker));
  return result;
}

async function telegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return log("TELEGRAM_NOT_CONFIGURED");
  try {
    const r = await fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) log("TELEGRAM_ERROR", { status: r.status, body: (await r.text()).slice(0, 300) });
  } catch (e) { log("TELEGRAM_ERROR", { error: String(e.message || e) }); }
}

function observe(c, price) {
  const now = Date.now();
  let s = states.get(c.key);
  if (!s) {
    s = { history: [], candidate: null, title: c.title, outcome: c.outcome, url: c.url, marketKey: c.marketKey };
    states.set(c.key, s);
  }
  s.title = c.title; s.outcome = c.outcome; s.url = c.url;
  s.history.push({ t: now, p: price });
  s.history = s.history.filter(x => now - x.t <= WINDOW_MS);
  if (s.history.length < 6) return;

  const base = s.history.slice(0, -1).map(x => x.p);
  const current = s.history[s.history.length - 1].p;
  const lo = Math.min(...base);
  const hi = Math.max(...base);
  if (hi - lo > MAX_RANGE) { s.candidate = null; return; }

  let direction = null;
  if (current >= hi + BREAKOUT) direction = "UP";
  else if (current <= lo - BREAKOUT) direction = "DOWN";
  if (!direction) { s.candidate = null; return; }

  if (!s.candidate || s.candidate.direction !== direction) {
    s.candidate = { direction, price: current, t: now };
    log("BREAKOUT_CANDIDATE", { title: s.title, outcome: s.outcome, direction, price: current, marketKey: s.marketKey });
    return;
  }

  s.candidate = null;
  const lastAlert = alertedMarkets.get(s.marketKey) || 0;
  if (now - lastAlert < WINDOW_MS) return;
  alertedMarkets.set(s.marketKey, now);

  alertsSent++;
  const anchor = direction === "UP" ? hi : lo;
  const move = (current - anchor) * 100;
  const message = [
    "BREAKOUT " + direction,
    "",
    s.title,
    "OUTCOME: " + s.outcome,
    "PRICE: " + current.toFixed(3),
    "RANGE: " + lo.toFixed(3) + " - " + hi.toFixed(3),
    "MOVE: " + move.toFixed(1) + " pp",
    "",
    s.url
  ].join("\n");
  log("BREAKOUT_ALERT", { title: s.title, outcome: s.outcome, direction, price: current, range: [lo, hi], movePp: move, url: s.url });
  telegram(message);
}

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const body = await json(GAMMA_URL);
    const events = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    const live = events.filter(explicitLive);
    const candidates = liveMarkets(events);
    const ps = await prices(candidates);
    for (const c of candidates) {
      const p = ps.get(c.key);
      if (p != null) observe(c, p);
    }
    lastPollAt = new Date().toISOString();
    lastError = null;
    emptyPolls = candidates.length === 0 || ps.size === 0 ? emptyPolls + 1 : 0;
    if (emptyPolls === 3) await telegram("SPORTS MONITOR DIAGNOSTIC\nNo live CLOB candidates detected after 3 polls.\nEVENTS: " + events.length + "\nLIVE EVENTS: " + live.length + "\nCANDIDATES: " + candidates.length + "\nCLOB PRICES: " + ps.size);
    log("POLL", {
      events: events.length,
      liveEvents: live.length,
      candidates: candidates.length,
      clobPrices: ps.size,
      tracked: states.size,
      alertsSent,
      sample: candidates.slice(0, 5).map(c => ({ title: c.title, outcome: c.outcome, price: ps.get(c.key) ?? null, url: c.url }))
    });
  } catch (e) {
    lastError = String(e.message || e);
    log("POLL_ERROR", { error: lastError });
  } finally { polling = false; }
}

function health() {
  return { status: "ok", version: VERSION, strategy: "POLYMARKET_SPORTS_CLOB_COMPRESSION_BREAKOUT", pollingMs: POLL_MS, windowMs: WINDOW_MS, maxRange: MAX_RANGE, breakout: BREAKOUT, tracked: states.size, alertsSent, lastPollAt, lastError };
}

http.createServer((req, res) => {
  if (["/", "/health", "/status"].includes(String(req.url || "").split("?")[0])) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(health()));
  }
  res.writeHead(404); res.end();
}).listen(PORT, "0.0.0.0", () => log("HEALTH_LISTENING", { port: PORT, healthPath: "/health" }));

log("MONITOR_STARTING", { version: VERSION, strategy: "POLYMARKET_SPORTS_CLOB_COMPRESSION_BREAKOUT", gamma: GAMMA_URL, clob: CLOB_PRICE_URL, pollingMs: POLL_MS, windowMs: WINDOW_MS, maxRange: MAX_RANGE, breakout: BREAKOUT, maxCandidates: MAX_CANDIDATES });

(async () => {
  while (Date.now() - startedAt < RUNTIME_MS) {
    await poll();
    await sleep(POLL_MS);
  }
  log("RUNTIME_LIMIT_REACHED", { runtimeMs: Date.now() - startedAt });
  process.exit(0);
})();
