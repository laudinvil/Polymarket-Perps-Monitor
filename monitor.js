import { execFile } from "node:child_process";
import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const LIVE_URL = "https://football-live-api.vercel.app/api/matches/live";
const POLYMARKET_URL = "https://gamma-api.polymarket.com/events?active=true&closed=false&limit=500";
const POLL_MS = 30000;
const STARTED_AT = new Date().toISOString();

let polls = 0;
let liveExternal = 0;
let polyEvents = 0;
let matchesFound = 0;
let alertsSent = 0;
let lastError = null;
let lastExternal = null;
let lastMatch = null;
const alerted = new Set();
let stopping = false;

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(fc|afc|cf|sc|ac|club|women|w|u19|u20|u21|u23)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value) {
  return new Set(normalizeName(value).split(" ").filter(x => x.length > 2));
}

function similarity(a, b) {
  const aa = tokens(a);
  const bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let hit = 0;
  for (const x of aa) if (bb.has(x)) hit++;
  return hit / Math.max(aa.size, bb.size);
}

function extractLiveMatches(node, out = []) {
  if (!node || typeof node !== "object") return out;

  if (Array.isArray(node)) {
    for (const item of node) extractLiveMatches(item, out);
    return out;
  }

  const home = node.home?.name || node.homeTeam?.name || node.homeTeamName || node.home;
  const away = node.away?.name || node.awayTeam?.name || node.awayTeamName || node.away;
  const status = node.status;
  const statusObj = status && typeof status === "object" ? status : {};
  const started = statusObj.started === true || node.started === true;
  const finished = statusObj.finished === true || node.finished === true;
  const live = node.live === true || node.isLive === true ||
    (typeof status === "string" && /live|in.?progress|halftime|break/i.test(status));

  if (home && away && !finished && (live || started)) {
    const scoreHome = node.home?.score ?? node.homeScore ?? node.score?.home ?? node.scoreHome;
    const scoreAway = node.away?.score ?? node.awayScore ?? node.score?.away ?? node.scoreAway;
    const score = scoreHome != null && scoreAway != null ? `${scoreHome}–${scoreAway}` :
      typeof node.score === "string" ? node.score.replace(/-/g, "–") : "—";

    const rawMinute = node.minute ?? node.elapsed ?? node.time ?? node.status?.minute ?? node.status?.elapsed ?? "—";
    const minute = typeof rawMinute === "object"
      ? String(rawMinute.display ?? rawMinute.value ?? rawMinute.minute ?? "—")
      : String(rawMinute);
    const id = String(node.id ?? node.matchId ?? node.eventId ?? `${home}|${away}`);
    out.push({
      id,
      home: String(home),
      away: String(away),
      score,
      minute,
      league: String(node.league?.name || node.leagueName || node.tournament?.name || ""),
      raw: node
    });
    return out;
  }

  for (const value of Object.values(node)) extractLiveMatches(value, out);
  return out;
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`${url} HTTP ${response.status}`);
  return response.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function telegram(text) {
  if (!TOKEN || !CHAT_ID) throw new Error("Telegram env vars missing");
  const body = JSON.stringify({
    chat_id: CHAT_ID,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: false
  });

  await new Promise((resolve, reject) => {
    execFile("curl", [
      "--silent", "--show-error", "--max-time", "10", "--connect-timeout", "5",
      "-X", "POST", `https://api.telegram.org/bot${TOKEN}/sendMessage`,
      "-H", "content-type: application/json", "--data-binary", body
    ], { timeout: 12000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`Telegram curl: ${error.message}; ${stderr.slice(0,300)}`));
      let data;
      try { data = JSON.parse(stdout); } catch { return reject(new Error(`Telegram non-JSON: ${stdout.slice(0,300)}`)); }
      console.log("TELEGRAM RESPONSE", stdout.slice(0,500));
      if (!data.ok) return reject(new Error(`Telegram rejected: ${stdout.slice(0,500)}`));
      resolve();
    });
  });
}

function eventTeams(event) {
  let home = event.homeTeamName || event.homeTeam || "";
  let away = event.awayTeamName || event.awayTeam || "";
  if ((!home || !away) && event.title) {
    const m = String(event.title).match(/^(.+?)\s+(?:vs\.?|v)\s+(.+?)(?:\s+-\s+.*)?$/i);
    if (m) { home ||= m[1].trim(); away ||= m[2].trim(); }
  }
  return { home, away };
}

function eventLink(event) {
  const slug = event.slug || event.eventSlug;
  if (slug) return `https://polymarket.com/event/${slug}`;

  const market = Array.isArray(event.markets)
    ? event.markets.find(x => x && x.slug)
    : null;
  if (market?.slug) return `https://polymarket.com/market/${market.slug}`;

  return "https://polymarket.com/sports/soccer";
}

function isSoccerEvent(event) {
  const text = JSON.stringify({
    title: event.title,
    slug: event.slug,
    sport: event.sport,
    tags: event.tags,
    series: event.series
  }).toLowerCase();
  return /soccer|football|epl|premier league|la liga|bundesliga|serie a|ligue 1|mls|champions league/.test(text) &&
    !/cs2|valorant|mlbb|dota|esports|tennis/.test(text);
}

function matchPolymarket(live, events) {
  let best = null;
  let bestScore = 0;
  for (const event of events) {
    if (!isSoccerEvent(event)) continue;
    const { home, away } = eventTeams(event);
    if (!home || !away) continue;

    const direct = similarity(live.home, home) + similarity(live.away, away);
    const reverse = similarity(live.home, away) + similarity(live.away, home);
    const score = Math.max(direct, reverse);

    if (score > bestScore) {
      bestScore = score;
      best = event;
    }
  }

  // Exact/near-exact team-name matches only. This prevents an unrelated
  // Polymarket event from receiving a live alert.
  return bestScore >= 1.25 ? { event: best, score: bestScore } : null;
}

async function poll() {
  if (stopping) return;
  polls++;

  try {
    const [liveData, polyData] = await Promise.all([
      getJson(LIVE_URL),
      getJson(POLYMARKET_URL)
    ]);

    const liveMatches = extractLiveMatches(liveData);
    const events = Array.isArray(polyData)
      ? polyData
      : (Array.isArray(polyData.events) ? polyData.events : []);

    liveExternal = liveMatches.length;
    polyEvents = events.length;
    lastExternal = liveMatches.slice(0, 10);

    console.log("LIVE SOURCE", JSON.stringify({
      polls,
      live: liveMatches.length,
      polymarketEvents: events.length
    }));

    for (const live of liveMatches) {
      const found = matchPolymarket(live, events);
      if (!found) {
        console.log("NO POLYMARKET MATCH", live.home, "vs", live.away, "score=" + live.score);
        continue;
      }

      matchesFound++;
      const event = found.event;
      const key = String(event.id || event.slug || `${live.home}|${live.away}`);
      const link = eventLink(event);
      lastMatch = {
        live,
        polymarketId: key,
        title: event.title,
        matchScore: found.score,
        link
      };
      console.log("POLYMARKET MATCH", JSON.stringify(lastMatch));

      if (alerted.has(key)) continue;

      const message =
        `⚽ <b>LIVE FOUND</b>\n\n` +
        `<b>${escapeHtml(live.home)} vs ${escapeHtml(live.away)}</b>\n` +
        `LIVE\n` +
        `MINUTE: ${escapeHtml(live.minute)}\n` +
        `SCORE: ${escapeHtml(live.score)}\n\n` +
        `<a href="${escapeHtml(link)}">ОТКРЫТЬ POLYMARKET</a>`;

      try {
        await telegram(message);
        alerted.add(key);
        alertsSent++;
        console.log("ALERT SENT", key, live.home, "vs", live.away, "link=" + link);
      } catch (e) {
        lastError = String(e.message || e);
        console.log("TELEGRAM ERROR", lastError);
      }
    }

    lastError = null;
  } catch (e) {
    lastError = String(e.message || e);
    console.log("POLL ERROR", lastError);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    service: "polymarket-live-soccer-monitor",
    liveSource: LIVE_URL,
    polymarketSource: POLYMARKET_URL,
    startedAt: STARTED_AT,
    uptimeSeconds: Math.floor(process.uptime()),
    polls,
    liveExternal,
    polyEvents,
    matchesFound,
    alertsSent,
    lastError,
    lastExternal,
    lastMatch
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("HEALTH LISTENING", PORT);
  console.log("MONITOR STARTING");
  console.log("LIVE SOURCE", LIVE_URL);
  console.log("POLYMARKET SOURCE", POLYMARKET_URL);
  console.log("POLL INTERVAL", POLL_MS);
});

poll();
const timer = setInterval(poll, POLL_MS);

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));