const GAMMA_URL = "https://gamma-api.polymarket.com";
const SPORTScore_URL = "https://sportscore.com/api/widget";

const POLL_MS = 15_000;
const MIN_EDGE = 0.01;
const RUN_MS = 6 * 60 * 60 * 1000;
const HISTORY_MS = 20 * 60 * 1000;
const ALERT_BUCKET_MS = 60 * 1000;
const PREMATCH_WINDOW_MS = Number.POSITIVE_INFINITY;
const EARLY_WINDOW_MS = 120 * 60 * 1000;
const NUTMEG_CACHE_MS = 5 * 60 * 1000;
const BALANCE_MAX_DIFF = 0.15;
const MIN_DRAW_PROB = 0.22;
const MIN_BTTS_PROB = 0.45;

let stopping = false;
let timer = null;
const known = new Map();
const resolved = new Map();
const history = new Map();
const oneOneState = new Map();
let nutmegCache = { at: 0, rows: [] };
const convexLogBuffer = [];
let convexTickCount = 0;
let tickRunning = false;

function log(level, event, message, data = undefined) {
  const entry = {
    level, event, message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) }),
    createdAt: Date.now(),
  };
  convexLogBuffer.push(entry);
  console.log(JSON.stringify({
    level,
    event,
    message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) })
  }));
}

async function flushConvexLogs() {
  if (!convexLogBuffer.length && !convexTickCount) return;
  const batch = convexLogBuffer.splice(0, 100);
  const ticks = convexTickCount;
  convexTickCount = 0;
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  try {
    const response = await fetch(base.replace(/\/$/, "") + "/football/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: batch, tickCount: ticks }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Convex HTTP " + response.status);
  } catch (err) {
    convexLogBuffer.unshift(...batch);
    convexTickCount += ticks;
    console.log(JSON.stringify({ level: "WARN", event: "convex_log_failed", message: err.message }));
  }
}

async function checkpoint(event, data = {}) {
  log("INFO", event, "football monitor checkpoint", data);
  await flushConvexLogs();
}

function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

function norm(v) {
  return text(v).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}

function parseJson(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
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

  const m = title.match(/^(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+)$/i);
  return m ? [m[1].trim(), m[2].trim()] : ["", ""];
}

function isFootballEvent(event, footballIds) {
  const hay = [event.sport,event.sportSlug,event.sport_slug,event.category,event.tag,event.tags,event.title,event.question,event.series_id,event.seriesId].flat(Infinity).map(text).join(" ").toLowerCase();
  if (footballIds.size) {
    const ids = [event.series_id, event.seriesId, event.sports_series_id].map(text).filter(Boolean);
    if (ids.some(id => footballIds.has(id))) return true;
  }
  return /football|soccer|epl|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league/.test(hay);
}

async function getJson(url, options = {}) {
  const r = await fetch(url, {...options, headers:{accept:"application/json",...(options.headers||{})},signal:AbortSignal.timeout(10_000)});
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
      for (const key of ["series","series_id","seriesId"]) { const id=text(row[key]); if(id) ids.add(id); }
    }
    return ids;
  } catch (err) {
    log("WARN","sports_metadata_failed","Could not load sports metadata; using event text fallback",{message:err.message});
    return new Set();
  }
}

async function activeEventsBySeries(seriesId) {
  const data = await getJson(GAMMA_URL + "/events?series_id=" + encodeURIComponent(seriesId) + "&active=true&closed=false&limit=500");
  return Array.isArray(data) ? data : (data.events || data.data || []);
}

async function discoverPolymarket() {
  const now = Date.now();
  let events = [];
  let sourceIsSoccerTag = false;
  let sourceSeriesCount = 0;
  await checkpoint("soccer_feed_start");

  try {
    for (let offset = 0; offset < 2000; offset += 500) {
      await checkpoint("soccer_page_start", {offset});
      const data = await getJson(GAMMA_URL + "/events?active=true&closed=false&tag_slug=soccer&limit=500&offset=" + offset + "&order=startDate&ascending=true");
      const rows = Array.isArray(data) ? data : (data.events || data.data || []);
      if (rows.length) sourceIsSoccerTag = true;
      events.push(...rows);
      await checkpoint("soccer_page_done", {offset, rows:rows.length, total:events.length});
      if (rows.length < 500) break;
    }
  } catch (err) {
    log("WARN","soccer_tag_query_failed","Direct soccer event query failed; using football-series discovery",{message:err.message});
    await flushConvexLogs();
  }
  await checkpoint("soccer_feed_done", {rawEvents:events.length, sourceIsSoccerTag});

  const footballIds = sourceIsSoccerTag ? new Set() : await footballSeriesIds();
  await checkpoint("series_discovery_done", {footballSeries:footballIds.size});
  if (footballIds.size) {
    const seriesResults = await Promise.all([...footballIds].slice(0,100).map(async seriesId => {
      try { return await activeEventsBySeries(seriesId); }
      catch(err) { log("WARN","series_events_failed","Could not load football series events",{seriesId,message:err.message}); return []; }
    }));
    for (const rows of seriesResults) { events.push(...rows); if(rows.length) sourceSeriesCount += 1; }
  }
  await checkpoint("events_loaded", {rawEvents:events.length,sourceSeriesCount});

  const candidates=[]; const seen=new Set();
  for (const event of events) {
    if (!event || (!sourceIsSoccerTag && !isFootballEvent(event, footballIds))) continue;
    const start=Date.parse(event.startDate||event.start_date||event.startTime||"");
    if (Number.isFinite(start)&&start<=now&&now>start+EARLY_WINDOW_MS) continue;
    const id=text(event.id||event.eventId||event.event_id), slug=text(event.slug), key=id||slug;
    if(!key||seen.has(key)) continue;
    seen.add(key);
    const [home,away]=extractTeams(event);
    const markets=Array.isArray(event.markets)?[...event.markets]:[];
    const item={eventId:id,slug,url:eventUrl(event),title:text(event.title||event.question),homeTeam:home,awayTeam:away,startTime:event.startDate||event.start_date||event.startTime||null,endTime:event.endDate||event.end_date||event.endTime||null,markets:markets.map(m=>({marketId:text(m.id||m.marketId),conditionId:text(m.conditionId||m.condition_id),question:text(m.question||m.title),slug:text(m.slug),active:m.active!==false,closed:m.closed===true,clobTokenIds:parseJson(m.clobTokenIds||m.clob_token_ids),outcomes:parseJson(m.outcomes),outcomePrices:parseJson(m.outcomePrices||m.outcome_prices)}))};
    const oneOne=findOneOneMarket(item);
    log("INFO",oneOne?"one_one_market_found":"one_one_market_missing","Candidate exact-score market inspection",{eventId:id,teams:[home,away],marketCount:markets.length,oneOnePrice:oneOne?.price??null,startTime:item.startTime});
    candidates.push(item);
    if(!known.has(key)){known.set(key,now);log("INFO","candidate_match_found","Polymarket football candidate for 1:1 strategy",item);}
  }
  await checkpoint("discovery_filter_counts",{rawEvents:events.length,sourceIsSoccerTag,footballSeries:footballIds.size,sourceSeriesCount,candidates:candidates.length});
  return candidates;
}

// Existing strategy helpers and monitoring functions below remain unchanged.
