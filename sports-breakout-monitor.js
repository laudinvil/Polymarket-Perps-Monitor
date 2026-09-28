const http = require("http");

const VERSION = "1.0.0";
const POLL_MS = 15000;
const COMPRESSION_WINDOW_MS = 60000;
const MAX_COMPRESSION_RANGE = 0.02;
const BREAKOUT_CONFIRM_PRICE = 0.005;
const ALERT_COOLDOWN_MS = 120000;
const RUNTIME_MS = 5 * 60 * 60 * 1000 + 45 * 60 * 1000;

const LIVE_URL = "https://football-live-api.vercel.app/api/matches/live";
const GAMMA_URL = "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=500";

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PORT = Number(process.env.PORT || 8080);

const startedAt = Date.now();
const matches = new Map();
let pollRunning = false;
let alertsSent = 0;
let lastPollAt = null;
let lastError = null;

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

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s) {
  return norm(s).split(/\s+/).filter(x => x.length >= 3);
}

function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(A.size, B.size);
}

function toNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function extractLiveMatches(body) {
  const data = body?.data;
  const leagues = Array.isArray(data?.leagues) ? data.leagues : [];
  const out = [];
  for (const league of leagues) {
    for (const m of (Array.isArray(league?.matches) ? league.matches : [])) {
      const started = m?.status?.started === true;
      const finished = m?.status?.finished === true;
      if (!started || finished) continue;
      out.push({
        id: String(m.id ?? ""),
        home: String(m.home?.name ?? ""),
        away: String(m.away?.name ?? ""),
        homeScore: toNum(m.home?.score ?? m.home?.currentScore ?? 0) ?? 0,
        awayScore: toNum(m.away?.score ?? m.away?.currentScore ?? 0) ?? 0,
        league: String(league?.name ?? ""),
        raw: m
      });
    }
  }
  return out.filter(x => x.id && x.home && x.away);
}

function eventText(event) {
  return [
    event?.title,
    event?.name,
    event?.slug,
    event?.description,
    event?.question
  ].filter(Boolean).join(" ");
}

function isFootballEvent(event) {
  const text = norm(eventText(event));
  return /football|soccer|premier league|la liga|serie a|bundesliga|ligue 1|champions league|europa league|conference league|mls|eredivisie|primeira|super lig|liga mx|brasileirao|copa/.test(text);
}

function parseMarkets(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const result = [];
  for (const market of markets) {
    let prices = market?.outcomePrices;
    if (typeof prices === "string") {
      try { prices = JSON.parse(prices); } catch { prices = null; }
    }
    let outcomes = market?.outcomes;
    if (typeof outcomes === "string") {
      try { outcomes = JSON.parse(outcomes); } catch { outcomes = null; }
    }
    if (!Array.isArray(prices) || !prices.length) continue;
    const p = prices.map(toNum);
    result.push({
      question: String(market?.question ?? event?.title ?? event?.name ?? ""),
      slug: String(market?.slug ?? event?.slug ?? ""),
      url: market?.slug ? "https://polymarket.com/event/" + market.slug : (event?.slug ? "https://polymarket.com/event/" + event.slug : null),
      outcomes: Array.isArray(outcomes) ? outcomes.map(String) : [],
      prices: p
    });
  }
  return result;
}

function findMatchMarket(live, events) {
  let best = null;
  for (const event of events) {
    if (!isFootballEvent(event)) continue;
    const text = eventText(event);
    const homeScore = similarity(live.home, text);
    const awayScore = similarity(live.away, text);
    const direct = Math.min(homeScore, awayScore);
    if (direct < 0.45) continue;
    const markets = parseMarkets(event);
    for (const market of markets) {
      const q = norm(market.question);
      if (!/(win|winner|match|game|draw|vs)/.test(q)) continue;
      const candidate = {
        event,
        market,
        score: direct + (homeScore + awayScore) * 0.25
      };
      if (!best || candidate.score > best.score) best = candidate;
    }
  }
  return best;
}

function getOutcomePrices(market) {
  const labels = market.outcomes;
  const prices = market.prices;
  const out = {};
  for (let i = 0; i < prices.length; i++) {
    const label = norm(labels[i] || "");
    if (label.includes("yes") || label === "home" || label === "team 1") out.home = prices[i];
    else if (label.includes("no") || label === "away" || label === "team 2") out.away = prices[i];
    else if (label.includes("draw")) out.draw = prices[i];
  }
  if (out.home == null && prices[0] != null) out.home = prices[0];
  if (out.away == null && prices[1] != null) out.away = prices[1];
  if (out.draw == null && prices[2] != null) out.draw = prices[2];
  return out;
}

function updateCompression(key, live, market) {
  const prices = getOutcomePrices(market);
  const now = Date.now();
  let state = matches.get(key);
  if (!state) {
    state = {
      history: [],
      alertedAt: 0,
      home: live.home,
      away: live.away,
      score: live.homeScore + "-" + live.awayScore,
      url: market.url,
      marketQuestion: market.question
    };
    matches.set(key, state);
  }

  state.home = live.home;
  state.away = live.away;
  state.score = live.homeScore + "-" + live.awayScore;
  state.url = market.url || state.url;
  state.marketQuestion = market.question;

  const point = {
    ts: now,
    home: prices.home,
    away: prices.away,
    draw: prices.draw
  };
  state.history.push(point);
  state.history = state.history.filter(x => now - x.ts <= COMPRESSION_WINDOW_MS);

  const candidates = [
    ["HOME", state.history.map(x => x.home).filter(Number.isFinite)],
    ["AWAY", state.history.map(x => x.away).filter(Number.isFinite)]
  ];

  for (const [side, values] of candidates) {
    if (values.length < 6) continue;
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max - min > MAX_COMPRESSION_RANGE) continue;

    const current = values[values.length - 1];
    const previous = values.slice(0, -1).reduce((a, b) => Math.max(a, b), -Infinity);
    const previousMin = values.slice(0, -1).reduce((a, b) => Math.min(a, b), Infinity);

    let direction = null;
    let breakoutPrice = null;
    if (current >= max && current - previousMin >= BREAKOUT_CONFIRM_PRICE && current - min >= BREAKOUT_CONFIRM_PRICE) {
      direction = "UP";
      breakoutPrice = current;
    } else if (current <= min && previous - current >= BREAKOUT_CONFIRM_PRICE && max - current >= BREAKOUT_CONFIRM_PRICE) {
      direction = "DOWN";
      breakoutPrice = current;
    }

    if (!direction) continue;
    if (now - state.alertedAt < ALERT_COOLDOWN_MS) continue;

    state.alertedAt = now;
    alertsSent++;
    const message = [
      "BREAKOUT " + direction,
      "",
      live.home + " vs " + live.away,
      "SCORE: " + state.score,
      "MARKET: " + side,
      "COMPRESSION: " + min.toFixed(3) + " - " + max.toFixed(3),
      "BREAKOUT: " + Number(breakoutPrice).toFixed(3),
      "MOVE: " + ((breakoutPrice - (direction === "UP" ? min : max)) * 100).toFixed(1) + " pp",
      "",
      state.url || "https://polymarket.com"
    ].join("\n");

    log("BREAKOUT_ALERT", {
      match: live.home + " vs " + live.away,
      side,
      direction,
      score: state.score,
      compressionMin: min,
      compressionMax: max,
      breakoutPrice,
      url: state.url
    });
    sendTelegram(message).catch(e => log("TELEGRAM_ASYNC_ERROR", { error: String(e.message || e) }));
  }
}

async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    log("TELEGRAM_NOT_CONFIGURED");
    return false;
  }
  try {
    const r = await fetch("https://api.telegram.org/bot" + TELEGRAM_TOKEN + "/sendMessage", {
      method: "POST",
      headers: {"content-type":"application/json"},
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true
      }),
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) {
      const body = await r.text();
      log("TELEGRAM_ERROR", { status: r.status, body: body.slice(0, 500) });
      return false;
    }
    return true;
  } catch (e) {
    log("TELEGRAM_ERROR", { error: String(e.message || e) });
    return false;
  }
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: {accept:"application/json","user-agent":"Polymarket-Sports-Breakout-Monitor/1.0"},
    signal: AbortSignal.timeout(12000)
  });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url);
  return r.json();
}

async function poll() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    const [liveBody, gammaBody] = await Promise.all([
      getJson(LIVE_URL),
      getJson(GAMMA_URL)
    ]);
    const live = extractLiveMatches(liveBody);
    const events = Array.isArray(gammaBody) ? gammaBody : (Array.isArray(gammaBody?.data) ? gammaBody.data : []);
    let matched = 0;

    for (const match of live) {
      const found = findMatchMarket(match, events);
      if (!found) continue;
      matched++;
      updateCompression(match.id + ":" + found.market.question, match, found.market);
    }

    lastPollAt = new Date().toISOString();
    lastError = null;
    log("POLL", {
      liveMatches: live.length,
      footballMarkets: events.filter(isFootballEvent).length,
      matched,
      tracked: matches.size
    });
  } catch (e) {
    lastError = String(e.message || e);
    log("POLL_ERROR", { error: lastError });
  } finally {
    pollRunning = false;
  }
}

function health() {
  return {
    status: "ok",
    version: VERSION,
    strategy: "SPORTS_POLYMARKET_COMPRESSION_BREAKOUT",
    sport: "football",
    pollingMs: POLL_MS,
    compressionWindowMs: COMPRESSION_WINDOW_MS,
    maxCompressionRange: MAX_COMPRESSION_RANGE,
    breakoutConfirmPrice: BREAKOUT_CONFIRM_PRICE,
    alertsSent,
    trackedMatches: matches.size,
    startedAt: new Date(startedAt).toISOString(),
    lastPollAt,
    lastError,
    runtimeLimitMs: RUNTIME_MS
  };
}

http.createServer((req, res) => {
  const p = String(req.url || "/").split("?")[0];
  if (p === "/" || p === "/health" || p === "/status") {
    res.writeHead(200, {"content-type":"application/json","cache-control":"no-store"});
    return res.end(JSON.stringify(health()));
  }
  res.writeHead(404);
  res.end();
}).listen(PORT, "0.0.0.0", () => log("HEALTH_LISTENING", {port:PORT}));

log("MONITOR_STARTING", {
  version: VERSION,
  strategy: "SPORTS_POLYMARKET_COMPRESSION_BREAKOUT",
  liveSource: LIVE_URL,
  polymarketSource: GAMMA_URL,
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
  log("RUNTIME_LIMIT_REACHED", {runtimeMs: Date.now() - startedAt});
  process.exit(0);
})();
