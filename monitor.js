import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const WS_URL = "wss://sports-api.polymarket.com/ws";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RECONNECT_MS = 3000;
const GAMMA_URL = "https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=soccer&limit=500";
const GAMMA_POLL_MS = 10000;
const STARTED_AT = new Date().toISOString();

let lastMessageAt = null;
let lastError = null;
let liveCount = 0;
let alertsSent = 0;
let wsState = "disconnected";
let eventsReceived = 0;
let soccerCandidates = 0;
let soccerAccepted = 0;
let soccerRejected = 0;
let lastEvent = null;
let lastSoccerCandidate = null;
let lastGammaEvent = null;
let lastGammaError = null;
let gammaPolls = 0;
let gammaLiveCount = 0;
let gammaPolling = false;
let gammaTimer = null;
let wsRef = null;
let shuttingDown = false;
const games = new Map();
const alerted = new Set();

process.on("SIGTERM", () => {
  console.log("PROCESS SIGTERM RECEIVED", new Date().toISOString());
  shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  console.log("PROCESS SIGINT RECEIVED", new Date().toISOString());
  shutdown("SIGINT");
});

process.on("uncaughtException", (err) => {
  console.error("UNCAUGHT EXCEPTION", err?.stack || err);
});

process.on("unhandledRejection", (err) => {
  console.error("UNHANDLED REJECTION", err?.stack || err);
});

async function telegram(text) {
  if (!TOKEN || !CHAT_ID) throw new Error("Telegram env vars missing");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });
  if (!r.ok) throw new Error("Telegram HTTP " + r.status);
}

function isSoccer(m) {
  const league = String(m.leagueAbbreviation || m.league || "").toLowerCase().trim();
  const sport = String(m.sport || m.sportSlug || "").toLowerCase().trim();
  const slug = String(m.slug || "").toLowerCase();

  const text = [league, sport, slug].join(" ");

  // Reject non-soccer sports explicitly.
  if (/(cs2|counter[- ]?strike|valorant|r6siege|rainbow ?six|mlbb|dota|league of legends|lol esports|starcraft|esports|tennis|nba|nfl|nhl|mlb|cfb|ncaa)/i.test(text)) {
    return false;
  }

  // Direct identification when Polymarket supplies the sport/league.
  if (/(soccer|football)/i.test(text)) return true;

  const status = String(m.status || "").toLowerCase().trim();
  const period = String(m.period || "").toUpperCase().trim();
  const score = String(m.score || "").trim().split("|")[0].trim();

  // Team-name fields are present on esports too, so they cannot identify soccer.

  // Do not classify by score alone: esports feeds also use scores such as
  // "8-8|0-0|Bo3", and that caused false soccer detections.
  // Do not classify by a generic "running/live" status either.

  // Fallback for feeds that omit the sport label but expose a soccer period.
  // Accept both compact values ("1H", "2H") and values carrying a clock
  // ("1H 37:42", "2H 12:03").
  if (/^(1H|2H|HT|ET|PEN)(?:\s|$)/i.test(period)) return true;
  if (/^(1ST|2ND)\s*HALF(?:\s|$)/i.test(period)) return true;

  return false;
}

function eventSnapshot(m) {
  return {
    gameId: String(m.gameId || m.slug || m.id || ""),
    league: m.leagueAbbreviation || m.league || "",
    sport: m.sport || m.sportSlug || "",
    home: m.homeTeam || m.homeTeamName || "",
    away: m.awayTeam || m.awayTeamName || "",
    status: m.status || "",
    live: m.live,
    ended: m.ended,
    period: m.period || "",
    elapsed: m.elapsed || "",
    minute: minute(m),
    score: score(m),
    slug: m.slug || ""
  };
}

function minute(m) {
  const candidates = [
    m.elapsed,
    m.minute,
    m.matchMinute,
    m.gameMinute,
    m.clock
  ];

  for (const value of candidates) {
    const s = String(value ?? "").trim();
    if (!s) continue;

    // "65", "65'", "65 min", and "65:30" -> 65.
    const direct = s.match(/^(\d{1,3})(?:['’]|\s*(?:min|mins|minute|minutes))?$/i);
    if (direct) return direct[1];

    const clock = s.match(/^(\d{1,3})\s*:\s*\d{1,2}$/);
    if (clock) return clock[1];

    const range = s.match(/^(\d{1,3})\s*[-:]\s*(\d{1,2})$/);
    if (range) return range[1];

    // Polymarket may provide a period clock such as "1H 37:42".
    const periodClock = s.match(/(?:1H|2H|ET)\s*(\d{1,3})\s*:\s*\d{1,2}/i);
    if (periodClock) return periodClock[1];

    // Also accept "1ST HALF 37:42" / "2ND HALF 12:03".
    const namedPeriodClock = s.match(/(?:1ST|2ND)\s*HALF\s*(\d{1,3})\s*:\s*\d{1,2}/i);
    if (namedPeriodClock) return namedPeriodClock[1];

    // Some feeds expose only a minute number inside a longer status string.
    const embedded = s.match(/(?:minute|elapsed|clock)\D{0,8}(\d{1,3})/i);
    if (embedded) return embedded[1];
  }

  return "—";
}

function score(m) {
  const s = String(m.score ?? "").trim();
  if (!s) return "—";

  // Polymarket sports feeds can append set/period scores:
  // "2-1|0-0|..." — use only the match score.
  const main = s.split("|")[0].trim();

  // Only accept a real home-away score. Do not turn unrelated values
  // such as "18:45" into "18–45".
  const match = main.match(/^(\d{1,3})\s*[-–—]\s*(\d{1,3})$/);
  if (!match) return "—";

  return `${match[1]}–${match[2]}`;
}

function title(m) {
  const home = String(m.homeTeam || m.homeTeamName || "").trim();
  const away = String(m.awayTeam || m.awayTeamName || "").trim();
  if (home && away) return `${home} vs ${away}`;
  return String(m.slug || `game ${m.gameId}`);
}

async function handleGame(m) {
  const id = String(m?.gameId || m?.slug || m?.id || "").trim();
  if (!m || !id) return;

  eventsReceived++;
  lastEvent = eventSnapshot(m);

  const soccer = isSoccer(m);
  if (soccer) {
    soccerCandidates++;
    lastSoccerCandidate = eventSnapshot(m);
  } else {
    soccerRejected++;
  }

  if (eventsReceived % 50 === 0) {
    console.log("DIAGNOSTIC", JSON.stringify({
      eventsReceived,
      soccerCandidates,
      soccerAccepted,
      soccerRejected,
      lastEvent,
      lastSoccerCandidate
    }));
  }

  const status = String(m.status || "").toLowerCase().trim();
  const liveFlag = String(m.live).toLowerCase() === "true";
  const endedFlag = String(m.ended).toLowerCase() === "true";
  const liveStatus = ["inprogress", "running", "live", "break", "halftime", "penaltyshootout"].includes(status);

  // WS payloads may encode booleans as strings. Never let "false"
  // become truthy and block an otherwise valid LIVE event.
  const soccerLive =
    soccer &&
    !endedFlag &&
    (liveFlag || liveStatus);

  if (soccerLive) {
    soccerAccepted++;
    games.set(id, m);
  } else if (
    endedFlag ||
    ["final", "awarded", "canceled", "postponed"].includes(status)
  ) {
    games.delete(id);
  }

  liveCount = games.size;

  if (!soccerLive) return;

  if (alerted.has(id)) return;

  alerted.add(id);

  const message =
    `⚽ LIVE FOUND\n\n` +
    `${title(m)}\n` +
    `LIVE\n` +
    `MINUTE: ${minute(m)}\n` +
    `SCORE: ${score(m)}`;

  try {
    await telegram(message);
    alertsSent++;
    lastMessageAt = new Date().toISOString();
    console.log("ALERT SENT", id, title(m), "MINUTE", minute(m), "SCORE", score(m));
  } catch (e) {
    alerted.delete(id);
    lastError = String(e.message || e);
    console.log("TELEGRAM ERROR", lastError);
  }
}

async function pollGammaSoccer() {
  if (shuttingDown || gammaPolling) return;
  gammaPolling = true;
  gammaPolls++;

  try {
    const response = await fetch(GAMMA_URL, {
      headers: { "accept": "application/json" },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) {
      throw new Error("Gamma HTTP " + response.status);
    }

    const data = await response.json();
    const events = Array.isArray(data) ? data : Array.isArray(data.events) ? data.events : [];

    const liveEvents = events.filter(e => e && String(e.live).toLowerCase() === "true" && String(e.ended).toLowerCase() !== "true");
    gammaLiveCount = liveEvents.length;
    lastGammaError = null;

    for (const e of liveEvents) {
      const market = Array.isArray(e.markets)
        ? e.markets.find(m => m && m.gameId != null)
        : null;

      const gameId = String(
        market?.gameId ??
        e.gameId ??
        e.id ??
        e.slug ??
        ""
      );

      if (!gameId) continue;

      const rawTitle = String(e.title || "").trim();
      const home = String(
        e.homeTeamName ||
        e.homeTeam ||
        ""
      ).trim();
      const away = String(
        e.awayTeamName ||
        e.awayTeam ||
        ""
      ).trim();

      const match = rawTitle.match(/^(.+?)\s+vs\.?\s+(.+?)(?:\s+-\s+.*)?$/i);

      const normalized = {
        gameId,
        leagueAbbreviation: "soccer",
        sport: "soccer",
        sportSlug: "soccer",
        slug: e.slug || "",
        homeTeam: home || (match ? match[1].trim() : rawTitle),
        awayTeam: away || (match ? match[2].trim() : ""),
        status: e.gameStatus || e.status || (e.live === true ? "InProgress" : ""),
        live: String(e.live).toLowerCase() === "true",
        ended: String(e.ended).toLowerCase() === "true",
        score: String(e.score || "").trim(),
        period: String(e.period || "").trim(),
        elapsed: String(e.elapsed || e.clock || e.minute || "").trim(),
        minute: String(e.elapsed || e.clock || e.minute || "").trim()
      };

      lastGammaEvent = eventSnapshot(normalized);
      await handleGame(normalized);
    }
  } catch (e) {
    lastGammaError = String(e.message || e);
    console.log("GAMMA ERROR", lastGammaError);
  } finally {
    gammaPolling = false;
  }
}

function connect() {
  if (shuttingDown) return;

  wsState = "connecting";
  console.log("SPORTS WS CONNECTING", WS_URL);

  const ws = new WebSocket(WS_URL);
  wsRef = ws;

  ws.onopen = () => {
    wsState = "connected";
    lastError = null;
    console.log("SPORTS WS CONNECTED");
  };

  ws.onmessage = async (event) => {
    const raw = String(event.data || "");

    if (raw.toLowerCase() === "ping") {
      try { ws.send("pong"); } catch {}
      return;
    }

    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    if (m && m.type === "sport_result" && m.payload) m = m.payload;

    // Some Sports WS messages are wrapped as {type:"sport_result", data:{...}}
    // while others are already the result object.
    if (m && m.type === "sport_result" && m.data && typeof m.data === "object") {
      m = m.data;
    }

    const sportId = String(m?.gameId || m?.slug || m?.id || "").trim();
    if (!m || !sportId) return;

    console.log(
      "SPORT RESULT",
      sportId,
      m.leagueAbbreviation || "",
      m.homeTeam || m.homeTeamName || "",
      "vs",
      m.awayTeam || m.awayTeamName || "",
      "status=" + (m.status || ""),
      "live=" + String(m.live),
      "score=" + String(m.score || ""),
      "period=" + String(m.period || ""),
      "elapsed=" + String(m.elapsed || "")
    );

    await handleGame(m);
  };

  ws.onerror = () => {
    wsState = "error";
    lastError = "Sports WS error";
    console.log("SPORTS WS ERROR");
  };

  ws.onclose = (event) => {
    wsState = "disconnected";
    console.log(
      "SPORTS WS CLOSED",
      "code=" + String(event?.code ?? ""),
      "reason=" + String(event?.reason ?? ""),
      "shuttingDown=" + String(shuttingDown)
    );

    if (!shuttingDown) setTimeout(connect, RECONNECT_MS);
  };
}

const server = http.createServer((req, res) => {
  res.writeHead(200, {"content-type":"application/json"});
  res.end(JSON.stringify({
    ok: true,
    service: "polymarket-live-soccer-monitor",
    source: WS_URL,
    startedAt: STARTED_AT,
    pid: process.pid,
    uptimeSeconds: Math.floor(process.uptime()),
    wsState,
    liveCount,
    alertsSent,
    eventsReceived,
    soccerCandidates,
    soccerAccepted,
    soccerRejected,
    lastMessageAt,
    lastError,
    lastEvent,
    lastSoccerCandidate,
    gammaPolls,
    gammaLiveCount,
    lastGammaEvent,
    lastGammaError
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("HEALTH LISTENING", PORT);
  console.log("PROCESS PID", process.pid);
  console.log("PROCESS STARTED", STARTED_AT);
});

const heartbeat = setInterval(() => {
  console.log(
    "HEARTBEAT",
    new Date().toISOString(),
    "pid=" + process.pid,
    "uptime=" + Math.floor(process.uptime()) + "s",
    "ws=" + wsState,
    "live=" + liveCount,
    "alerts=" + alertsSent,
    "events=" + eventsReceived,
    "soccerCandidates=" + soccerCandidates,
    "soccerAccepted=" + soccerAccepted,
    "soccerRejected=" + soccerRejected
  );
}, 10000);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
  clearInterval(gammaTimer);
  wsState = "shutting_down";

  try { wsRef?.close(); } catch {}
  server.close(() => {
    console.log("PROCESS SHUTDOWN COMPLETE", signal);
    process.exit(0);
  });

  setTimeout(() => {
    console.log("PROCESS SHUTDOWN TIMEOUT", signal);
    process.exit(0);
  }, 5000).unref();
}

console.log("MONITOR STARTING");
console.log("SOURCE", WS_URL);
console.log("GAMMA SOURCE", GAMMA_URL);
connect();
pollGammaSoccer();
gammaTimer = setInterval(pollGammaSoccer, GAMMA_POLL_MS);
