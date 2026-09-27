import WebSocket from "ws";

const WS_URL = "wss://sports-api.polymarket.com/ws";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TOKEN || !CHAT_ID) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
}

const soccerLeagueHints = new Set([
  "epl","laliga","laliga2","seriea","bundesliga","ligue1","wsl","ligaf",
  "serieaf","bundesligaf","d1f","ucl","uwcl","mls","nwsl","worldcup",
  "unl","concacaf","copa","brasileirao","arg","aus","bel","bra","col",
  "ned","eng","esp","ita","fra","ger","por","sco","mex","usa"
]);

const seen = new Set();
let sent = 0;
let ws;

function isSoccer(x) {
  const league = String(x.leagueAbbreviation ?? x.league ?? x.sport ?? "").toLowerCase();
  if (soccerLeagueHints.has(league)) return true;
  const text = JSON.stringify(x).toLowerCase();
  return text.includes("soccer") || text.includes("football");
}

function isLive(x) {
  return x.live === true &&
    x.ended !== true &&
    !["finished", "final", "ended"].includes(String(x.status ?? "").toLowerCase());
}

function team(x, side) {
  return x[side + "Team"] ?? x[side + "_team"] ?? x[side] ?? "Unknown";
}

function matchUrl(x) {
  const slug = x.slug;
  return slug
    ? `https://polymarket.com/sports/soccer/games/${encodeURIComponent(slug)}`
    : "https://polymarket.com/ru/sports/soccer/games";
}

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"content-type": "application/json"},
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text,
      disable_web_page_preview: false
    })
  });
  const body = await r.text();
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${body}`);
}

function handle(raw) {
  if (raw === "ping") {
    ws?.send("pong");
    return;
  }
  if (raw === "pong") return;

  let x;
  try { x = JSON.parse(raw); } catch { return; }

  if (x.type && x.type !== "sport_result" && x.event_type && x.event_type !== "sport_result") return;

  if (!isSoccer(x) || !isLive(x)) return;

  const id = String(x.gameId ?? x.id ?? x.slug ?? "");
  if (!id || seen.has(id)) return;
  seen.add(id);

  const home = team(x, "home");
  const away = team(x, "away");
  const score = x.score ?? "—";
  const period = x.period ?? "";
  const elapsed = x.elapsed ?? "";

  const lines = [
    "⚽ LIVE FOUND",
    "",
    `${home} vs ${away}`,
    "STATUS: LIVE",
    period ? `PERIOD: ${period}` : null,
    elapsed ? `MINUTE: ${elapsed}` : null,
    `SCORE: ${score}`,
    "",
    matchUrl(x)
  ].filter(Boolean);

  console.log(lines.join("\n"));
  sendTelegram(lines.join("\n"))
    .then(() => {
      sent++;
      console.log(`TELEGRAM SENT: ${home} vs ${away}`);
    })
    .catch(err => console.error("TELEGRAM ERROR:", err.message));
}

const timeout = setTimeout(() => {
  console.log(`TEST FINISHED. LIVE SOCCER FOUND: ${sent}`);
  ws?.close();
  process.exit(sent > 0 ? 0 : 2);
}, 30000);

function connect() {
  ws = new WebSocket(WS_URL);

  ws.on("open", () => console.log("Connected to Polymarket Sports WebSocket"));
  ws.on("message", data => handle(data.toString()));
  ws.on("error", err => console.error("WS ERROR:", err.message));
  ws.on("close", () => {
    if (Date.now() < Date.now() + 1000 && !sent) {
      console.log("WebSocket closed");
    }
  });
}

connect();
