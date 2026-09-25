const GAMMA_URL = "https://gamma-api.polymarket.com";
const POLL_MS = 15_000;
const RUN_MS = 6 * 60 * 60 * 1000;

let stopping = false;
let timer = null;
const known = new Map();

function log(level, event, message, data = undefined) {
  console.log(JSON.stringify({
    level,
    event,
    message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) })
  }));
}

function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

function parseJson(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

function toTime(v) {
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : null;
}

function eventUrl(event) {
  const slug = text(event.slug);
  return slug ? "https://polymarket.com/event/" + slug : "";
}

function extractTeams(event) {
  const title = text(event.title || event.question);
  const candidates = [
    event.homeTeam && event.awayTeam ? [event.homeTeam, event.awayTeam] : null,
    event.home_team && event.away_team ? [event.home_team, event.away_team] : null
  ].filter(Boolean);

  if (candidates.length) return candidates[0].map(text);

  const m = title.match(/^(.+?)\\s+(?:vs\\.?|v\\.?|versus)\\s+(.+)$/i);
  return m ? [m[1].trim(), m[2].trim()] : ["", ""];
}

function isFootballEvent(event, footballIds) {
  const hay = [
    event.sport,
    event.sportSlug,
    event.sport_slug,
    event.category,
    event.tag,
    event.tags,
    event.title,
    event.question,
    event.series_id,
    event.seriesId
  ].flat(Infinity).map(text).join(" ").toLowerCase();

  if (footballIds.size) {
    const ids = [
      event.series_id,
      event.seriesId,
      event.sports_series_id
    ].map(text).filter(Boolean);
    if (ids.some(id => footballIds.has(id))) return true;
  }

  return /football|soccer|epl|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league/.test(hay);
}

async function getJson(url) {
  const r = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
  return r.json();
}

async function footballSeriesIds() {
  try {
    const data = await getJson(GAMMA_URL + "/sports");
    const rows = Array.isArray(data) ? data : (data.sports || data.data || []);
    const ids = new Set();

    for (const row of rows) {
      const hay = JSON.stringify(row).toLowerCase();
      if (!/football|soccer/.test(hay)) continue;
      for (const key of ["series_id", "seriesId", "id"]) {
        const id = text(row[key]);
        if (id) ids.add(id);
      }
    }

    return ids;
  } catch (err) {
    log("WARN", "sports_metadata_failed", "Could not load sports metadata; using event text fallback", { message: err.message });
    return new Set();
  }
}

async function activeEventsBySeries(seriesId) {
  const url = GAMMA_URL +
    "/events?series_id=" + encodeURIComponent(seriesId) +
    "&active=true&closed=false&limit=500";
  const data = await getJson(url);
  return Array.isArray(data) ? data : (data.events || data.data || []);
}

async function discover() {
  const now = Date.now();
  const seriesIds = await footballSeriesIds();
  let events = [];

  if (seriesIds.size) {
    const chunks = await Promise.all([...seriesIds].map(id =>
      activeEventsBySeries(id).catch(err => {
        log("WARN", "series_failed", "Football series query failed", { seriesId: id, message: err.message });
        return [];
      })
    ));
    events = chunks.flat();
  } else {
    const data = await getJson(
      GAMMA_URL + "/events?active=true&closed=false&limit=500"
    );
    events = Array.isArray(data) ? data : (data.events || data.data || []);
  }

  const live = [];
  const seen = new Set();

  for (const event of events) {
    if (!event || !isFootballEvent(event, seriesIds)) continue;

    const start = toTime(event.startDate || event.start_date || event.startTime);
    const end = toTime(event.endDate || event.end_date || event.endTime);
    const isLiveWindow = start !== null && start <= now && (end === null || end > now);
    if (!isLiveWindow) continue;

    const id = text(event.id || event.eventId || event.event_id);
    const slug = text(event.slug);
    const key = id || slug;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const [home, away] = extractTeams(event);
    const markets = Array.isArray(event.markets) ? event.markets : [];

    const item = {
      eventId: id,
      slug,
      url: eventUrl(event),
      title: text(event.title || event.question),
      homeTeam: home,
      awayTeam: away,
      startTime: event.startDate || event.start_date || event.startTime || null,
      endTime: event.endDate || event.end_date || event.endTime || null,
      markets: markets.map(m => ({
        marketId: text(m.id || m.marketId),
        conditionId: text(m.conditionId || m.condition_id),
        question: text(m.question || m.title),
        slug: text(m.slug),
        active: m.active !== false,
        closed: m.closed === true,
        clobTokenIds: parseJson(m.clobTokenIds || m.clob_token_ids),
        outcomes: parseJson(m.outcomes),
        outcomePrices: parseJson(m.outcomePrices || m.outcome_prices)
      }))
    };

    live.push(item);

    if (!known.has(key)) {
      known.set(key, now);
      log("INFO", "live_match_found", "New live Polymarket football match", item);
    }
  }

  log("INFO", "live_snapshot", "Polymarket live football snapshot", {
    count: live.length,
    matches: live
  });
}

async function tick() {
  if (stopping) return;
  try {
    await discover();
  } catch (err) {
    log("ERROR", "discovery_failed", "Polymarket football discovery failed; monitoring continues", {
      message: err.message
    });
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  log("INFO", "monitor_stopped", "Polymarket live football discovery stopped");
}

async function start() {
  log("INFO", "monitor_started", "Polymarket live football discovery started", {
    pollSec: POLL_MS / 1000,
    runHours: RUN_MS / 3_600_000
  });

  await tick();
  timer = setInterval(() => { tick(); }, POLL_MS);
  setTimeout(stop, RUN_MS);
}

process.on("SIGTERM", () => { stop(); process.exit(0); });
start();
