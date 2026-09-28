const http = require("http");

const VERSION = "4.0.0";
const POLL_MS = 10000;
const WINDOW_MS = 60000;
const BREAKOUT = 0.003;
const GAMMA_URL = "https://gamma-api.polymarket.com/events?tag_id=100639&active=true&closed=false&order=startTime&ascending=true&limit=500&offset=";
const CLOB_URL = "https://clob.polymarket.com/price";
const EVENT_URL = "https://polymarket.com/event/";
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = Number(process.env.PORT || 8080);

const history = new Map();
const lastAlert = new Map();
let stats = { events: 0, live: 0, markets: 0, prices: 0, alerts: 0, lastPoll: null, error: null };

function log(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), version: VERSION, event, ...data }));
}

function array(v) {
  if (Array.isArray(v)) return v;
  try { return JSON.parse(v || "[]"); } catch { return []; }
}

function live(event) {
  if (event.closed === true || event.ended === true) return false;
  if (event.live === true) return true;
  const status = String(event.gameStatus || event.status || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (["live", "in progress", "playing", "ongoing", "started", "halftime", "half time"].includes(status)) return true;
  if (["ended", "finished", "final", "cancelled", "canceled", "postponed", "suspended"].includes(status)) return false;
  const start = Date.parse(event.gameStartTime || event.startTime || event.startDate || "");
  return Number.isFinite(start) && start <= Date.now() && Date.now() - start < 12 * 60 * 60 * 1000;
}

async function get(url) {
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}

async function events() {
  const all = [];
  for (let offset = 0; offset < 2000; offset += 500) {
    const body = await get(GAMMA_URL + offset);
    const page = Array.isArray(body) ? body : body.data || [];
    all.push(...page);
    if (page.length < 500) break;
  }
  return [...new Map(all.map(e => [String(e.id), e])).values()];
}

function markets(events) {
  const out = [];
  for (const event of events) {
    if (!live(event) || !Array.isArray(event.markets)) continue;
    for (const market of event.markets) {
      if (market.closed === true || market.active === false || market.acceptingOrders === false) continue;
      const tokens = array(market.clobTokenIds).map(String);
      const outcomes = array(market.outcomes).map(String);
      tokens.forEach((tokenId, i) => {
        out.push({
          key: String(market.id || market.conditionId || event.id) + ":" + tokenId,
          market: String(market.id || market.conditionId || event.id),
          tokenId,
          title: String(event.title || event.name || market.question || "SPORTS"),
          outcome: outcomes[i] || "OUTCOME",
          url: String(event.slug || market.slug || "").trim()
            ? EVENT_URL + String(event.slug || market.slug).trim()
            : String(event.url || market.url || "")
        });
      });
    }
  }
  return [...new Map(out.map(x => [x.key, x])).values()];
}

async function price(tokenId) {
  try {
    const body = await get(CLOB_URL + "?token_id=" + encodeURIComponent(tokenId) + "&side=BUY");
    const p = Number(body.price ?? body.data?.price);
    return p > 0 && p < 1 ? p : null;
  } catch {
    return null;
  }
}

async function send(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  await fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(8000)
  });
}

function check(c, p) {
  const now = Date.now();
  const h = history.get(c.key) || [];
  h.push([now, p]);
  const recent = h.filter(x => now - x[0] <= WINDOW_MS);
  history.set(c.key, recent);

  if (recent.length < 2) return;

  const old = recent.slice(0, -1).map(x => x[1]);
  const lo = Math.min(...old);
  const hi = Math.max(...old);

  let direction = null;
  if (p >= hi + BREAKOUT) direction = "UP";
  if (p <= lo - BREAKOUT) direction = "DOWN";
  if (!direction) return;

  if (now - (lastAlert.get(c.market) || 0) < WINDOW_MS) return;
  lastAlert.set(c.market, now);

  const move = (p - (direction === "UP" ? hi : lo)) * 100;
  stats.alerts++;

  const message = [
    "BREAKOUT " + direction,
    "",
    c.title,
    "OUTCOME: " + c.outcome,
    "PRICE: " + p.toFixed(3),
    "MOVE: " + move.toFixed(1) + " pp",
    "",
    c.url
  ].join("\n");

  log("ALERT", { title: c.title, outcome: c.outcome, direction, price: p, movePp: move, url: c.url });
  send(message).catch(e => log("TELEGRAM_ERROR", { error: String(e.message || e) }));
}

async function poll() {
  const all = await events();
  const liveEvents = all.filter(live);
  const candidates = markets(all);
  let priceCount = 0;

  for (const c of candidates) {
    const p = await price(c.tokenId);
    if (p == null) continue;
    priceCount++;
    check(c, p);
  }

  stats = {
    events: all.length,
    live: liveEvents.length,
    markets: candidates.length,
    prices: priceCount,
    alerts: stats.alerts,
    lastPoll: new Date().toISOString(),
    error: null
  };

  log("POLL", stats);
}

function health(req, res) {
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ status: "ok", version: VERSION, strategy: "60S_RANGE_BREAKOUT", pollingMs: POLL_MS, ...stats }));
}

http.createServer((req, res) => {
  if (["/", "/health", "/status"].includes((req.url || "").split("?")[0])) return health(req, res);
  res.writeHead(404);
  res.end();
}).listen(PORT, "0.0.0.0");

log("START", { version: VERSION, pollingMs: POLL_MS, windowMs: WINDOW_MS, breakout: BREAKOUT });

(async () => {
  while (true) {
    try {
      await poll();
    } catch (e) {
      stats.error = String(e.message || e);
      log("ERROR", { error: stats.error });
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
})();
