const http = require("http");

const VERSION = "2.1.0";
const POLL_MS = 10000;
const COMPRESSION_WINDOW_MS = 60000;
const MAX_COMPRESSION_RANGE = 0.02;
const BREAKOUT_CONFIRM_PRICE = 0.005;
const ALERT_COOLDOWN_MS = 120000;
const RUNTIME_MS = 5 * 60 * 60 * 1000 + 45 * 60 * 1000;

const SPORTS_EVENTS_URL = "https://gamma-api.polymarket.com/events?tag_id=100639&related_tags=true&live=true&closed=false&limit=500";
const CLOB_PRICE_URL = "https://clob.polymarket.com/price";
const POLYMARKET_EVENT_URL = "https://polymarket.com/event/";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = Number(process.env.PORT || 8080);

const startedAt = Date.now();
const markets = new Map();
let pollRunning = false;
let alertsSent = 0;
let lastPollAt = null;
let lastError = null;
let liveCandidates = 0;
let liveEvents = 0;
let clobPricesRead = 0;
let clobPriceErrors = 0;

function log(event, data = {}) {
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    version: VERSION,
    event,
    ...data
  }));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return null;
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstFinite(values) {
  for (const value of values) {
    const n = toNum(value);
    if (n != null) return n;
  }
  return null;
}

function isLiveStatus(value) {
  const s = norm(value);
  return [
    "live",
    "in progress",
    "inprogress",
    "halftime",
    "half time",
    "playing",
    "ongoing",
    "started"
  ].includes(s);
}

function isEndedStatus(value) {
  const s = norm(value);
  return [
    "ended",
    "finished",
    "final",
    "cancelled",
    "canceled",
    "postponed",
    "suspended"
  ].includes(s);
}

function eventIsLive(event) {
  if (event?.live === true) return true;
  if (event?.ended === true) return false;
  if (isLiveStatus(event?.gameStatus)) return true;
  return false;
}

function isSupportedMarket(market) {
  const type = norm(market?.sportsMarketType || market?.marketType || "");
  return /(^| )(moneyline|child moneyline|esports match result|tennis completed match|cricket completed match|match winner|winner|race winner|head to head|f1 head to head|f1 race winner|nhl period result|map participant win one|map participant win total)( |$)/.test(type);
}

function parseTokenIds(market) {
  return parseArray(market?.clobTokenIds)?.map(String).filter(Boolean) || [];
}

function parseOutcomes(market) {
  return parseArray(market?.outcomes)?.map(String) || [];
}

function parseEventMarkets(event) {
  const nested = Array.isArray(event?.markets) ? event.markets : [];
  return nested.filter(m => m && typeof m === "object");
}

function eventUrl(event, market) {
  const slug = String(event?.slug || market?.slug || "").trim();
  return slug ? POLYMARKET_EVENT_URL + slug : "https://polymarket.com";
}

function buildCandidates(events) {
  const out = [];

  for (const event of events) {
    if (!eventIsLive(event)) continue;

    for (const market of parseEventMarkets(event)) {
      if (market?.closed === true || market?.active === false || market?.acceptingOrders === false) continue;
      if (!isSupportedMarket(market)) continue;

      const tokenIds = parseTokenIds(market);
      const outcomes = parseOutcomes(market);
      if (tokenIds.length < 2) continue;

      const limit = Math.min(tokenIds.length, outcomes.length || tokenIds.length, 3);
      for (let i = 0; i < limit; i++) {
        if (!tokenIds[i]) continue;
        out.push({
          key: String(market?.id || market?.conditionId || event?.id || "") + ":" + tokenIds[i],
          eventId: String(event?.id || ""),
          marketId: String(market?.id || ""),
          tokenId: tokenIds[i],
          outcome: outcomes[i] || ("OUTCOME " + (i + 1)),
          title: String(event?.title || event?.name || market?.question || "SPORTS"),
          question: String(market?.question || ""),
          url: eventUrl(event, market),
          sport: String(event?.sport || market?.sport || "SPORTS"),
          marketType: String(market?.sportsMarketType || market?.marketType || ""),
          gameStatus: String(event?.gameStatus || market?.gameStatus || ""),
          gameStartTime: String(event?.gameStartTime || market?.gameStartTime || event?.startTime || "")
        });
      }
    }
  }

  const unique = new Map();
  for (const item of out) unique.set(item.key, item);
  return Array.from(unique.values()).slice(0, 120);
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Polymarket-Sports-Breakout-Monitor/2.0"
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.json();
}

async function getClobPrice(tokenId) {
  const url = CLOB_PRICE_URL + "?token_id=" + encodeURIComponent(tokenId) + "&side=buy";
  try {
    const body = await getJson(url);
    const price = firstFinite([body?.price, body?.data?.price]);
    if (price == null || price <= 0 || price >= 1) {
      clobPriceErrors++;
      return null;
    }
    clobPricesRead++;
    return price;
  } catch (e) {
    clobPriceErrors++;
    log("CLOB_PRICE_ERROR", {
      tokenId,
      error: String(e.message || e)
    });
    return null;
  }
}

async function getPricesLimited(candidates) {
  const results = new Map();
  const concurrency = 8;
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= candidates.length) return;
      const candidate = candidates[index];
      const price = await getClobPrice(candidate.tokenId);
      if (price != null) results.set(candidate.key, price);
    }
  }

  await Promise.all(Array.from({length: concurrency}, worker));
  return results;
}

function updateCompression(candidate, price) {
  const now = Date.now();
  let state = markets.get(candidate.key);

  if (!state) {
    state = {
      history: [],
      alertedAt: 0,
      title: candidate.title,
      question: candidate.question,
      outcome: candidate.outcome,
      url: candidate.url,
      sport: candidate.sport,
      marketType: candidate.marketType,
      gameStatus: candidate.gameStatus,
      breakoutCandidate: null
    };
    markets.set(candidate.key, state);
  }

  state.title = candidate.title;
  state.question = candidate.question;
  state.outcome = candidate.outcome;
  state.url = candidate.url || state.url;
  state.sport = candidate.sport;
  state.marketType = candidate.marketType;
  state.gameStatus = candidate.gameStatus;

  state.history.push({ts: now, price});
  state.history = state.history.filter(x => now - x.ts <= COMPRESSION_WINDOW_MS);

  if (state.history.length < 6) return;

  const values = state.history.map(x => x.price).filter(Number.isFinite);
  if (values.length < 6) return;

  const current = values[values.length - 1];
  const previousValues = values.slice(0, -1);
  if (previousValues.length < 5) return;

  const previousMin = Math.min(...previousValues);
  const previousMax = Math.max(...previousValues);
  const previousRange = previousMax - previousMin;

  if (previousRange > MAX_COMPRESSION_RANGE) return;

  let direction = null;
  if (current >= previousMax + BREAKOUT_CONFIRM_PRICE) direction = "UP";
  if (current <= previousMin - BREAKOUT_CONFIRM_PRICE) direction = "DOWN";

  if (!direction) {
    state.breakoutCandidate = null;
    return;
  }

  if (now - state.alertedAt < ALERT_COOLDOWN_MS) return;

  if (!state.breakoutCandidate || state.breakoutCandidate.direction !== direction) {
    state.breakoutCandidate = {direction, price: current, ts: now};
    log("BREAKOUT_CANDIDATE", {
      title: state.title,
      outcome: state.outcome,
      direction,
      price: current
    });
    return;
  }

  state.breakoutCandidate = null;

  state.alertedAt = now;
  alertsSent++;

  const anchor = direction === "UP" ? previousMax : previousMin;
  const move = (current - anchor) * 100;

  const message = [
    "BREAKOUT " + direction,
    "",
    state.title,
    "OUTCOME: " + state.outcome,
    "PRICE: " + current.toFixed(3),
    "COMPRESSION: " + previousMin.toFixed(3) + " - " + previousMax.toFixed(3),
    "MOVE: " + move.toFixed(1) + " pp",
    state.gameStatus ? "STATUS: " + state.gameStatus : null,
    "",
    state.url
  ].filter(Boolean).join("\n");

  log("BREAKOUT_ALERT", {
    title: state.title,
    outcome: state.outcome,
    direction,
    price: current,
    compressionMin: previousMin,
    compressionMax: previousMax,
    movePp: move,
    url: state.url
  });

  sendTelegram(message).catch(e => log("TELEGRAM_ASYNC_ERROR", {
    error: String(e.message || e)
  }));
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    log("TELEGRAM_NOT_CONFIGURED");
    return false;
  }

  try {
    const r = await fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (!r.ok) {
      const body = await r.text();
      log("TELEGRAM_ERROR", {status: r.status, body: body.slice(0, 500)});
      return false;
    }

    return true;
  } catch (e) {
    log("TELEGRAM_ERROR", {error: String(e.message || e)});
    return false;
  }
}

async function poll() {
  if (pollRunning) return;
  pollRunning = true;

  try {
    const body = await getJson(SPORTS_EVENTS_URL);
    const events = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : []);
    const live = events.filter(eventIsLive);
    const candidates = buildCandidates(events);
    const prices = await getPricesLimited(candidates);

    const seenKeys = new Set();
    for (const candidate of candidates) {
      const price = prices.get(candidate.key);
      if (price == null) continue;
      seenKeys.add(candidate.key);
      updateCompression(candidate, price);
    }

    for (const [key, state] of markets) {
      if (!seenKeys.has(key)) {
        state.history = state.history.filter(x => Date.now() - x.ts <= COMPRESSION_WINDOW_MS);
      }
    }

    liveEvents = live.length;
    liveCandidates = candidates.length;
    lastPollAt = new Date().toISOString();
    lastError = null;

    log("POLL", {
      sportsEvents: events.length,
      liveEvents: live.length,
      liveCandidates: candidates.length,
      clobPrices: prices.size,
      trackedMarkets: markets.size,
      sample: candidates.slice(0, 5).map(c => ({
        title: c.title,
        outcome: c.outcome,
        marketType: c.marketType,
        price: prices.get(c.key) ?? null,
        url: c.url
      }))
    });
  } catch (e) {
    lastError = String(e.message || e);
    log("POLL_ERROR", {error: lastError});
  } finally {
    pollRunning = false;
  }
}

function health() {
  return {
    status: "ok",
    version: VERSION,
    strategy: "POLYMARKET_SPORTS_CLOB_COMPRESSION_BREAKOUT",
    discovery: SPORTS_EVENTS_URL,
    priceSource: CLOB_PRICE_URL + "?token_id=...&side=buy",
    pollingMs: POLL_MS,
    compressionWindowMs: COMPRESSION_WINDOW_MS,
    maxCompressionRange: MAX_COMPRESSION_RANGE,
    breakoutConfirmPrice: BREAKOUT_CONFIRM_PRICE,
    alertsSent,
    liveEvents,
    liveCandidates,
    clobPricesRead,
    clobPriceErrors,
    trackedMarkets: markets.size,
    startedAt: new Date(startedAt).toISOString(),
    lastPollAt,
    lastError,
    runtimeLimitMs: RUNTIME_MS
  };
}

http.createServer((req, res) => {
  const p = String(req.url || "/").split("?")[0];

  if (p === "/" || p === "/health" || p === "/status") {
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store"
    });
    return res.end(JSON.stringify(health()));
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, "0.0.0.0", () => {
  log("HEALTH_LISTENING", {port: PORT});
});

log("MONITOR_STARTING", {
  version: VERSION,
  strategy: "POLYMARKET_SPORTS_CLOB_COMPRESSION_BREAKOUT",
  discovery: SPORTS_EVENTS_URL,
  priceSource: CLOB_PRICE_URL,
  pollingMs: POLL_MS,
  compressionWindowMs: COMPRESSION_WINDOW_MS,
  maxCompressionRange: MAX_COMPRESSION_RANGE,
  breakoutConfirmPrice: BREAKOUT_CONFIRM_PRICE,
  runtimeMs: RUNTIME_MS
});

(async () => {
  while (Date.now() - startedAt < RUNTIME_MS) {
    await poll();
    await sleep(POLL_MS);
  }

  log("RUNTIME_LIMIT_REACHED", {
    runtimeMs: Date.now() - startedAt
  });

  process.exit(0);
})();
