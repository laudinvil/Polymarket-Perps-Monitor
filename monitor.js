import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const WS_URL = "wss://sports-api.polymarket.com/ws";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RECONNECT_MS = 3000;
const STARTED_AT = new Date().toISOString();

let lastMessageAt = null;
let lastError = null;
let liveCount = 0;
let alertsSent = 0;
let wsState = "disconnected";
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
  const league = String(m.leagueAbbreviation || m.league || "").toLowerCase();
  if (league === "soccer" || league.includes("soccer") || league.includes("football")) return true;

  const period = String(m.period || "").toUpperCase();
  const slug = String(m.slug || "").toLowerCase();

  return ["1H", "2H", "HT"].includes(period) &&
    !/(nba|nfl|nhl|mlb|ncaa|cfb|cs2|tennis|mma|ufc)/i.test(slug);
}

function minute(m) {
  const elapsed = String(m.elapsed ?? "").trim();
  const match = elapsed.match(/^(\d+)/);
  if (match) return match[1];
  return "—";
}

function score(m) {
  const s = String(m.score ?? "").trim();
  if (!s) return "—";
  const parts = s.split("-");
  return parts.length === 2 ? `${parts[0]}–${parts[1]}` : s;
}

function title(m) {
  const home = String(m.homeTeam || "").trim();
  const away = String(m.awayTeam || "").trim();
  if (home && away) return `${home} vs ${away}`;
  return String(m.slug || `game ${m.gameId}`);
}

async function handleGame(m) {
  if (!m || !m.gameId) return;

  if (m.live === true && !m.ended && isSoccer(m)) {
    games.set(String(m.gameId), m);
  } else if (m.ended || String(m.status || "").toLowerCase() === "final") {
    games.delete(String(m.gameId));
  }

  liveCount = games.size;

  if (!(m.live === true && !m.ended && isSoccer(m))) return;

  const id = String(m.gameId);
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

    if (!m || !m.gameId) return;

    console.log(
      "SPORT RESULT",
      m.gameId,
      m.leagueAbbreviation || "",
      m.homeTeam || "",
      "vs",
      m.awayTeam || "",
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
    lastMessageAt,
    lastError
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
    "alerts=" + alertsSent
  );
}, 10000);

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeat);
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
connect();
