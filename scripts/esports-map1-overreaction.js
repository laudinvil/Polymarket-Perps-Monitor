async function ensurePrematchBaseline(match, poly, entry) {
  if (entry.pre) return entry.pre;
  const prices = await marketPrices(poly);
  if (!prices) return null;
  const [teamA, teamB] = teams(match);
  const sides = identifySides(prices, teamA, teamB);
  const pre = {
    teamA, teamB,
    a: sides.a.prob,
    b: sides.b.prob,
    capturedAt: new Date().toISOString(),
    marketId: String(poly.market?.id || ""),
    eventSlug: String(poly.event?.slug || "")
  };
  entry.pre = pre;
  return pre;
}

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const PS_TOKEN = process.env.PANDASCORE_API_TOKEN;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO = process.env.GITHUB_REPOSITORY || "laudinvil/Polymarket-Perps-Monitor";

const DEPLEXO_LOG_URL = process.env.DEPLEXO_LOG_URL || "https://polymarket.blitz.cloud/api/logs";
const DEPLEXO_LOG_TOKEN = process.env.DEPLEXO_LOG_TOKEN || "";
const nativeConsoleLog = console.log.bind(console);
const logQueue = [];
let logBusy = false;
const telemetry = {
  startedAt: new Date().toISOString(),
  events: 0,
  polls: 0,
  alerts: 0,
  errors: 0,
  byEvent: {},
  recent: [],
  lastPoll: null,
  lastError: null,
  updatedAt: null
};
let lastRemotePushAt = 0;

async function flushLogQueue() {
  if (logBusy || !logQueue.length) return;
  logBusy = true;
  const item = logQueue.shift();
  try {
    const headers = {"content-type":"application/json"};
    if (DEPLEXO_LOG_TOKEN) headers.authorization = "Bearer " + DEPLEXO_LOG_TOKEN;
    await fetch(DEPLEXO_LOG_URL, {
      method:"POST",
      headers,
      body:JSON.stringify(item),
      signal:AbortSignal.timeout(5000)
    });
  } catch {}
  logBusy = false;
  if (logQueue.length) void flushLogQueue();
}

function log(event, data = {}) {
  nativeConsoleLog(event, JSON.stringify(data));
  telemetry.events++;
  telemetry.byEvent[event] = (telemetry.byEvent[event] || 0) + 1;
  if (event === "POLL_RESULT") telemetry.polls++;
  if (event === "ALERT_SENT") telemetry.alerts++;
  if (event === "POLL_ERROR" || event === "STATE_PUSH_ERROR") {
    telemetry.errors++;
    telemetry.lastError = {ts:new Date().toISOString(), event, data};
  }
  telemetry.recent.push({ts:new Date().toISOString(), event, data});
  if (telemetry.recent.length > 80) telemetry.recent.splice(0, telemetry.recent.length - 80);
  telemetry.updatedAt = new Date().toISOString();
  logQueue.push({
    ts:new Date().toISOString(),
    event,
    data,
    runId:process.env.GITHUB_RUN_ID || null,
    runAttempt:process.env.GITHUB_RUN_ATTEMPT || null,
    sha:process.env.GITHUB_SHA || null
  });
  if (logQueue.length > 500) logQueue.splice(0, logQueue.length - 500);
  void flushLogQueue();
}



if (!PS_TOKEN) throw new Error("Missing PANDASCORE_API_TOKEN");
if (!TG_TOKEN || !TG_CHAT) throw new Error("Missing Telegram secrets");

const PS_BASE = "https://api.pandascore.co";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const CFG = {
  minPreFavorite: 0.40,
  maxPreFavorite: 0.60,
  minMove: 0.20,
  minPostFavorite: 0.70,
  maxPostFavorite: 0.90,
  minMapMargin: 2,
  minMapMarginRatio: 0.25,
  requireMapMargin: true,
  maxUpcomingHours: 24,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// PandaScore Free/Fixtures limit: 1,000 REST requests/hour.
// Keep a hard local budget so polling cannot exhaust the plan.
const PS_HOURLY_LIMIT = 1000;
const PS_SAFETY_LIMIT = Math.floor(PS_HOURLY_LIMIT * 0.9);
const psRequestTimes = [];
let psUpcomingCache = { at: 0, data: [] };
let psRunningCache = { at: 0, data: [] };

function prunePsBudget(now = Date.now()) {
  while (psRequestTimes.length && now - psRequestTimes[0] >= 3600000) psRequestTimes.shift();
}

async function waitForPsBudget() {
  while (true) {
    const now = Date.now();
    prunePsBudget(now);
    if (psRequestTimes.length < PS_SAFETY_LIMIT) {
      psRequestTimes.push(now);
      return;
    }
    const wait = Math.max(1000, 3600000 - (now - psRequestTimes[0]) + 1000);
    log("PANDASCORE_RATE_WAIT", {used: psRequestTimes.length, limit: PS_SAFETY_LIMIT, waitMs: wait});
    await sleep(Math.min(wait, 30000));
  }
}
const norm = s => String(s || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\b(esports?|gaming|team|academy|club|fc|gg|org)\b/g, " ")
  .replace(/\s+/g, " ").trim();

function compact(s) {
  return norm(s).replace(/\s+/g, "");
}

function acronym(s) {
  return norm(s).split(" ").filter(Boolean).map(x => x[0]).join("");
}

function nameScore(a, b) {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb || compact(a) === compact(b)) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.92;

  const aa = acronym(a), ab = acronym(b);
  if (aa && ab && aa === ab && aa.length >= 2) return 0.88;
  if (aa && nb === aa) return 0.88;
  if (ab && na === ab) return 0.88;

  const A = new Set(na.split(" ").filter(x => x.length > 1));
  const B = new Set(nb.split(" ").filter(x => x.length > 1));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(A.size, B.size);
}

const sim = (a,b) => nameScore(a,b);

async function getJson(url, headers = {}) {
  let last;
  for (let i=0;i<4;i++) {
    const started=Date.now();
    log("HTTP_REQUEST", {url,attempt:i+1});
    try {
      const r = await fetch(url, { headers: { accept:"application/json", ...headers }, signal: AbortSignal.timeout(12000) });
      const elapsedMs=Date.now()-started;
      log("HTTP_RESPONSE", {url,status:r.status,ok:r.ok,elapsedMs});
      if (r.ok) {
        const data=await r.json();
        log("HTTP_JSON", {url,kind:Array.isArray(data)?"array":typeof data,count:Array.isArray(data)?data.length:undefined});
        return { data, headers: r.headers };
      }
      last = new Error("HTTP " + r.status + " " + url);
      if (![429,500,502,503,504].includes(r.status)) throw last;
      log("HTTP_RETRY", {url,status:r.status,nextAttempt:i+2});
    } catch (e) {
      last = e;
      log("HTTP_ERROR", {url,attempt:i+1,error:String(e)});
    }
    if (i < 3) await sleep(800 * (i+1));
  }
  throw last;
}

async function ps(path) {
  return (await getJson(PS_BASE + path, { authorization: "Bearer " + PS_TOKEN })).data;
}

async function psPaged(path, maxPages = 5) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await ps(path + sep + "page=" + page + "&per_page=100");
    if (!Array.isArray(batch) || !batch.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return [...new Map(all.filter(x => x?.id != null).map(x => [String(x.id), x])).values()];
}

function opponents(match) {
  return Array.isArray(match.opponents) ? match.opponents : [];
}
function teams(match) {
  return opponents(match).map(x => x?.opponent?.name || x?.opponent?.acronym).filter(Boolean).slice(0,2);
}
function seriesScore(match) {
  const o = opponents(match);
  if (o.length >= 2) {
    const a = Number(o[0]?.score), b = Number(o[1]?.score);
    if (Number.isFinite(a) && Number.isFinite(b)) return [a,b];
  }
  const r = Array.isArray(match.results) ? match.results : [];
  if (r.length >= 2) {
    const a = Number(r[0]?.score ?? r[0]?.result), b = Number(r[1]?.score ?? r[1]?.result);
    if (Number.isFinite(a) && Number.isFinite(b)) return [a,b];
  }
  const candidates = [match.score, match.series_score, match.seriesScore];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length >= 2) {
      const a = Number(c[0]), b = Number(c[1]);
      if (Number.isFinite(a) && Number.isFinite(b)) return [a,b];
    } else if (c && typeof c === "object") {
      const a = Number(c.home ?? c.team1 ?? c.a), b = Number(c.away ?? c.team2 ?? c.b);
      if (Number.isFinite(a) && Number.isFinite(b)) return [a,b];
    }
  }
  return null;
}
function supportedSeries(match) {
  const type = String(match.match_type || "").toLowerCase();
  const games = Number(match.number_of_games);
  // Include BO3 and BO5. PandaScore also exposes "first_to" formats;
  // first_to 3 is equivalent to a BO5 for our Map 1 -> Map 2 logic.
  return (type === "best_of" && (games === 3 || games === 5)) ||
         (type === "first_to" && games === 3) ||
         (type === "red_bull_home_ground" && games === 5);
}
function beginAt(match) {
  const v = match.begin_at || match.scheduled_at;
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : null;
}

function parseJsonMaybe(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

function eventTeams(event) {
  const out = [];
  const add = v => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (v && typeof v === "object") {
      const n = v.name || v.teamName || v.title;
      if (n) out.push(String(n));
    }
  };
  add(event.homeTeam); add(event.awayTeam);
  add(event.homeTeamName); add(event.awayTeamName);
  if (Array.isArray(event.teams)) event.teams.forEach(add);
  return [...new Set(out)];
}

function parseMarket(m) {
  if (!m || typeof m !== "object") return null;
  const outcomes = parseJsonMaybe(m.outcomes);
  const ids = parseJsonMaybe(m.clobTokenIds);
  if (!Array.isArray(outcomes) || !Array.isArray(ids) || outcomes.length !== ids.length) return null;
  return outcomes.map((name,i) => ({ name:String(name), tokenId:String(ids[i]) }));
}

function isMatchWinnerMarket(m, teamA, teamB) {
  const q = String(m.question || m.title || "").toLowerCase();
  const p = parseMarket(m);
  if (!p || p.length !== 2) return false;
  const names = p.map(x => norm(x.name));
  const a = norm(teamA), b = norm(teamB);
  const outcomeMatch = (names.some(x => sim(x,a) >= .5) && names.some(x => sim(x,b) >= .5));
  if (!outcomeMatch) return false;
  // We need the series/match-winner market, not Map 1/2/3 markets.
  if (/\bmap\s*\d+\b/i.test(q)) return false;
  if (/\b(total|over|under|spread|handicap|rounds?|kills?|first\s+map|map\s+winner|game\s*\d+)\b/i.test(q)) return false;
  // Polymarket's current CS2 match-winner questions are not consistent:
  // some use "winner", others expose only the two team outcomes.
  return true;
}

async function loadPolyEvents() {
  const urls = [
    GAMMA + "/events?active=true&closed=false&limit=500&tag_slug=esports",
    GAMMA + "/events?active=true&closed=false&limit=500&order=startDate&ascending=true",
  ];
  let events = [];
  for (const u of urls) {
    try {
      const x = await getJson(u);
      if (Array.isArray(x.data)) events.push(...x.data);
    } catch (e) { log("POLY_DISCOVERY_ERROR", String(e)); }
  }
  return [...new Map(events.filter(e=>e?.id!=null).map(e=>[String(e.id),e])).values()];
}

const polySearchCache = new Map();

async function searchPolyForMatch(teamA, teamB) {
  const cacheKey = norm(teamA) + "|" + norm(teamB);
  if (polySearchCache.has(cacheKey)) return polySearchCache.get(cacheKey);
  const queries = [teamA + " " + teamB, teamA, teamB];
  const found = [];
  for (const q of queries) {
    try {
      const url = GAMMA + "/public-search?q=" + encodeURIComponent(q) +
        "&limit_per_type=20&page=1&keep_closed_markets=0";
      const x = await getJson(url);
      const data = x.data || {};
      for (const e of (Array.isArray(data.events) ? data.events : [])) found.push(e);
      for (const m of (Array.isArray(data.markets) ? data.markets : [])) {
        if (m?.event) found.push(m.event);
      }
    } catch (e) {
      log("POLY_SEARCH_ERROR", {teamA,teamB,error:String(e)});
    }
  }
  const result = [...new Map(found.filter(e=>e?.id!=null).map(e=>[String(e.id),e])).values()];
  polySearchCache.set(cacheKey, result);
  return result;
}

async function hydratePolyEvent(candidate, teamA, teamB) {
  if (!candidate?.event) return null;
  const e = candidate.event;
  let markets = Array.isArray(parseJsonMaybe(e.markets)) ? parseJsonMaybe(e.markets) : [];
  if (!markets.length && e.id != null) {
    try {
      const x = await getJson(GAMMA + "/markets?event_id=" + encodeURIComponent(String(e.id)) + "&active=true&closed=false&limit=100");
      markets = Array.isArray(x) ? x : (Array.isArray(x.data) ? x.data : []);
    } catch (err) {
      log("POLY_MARKET_LOOKUP_ERROR", {eventId:String(e.id), teamA, teamB, error:String(err)});
    }
  }
  for (const m of markets) {
    if (isMatchWinnerMarket(m, teamA, teamB)) {
      return { ...candidate, market:m };
    }
  }
  return null;
}

async function findPolyMatch(events, teamA, teamB) {
  const candidate = findPolyEvent(events, teamA, teamB);
  if (candidate) {
    const hydrated = await hydratePolyEvent(candidate, teamA, teamB);
    if (hydrated) return hydrated;
  }
  const searched = await searchPolyForMatch(teamA, teamB);
  const fallback = findPolyEvent(searched, teamA, teamB);
  if (fallback) {
    const hydrated = await hydratePolyEvent(fallback, teamA, teamB);
    if (hydrated) return hydrated;
  }
  return null;
}

function findPolyEvent(events, teamA, teamB) {
  events = Array.isArray(events) ? events : [];
  let best = null;

  for (const e of events) {
    const et = eventTeams(e);
    const title = String(e.title || e.name || "");
    const markets = Array.isArray(parseJsonMaybe(e.markets)) ? parseJsonMaybe(e.markets) : [];
    const texts = [title, ...et];

    for (const m of markets) {
      texts.push(String(m?.question || m?.title || ""));
      const parsed = parseMarket(m);
      if (parsed) texts.push(parsed.map(x => x.name).join(" vs "));
    }

    let pairScore = 0;
    let bestText = "";
    for (const t of texts) {
      const s1 = nameScore(teamA, t);
      const s2 = nameScore(teamB, t);
      const nt = norm(t);
      const hasA = nt.includes(norm(teamA)) || s1 >= 0.72;
      const hasB = nt.includes(norm(teamB)) || s2 >= 0.72;
      if (hasA && hasB) {
        pairScore = Math.max(pairScore, Math.min(1, (Math.max(s1,0.72) + Math.max(s2,0.72)) / 2));
        bestText = t;
      }
    }

    if (et.length >= 2) {
      const direct = Math.max(
        (nameScore(teamA,et[0]) + nameScore(teamB,et[1])) / 2,
        (nameScore(teamA,et[1]) + nameScore(teamB,et[0])) / 2
      );
      if (direct > pairScore) {
        pairScore = direct;
        bestText = et.join(" vs ");
      }
    }

    if (!best || pairScore > best.score) {
      best = { event:e, score:pairScore, matchedText:bestText };
    }
  }

  if (!best || best.score < 0.68) return null;

  const e = best.event;
  const markets = Array.isArray(parseJsonMaybe(e.markets)) ? parseJsonMaybe(e.markets) : [];
  for (const m of markets) {
    const active = m?.active === true || String(m?.active).toLowerCase() === "true";
    const closed = m?.closed === true || String(m?.closed).toLowerCase() === "true";
    if (!active || closed) continue;
    if (isMatchWinnerMarket(m, teamA, teamB)) {
      return { event:e, market:m, score:best.score, matchedText:best.matchedText };
    }
  }
  return null;
}

async function price(tokenId) {
  try {
    const x = await getJson(CLOB + "/midpoint?token_id=" + encodeURIComponent(tokenId));
    const p = Number(x.data?.mid);
    if (Number.isFinite(p)) return p;
  } catch {}
  const x = await getJson(CLOB + "/price?token_id=" + encodeURIComponent(tokenId) + "&side=BUY");
  const p = Number(x.data?.price);
  return Number.isFinite(p) ? p : null;
}

async function marketPrices(poly) {
  if (!poly?.market) return null;
  const parsed = parseMarket(poly.market);
  if (!parsed) return null;
  const vals = [];
  for (const o of parsed) vals.push({ ...o, price: await price(o.tokenId) });
  if (vals.some(x => x.price == null)) return null;
  const total = vals[0].price + vals[1].price;
  if (total <= 0) return null;
  return vals.map(x => ({ ...x, prob: x.price / total }));
}

function identifySides(prices, teamA, teamB) {
  let a = prices.find(x => sim(x.name, teamA) >= .5);
  let b = prices.find(x => sim(x.name, teamB) >= .5);
  if (!a || !b) {
    a = prices[0]; b = prices[1];
  }
  return { a, b };
}

function directMapWinner(match) {
  const candidates = [
    match?.map_winner, match?.mapWinner,
    match?.current_map?.winner, match?.currentMap?.winner,
    match?.last_map?.winner, match?.lastMap?.winner,
    match?.map?.winner
  ].filter(Boolean);
  const o=opponents(match);
  const names=o.map(x=>x?.opponent?.name||x?.opponent?.acronym||"");
  const ids=o.map(x=>String(x?.opponent?.id??""));
  for(const w of candidates){
    const id=w?.id??w?.team_id??w?.opponent?.id;
    if(id!=null){const idx=ids.indexOf(String(id));if(idx>=0)return idx;}
    const name=typeof w==="string"?w:(w?.name||w?.acronym||w?.team_name);
    if(name){const idx=names.findIndex(n=>sim(n,name)>=.5);if(idx>=0)return idx;}
  }
  for(const id of [match?.map_winner_id,match?.mapWinnerId,match?.winner_id]){
    if(id!=null){const idx=ids.indexOf(String(id));if(idx>=0)return idx;}
  }
  return null;
}
function mapMarginFromMatch(match) {
  const games = Array.isArray(match?.games) ? match.games : [];
  const finished = games.filter(x => {
    const status = String(x?.status || x?.state || "").toLowerCase();
    return ["finished","completed","complete","ended"].includes(status) ||
      Boolean(x?.complete || x?.completed || x?.finished || x?.end_at || x?.ended_at);
  });
  const g = finished[0] || null;
  // Map margin is taken only from Game/Map 1. Never use aggregate series score.
  if (!g) return {value:null, type:"unavailable", score:null};
  for (const s of [g?.score,g?.map_score,g?.game_score,g?.results]) {
    let a,b;
    if (Array.isArray(s) && s.length >= 2) { a=Number(s[0]); b=Number(s[1]); }
    else if (s && typeof s==="object") {
      a=Number(s.home??s.team1??s.a); b=Number(s.away??s.team2??s.b);
    }
    if (Number.isFinite(a)&&Number.isFinite(b)&&a!==b) {
      if (Math.max(a,b)<=1) return {value:null,type:"binary",score:[a,b]};
      return {value:Math.abs(a-b),type:"score",score:[a,b]};
    }
  }
  return {value:null,type:"unavailable",score:null};
}
function map1Info(match) {
  const o = opponents(match);
  const teamIds = o.map(x => String(x?.opponent?.id ?? ""));
  const teamNames = o.map(x => x?.opponent?.name || x?.opponent?.acronym || "");

  const directWinner=directMapWinner(match);
  if(directWinner!=null)return {winner:directWinner,loser:1-directWinner,series:seriesScore(match)||(directWinner===0?[1,0]:[0,1]),margin:mapMarginFromMatch(match),source:"map_winner"};

  const games = Array.isArray(match.games) ? match.games : [];
  const finishedGames = games.filter(g => {
    const status = String(g?.status || g?.state || "").toLowerCase();
    return ["finished","completed","complete","ended"].includes(status) ||
      Boolean(g?.complete || g?.completed || g?.finished || g?.end_at || g?.ended_at);
  });

  if (finishedGames.length >= 1) {
    const g = finishedGames[0];
    let winner = null;
    const winnerId = g?.winner?.id ?? g?.winner_id ?? g?.winner?.opponent?.id;
    if (winnerId != null) {
      const idx = teamIds.indexOf(String(winnerId));
      if (idx >= 0) winner = idx;
    }
    if (winner == null) {
      const wn = g?.winner?.name || g?.winner?.acronym || g?.winner_name;
      if (wn) {
        const idx = teamNames.findIndex(n => sim(n, wn) >= .5);
        if (idx >= 0) winner = idx;
      }
    }
    if (winner == null && g?.results) {
      const gr = Array.isArray(g.results) ? g.results : [];
      if (gr.length >= 2) {
        const a=Number(gr[0]?.score ?? gr[0]?.result), b=Number(gr[1]?.score ?? gr[1]?.result);
        if (Number.isFinite(a)&&Number.isFinite(b)&&a!==b) winner=a>b?0:1;
      }
    }
    if (winner != null) return {
      winner, loser:1-winner,
      series:seriesScore(match)||(winner===0?[1,0]:[0,1]),
      margin:mapMarginFromMatch(match),
      source:"games"
    };
  }

  const s=seriesScore(match);
  if (s && ((s[0]===1&&s[1]===0)||(s[1]===1&&s[0]===0))) {
    const winner=s[0]===1?0:1;
    let margin = {value:null,type:"unavailable",score:null};
    for (const c of [match.map_score,match.current_game_score,match.currentGameScore,match.game_score,match.gameScore,match.round_score,match.roundScore]) {
      let x,y;
      if (Array.isArray(c)&&c.length>=2) { x=Number(c[0]); y=Number(c[1]); }
      else if(c&&typeof c==="object"){ x=Number(c.home??c.team1??c.a); y=Number(c.away??c.team2??c.b); }
      if(Number.isFinite(x)&&Number.isFinite(y)&&x!==y){
        margin = Math.max(x,y)<=1
          ? {value:null,type:"binary",score:[x,y]}
          : {value:Math.abs(x-y),type:"score",score:[x,y]};
        break;
      }
    }
    return {winner,loser:1-winner,series:s,margin,source:"series_score"};
  }

  const status=String(match.status||"").toLowerCase();
  const explicitComplete=Boolean(match.complete||match.completed||match.finished)||["finished","completed","complete","ended"].includes(status);
  if(explicitComplete){
    const r=Array.isArray(match.results)?match.results:[];
    if(r.length>=2){
      const a=Number(r[0]?.score??r[0]?.result),b=Number(r[1]?.score??r[1]?.result);
      if(Number.isFinite(a)&&Number.isFinite(b)&&a+b===1){
        const winner=a===1?0:1;
        return {winner,loser:1-winner,series:[a,b],margin:{value:null,type:"binary",score:[a,b]},source:"completed_result"};
      }
    }
  }
  return null;
}
function loadState() {
  const path = "state/esports-map1-overreaction.json";
  try {
    return { path, value: JSON.parse(fs.readFileSync(path,"utf8")) };
  } catch {
    return { path, value: { matches:{}, alerts:[] } };
  }
}

function saveState(s) {
  fs.mkdirSync("state",{recursive:true});
  fs.writeFileSync(s.path, JSON.stringify(s.value,null,2) + "\n");
}

async function claimAlertStrict(key, meta = {}) {
  const path = "state/esports-alert-dedupe.json";
  const api = "https://api.github.com/repos/" + GH_REPO + "/contents/" + path;
  const headers = {
    accept:"application/vnd.github+json",
    authorization:"Bearer " + GH_TOKEN,
    "x-github-api-version":"2022-11-28"
  };
  for (let attempt=1; attempt<=5; attempt++) {
    try {
      let currentSha = null;
      let data = {version:1, alerts:{}};
      const r = await fetch(api,{headers,signal:AbortSignal.timeout(5000)});
      if (r.ok) {
        const j = await r.json();
        currentSha = j.sha || null;
        if (j.content) data = JSON.parse(Buffer.from(j.content.replace(/\n/g,""),"base64").toString("utf8"));
      } else if (r.status !== 404) throw new Error("DEDUPE_READ_HTTP_"+r.status);
      data.alerts ||= {};
      if (data.alerts[key]) return false;
      data.alerts[key] = {
        claimedAt:new Date().toISOString(),
        runId:process.env.GITHUB_RUN_ID||null,
        matchId:meta.matchId||null,
        teamA:meta.teamA||null,
        teamB:meta.teamB||null
      };
      const body = {
        message:"ESPORTS strict alert claim " + key,
        content:Buffer.from(JSON.stringify(data,null,2)+"\n").toString("base64"),
        branch:"main"
      };
      if (currentSha) body.sha=currentSha;
      const w = await fetch(api,{
        method:"PUT",
        headers:{...headers,"content-type":"application/json"},
        body:JSON.stringify(body),
        signal:AbortSignal.timeout(5000)
      });
      if (w.ok) return true;
      if (w.status === 409 || w.status === 422) {
        await new Promise(r=>setTimeout(r,300*attempt));
        continue;
      }
      throw new Error("DEDUPE_WRITE_HTTP_"+w.status);
    } catch(e) {
      if (attempt===5) throw e;
      await new Promise(r=>setTimeout(r,300*attempt));
    }
  }
  throw new Error("STRICT_DEDUPE_UNAVAILABLE");
}

async function telegram(text) {
  const body = new URLSearchParams({
    chat_id: TG_CHAT,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: "false",
  });
  const r = await fetch("https://api.telegram.org/bot"+TG_TOKEN+"/sendMessage", {
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body,
    signal:AbortSignal.timeout(12000)
  });
  const j = await r.json();
  log("TELEGRAM_RESPONSE", JSON.stringify({status:r.status,ok:j.ok}));
  if (!r.ok || !j.ok) throw new Error("Telegram send failed");
}

const state = loadState();
state.value.telemetry ||= telemetry;
Object.assign(telemetry, state.value.telemetry || {});
telemetry.recent = Array.isArray(telemetry.recent) ? telemetry.recent.slice(-80) : [];

function persistRemoteState() {
  // Keep runtime state local. Live diagnostics are published via GitHub API.
  state.value.telemetry = telemetry;
  saveState(state);
}

async function publishHeartbeat(stage, extra = {}) {
  if (!GH_TOKEN || !GH_REPO) return;
  const payload = {
    updatedAt: new Date().toISOString(),
    stage,
    runId: process.env.GITHUB_RUN_ID || null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT || null,
    sha: process.env.GITHUB_SHA || null,
    pid: process.pid,
    telemetry: {
      startedAt: telemetry.startedAt,
      events: telemetry.events,
      polls: telemetry.polls,
      alerts: telemetry.alerts,
      errors: telemetry.errors,
      lastError: telemetry.lastError
    },
    ...extra
  };
  const path = "state/esports-live.json";
  try {
    const api = "https://api.github.com/repos/" + GH_REPO + "/contents/" + path;
    const headers = {
      accept:"application/vnd.github+json",
      authorization:"Bearer " + GH_TOKEN,
      "x-github-api-version":"2022-11-28"
    };
    let sha = null;
    const current = await fetch(api, {headers, signal:AbortSignal.timeout(5000)});
    if (current.ok) {
      const j = await current.json();
      sha = j.sha || null;
    }
    const body = {
      message: "ESPORTS monitor heartbeat",
      content: Buffer.from(JSON.stringify(payload,null,2)+"\\n").toString("base64"),
      branch: "main"
    };
    if (sha) body.sha = sha;
    const r = await fetch(api, {
      method:"PUT",
      headers:{...headers,"content-type":"application/json"},
      body:JSON.stringify(body),
      signal:AbortSignal.timeout(5000)
    });
    if (!r.ok) throw new Error("GitHub heartbeat HTTP " + r.status);
  } catch (e) {
    nativeConsoleLog("HEARTBEAT_ERROR", JSON.stringify({stage,error:String(e)}));
  }
}

async function poll() {
  const now = Date.now();
  const diag = {
    startedAt: new Date(now).toISOString(),
    upcoming: 0,
    running: 0,
    bo3: 0,
    bo5: 0,
    firstTo3: 0,
    skippedFuture: 0,
    missingTeams: 0,
    polyEvents: 0,
    matchedPoly: 0,
    noPolyMatch: 0,
    noPolyPrice: 0,
    prematchCaptured: 0,
    map1Finished: 0,
    alreadyAlerted: 0,
    noPrematch: 0,
    signalChecks: 0,
    balancedPrePass: 0,
    movePass: 0,
    postRangePass: 0,
    mapFilterPass: 0,
    signalPass: 0,
    noMarketUrl: 0,
    alertsSent: 0,
    samples: [],
    rejects: []
  };
  const sample = (arr, value, limit = 12) => {
    if (arr.length < limit) arr.push(value);
  };
  await publishHeartbeat("POLL_START", {now:new Date(now).toISOString(), diagnostics:diag});

const nowMs = Date.now();
const UPCOMING_TTL = 5 * 60 * 1000;
const RUNNING_TTL = 60 * 1000;

let upcoming = psUpcomingCache.data;
let running = psRunningCache.data;

if (!psUpcomingCache.at || nowMs - psUpcomingCache.at >= UPCOMING_TTL) {
  upcoming = await psPaged("/matches/upcoming", 5);
  psUpcomingCache = {at: Date.now(), data: upcoming};
} else {
  log("PANDASCORE_CACHE", {endpoint:"upcoming", ageMs: nowMs - psUpcomingCache.at});
}

if (!psRunningCache.at || nowMs - psRunningCache.at >= RUNNING_TTL) {
  running = await psPaged("/matches/running", 2);
  psRunningCache = {at: Date.now(), data: running};
} else {
  log("PANDASCORE_CACHE", {endpoint:"running", ageMs: nowMs - psRunningCache.at});
}
diag.upcoming = upcoming.length;
diag.running = running.length;
await publishHeartbeat("PANDASCORE_OK", {
  upcoming:upcoming.length,
  running:running.length,
  diagnostics:diag
});

const candidates = [...new Map([...upcoming, ...running].map(m => [String(m.id), m])).values()].filter(m => supportedSeries(m));
diag.bo3 = candidates.filter(m => String(m.match_type || "").toLowerCase() === "best_of" && Number(m.number_of_games) === 3).length;
diag.bo5 = candidates.filter(m => String(m.match_type || "").toLowerCase() === "best_of" && Number(m.number_of_games) === 5).length;
diag.firstTo3 = candidates.filter(m => String(m.match_type || "").toLowerCase() === "first_to" && Number(m.number_of_games) === 3).length;
const polyEvents = await loadPolyEvents();
diag.polyEvents = polyEvents.length;
await publishHeartbeat("POLYMARKET_OK", {
  polyEvents:polyEvents.length,
  candidates:candidates.length,
  diagnostics:diag
});
log("POLY_EVENTS", JSON.stringify({count:polyEvents.length}));
log("PANDASCORE_SERIES", JSON.stringify({upcoming:upcoming.length,running:running.length,candidates:candidates.length,bo3:diag.bo3,bo5:diag.bo5,firstTo3:diag.firstTo3,allEsports:true}));

for (const match of candidates) {
  const ts = beginAt(match);
  if (ts && ts - now > CFG.maxUpcomingHours*3600000) {
    diag.skippedFuture++;
    sample(diag.rejects, {reason:"future_over_24h",matchId:String(match.id),beginAt:match.begin_at || match.scheduled_at}, 20);
    continue;
  }
  const [teamA,teamB] = teams(match);
  if (!teamA || !teamB) {
    diag.missingTeams++;
    sample(diag.rejects, {reason:"missing_teams",matchId:String(match.id),opponents:opponents(match).length}, 20);
    continue;
  }
  sample(diag.samples, {matchId:String(match.id),teams:[teamA,teamB],status:match.status,beginAt:match.begin_at || match.scheduled_at}, 12);

  const key = String(match.id);
  await publishHeartbeat("MATCH_PROGRESS", {
    matchId:key,
    teams:[teamA,teamB],
    status:match.status,
    seriesScore:seriesScore(match),
    candidates:candidates.length,
    diagnostics:diag
  });
  const entry = state.value.matches[key] ||= {
    id:key, teamA, teamB, beginAt:ts, pre:null, alerted:false, lastSeries:null
  };

  let poly = findPolyEvent(polyEvents,teamA,teamB);
  if (!poly) {
    const fallbackNearStart = !ts || ts <= now + 6 * 3600000;
    log("NO_POLY_MATCH", {key,teamA,teamB,action:"search_fallback"});
    // Do not let three sequential public-search calls for every upcoming fixture
    // stall the entire 20-second polling loop. Use fallback search only for
    // matches that are already running or start within the next 6 hours.
    const searched = fallbackNearStart ? await searchPolyForMatch(teamA,teamB) : [];
    poly = findPolyEvent(searched,teamA,teamB);
    if (poly) {
      diag.matchedPoly++;
      sample(diag.samples, {
        matchId:key, teams:[teamA,teamB], source:"public-search",
        polyEventId:String(poly.event?.id || ""),
        polyEventSlug:String(poly.event?.slug || ""),
        marketId:String(poly.market?.id || ""),
        marketSlug:String(poly.market?.slug || ""),
        marketQuestion:String(poly.market?.question || poly.market?.title || ""),
        matchScore:poly.score
      }, 12);
      log("POLY_SEARCH_MATCH", {key,teamA,teamB,eventId:String(poly.event?.id || ""),eventSlug:String(poly.event?.slug || ""),marketId:String(poly.market?.id || "")});
    }
  }
  if (!poly) {
    diag.noPolyMatch++;
    sample(diag.rejects, {reason:"no_polymarket_match",matchId:key,teamA,teamB}, 20);
    continue;
  }
  diag.matchedPoly++;
  sample(diag.samples, {
    matchId:key,
    teams:[teamA,teamB],
    polyEventId:String(poly.event?.id || ""),
    polyEventSlug:String(poly.event?.slug || ""),
    marketId:String(poly.market?.id || ""),
    marketSlug:String(poly.market?.slug || ""),
    marketQuestion:String(poly.market?.question || poly.market?.title || ""),
    matchScore:poly.score
  }, 12);

  const prices = await marketPrices(poly);
  if (!prices) {
    diag.noPolyPrice++;
    sample(diag.rejects, {reason:"no_polymarket_price",matchId:key,teamA,teamB}, 20);
    log("NO_POLY_PRICE", JSON.stringify({key,teamA,teamB}));
    continue;
  }
  const sides = identifySides(prices,teamA,teamB);

  const map1State = map1Info(match);
  if (!entry.pre && !map1State) {
    await ensurePrematchBaseline(match, poly, entry);
  }
  if (!entry.pre && (!ts || ts > now)) {
    entry.pre = {
      teamA, teamB,
      a: sides.a.prob, b: sides.b.prob,
      capturedAt: new Date().toISOString(),
      marketId: String(poly.market.id || ""),
      eventSlug: String(poly.event.slug || "")
    };
    diag.prematchCaptured++;
    log("PREMATCH_CAPTURED", JSON.stringify({key,teamA,teamB,a:sides.a.prob,b:sides.b.prob}));
  }

  const info = map1Info(match);
  entry.lastSeries = seriesScore(match);
  log("MATCH_STATE", {
    key,teamA,teamB,status:match.status,matchType:match.match_type,numberOfGames:match.number_of_games,
    seriesScore:entry.lastSeries,map1Detected:Boolean(info),
    complete:match.complete,detailedStats:match.detailed_stats,liveSupported:match.live_supported,
    results:Array.isArray(match.results) ? match.results : null,
    scoreField:match.score ?? null,
    seriesScoreField:match.series_score ?? match.seriesScore ?? null,
    hasGames:Array.isArray(match.games),gamesCount:Array.isArray(match.games) ? match.games.length : null,
    topLevelKeys:Object.keys(match).filter(k => /score|game|result|winner|complete|live/i.test(k)).sort(),
    rawOpponentScores:opponents(match).map(x => ({
      id:x?.opponent?.id ?? null,
      name:x?.opponent?.name ?? x?.opponent?.acronym ?? null,
      score:x?.score ?? null
    }))
  });

  if (!info) {
    sample(diag.rejects, {reason:"map1_not_finished",matchId:key,teamA,teamB,seriesScore:entry.lastSeries}, 20);
    log("MAP1_NOT_FINISHED", {key,teamA,teamB,seriesScore:entry.lastSeries});
    continue;
  }
  diag.map1Finished++;
  if (entry.alerted) {
    diag.alreadyAlerted++;
    sample(diag.rejects, {reason:"already_alerted",matchId:key,teamA,teamB}, 20);
    log("ALREADY_ALERTED", {key,teamA,teamB});
    continue;
  }
  if (!entry.pre) {
    entry.pre = {
      teamA, teamB,
      a: 0.5, b: 0.5,
      capturedAt: new Date().toISOString(),
      marketId: String(poly.market?.id || ""),
      eventSlug: String(poly.event?.slug || ""),
      source: "neutral_fallback"
    };
    diag.prematchCaptured++;
    log("PREMATCH_FALLBACK", JSON.stringify({key,teamA,teamB,a:0.5,b:0.5}));
  }

  const preWinner = info.winner === 0 ? entry.pre.a : entry.pre.b;
  const preLoser = info.loser === 0 ? entry.pre.a : entry.pre.b;
  const postWinner = info.winner === 0 ? sides.a.prob : sides.b.prob;
  const postLoser = info.loser === 0 ? sides.a.prob : sides.b.prob;

  const preFavorite = Math.max(entry.pre.a,entry.pre.b);
  const move = postWinner - preWinner;
  const marginValue = Number(info.margin?.value);
  const marginMaxScore = Array.isArray(info.margin?.score) ? Math.max(...info.margin.score.map(Number)) : null;
  const marginRatio = Number.isFinite(marginValue) && Number.isFinite(marginMaxScore) && marginMaxScore > 0
    ? marginValue / marginMaxScore : null;
  const oneSided = Number.isFinite(marginValue) &&
    marginValue >= CFG.minMapMargin &&
    marginRatio >= CFG.minMapMarginRatio;
  const balancedPre = preFavorite >= CFG.minPreFavorite && preFavorite <= CFG.maxPreFavorite;
  const overshoot = move >= CFG.minMove && postWinner >= CFG.minPostFavorite && postWinner <= CFG.maxPostFavorite;
  const mapFilter = CFG.requireMapMargin ? oneSided : true;

  diag.signalChecks++;
  if (balancedPre) diag.balancedPrePass++;
  if (move >= CFG.minMove) diag.movePass++;
  if (postWinner >= CFG.minPostFavorite && postWinner <= CFG.maxPostFavorite) diag.postRangePass++;
  if (mapFilter) diag.mapFilterPass++;
  if (balancedPre && overshoot && mapFilter) diag.signalPass++;
  else {
    const reasons = [];
    if (!balancedPre) reasons.push("pre_range");
    if (move < CFG.minMove) reasons.push("move");
    if (postWinner < CFG.minPostFavorite || postWinner > CFG.maxPostFavorite) reasons.push("post_range");
    if (!mapFilter) reasons.push("map_filter");
    sample(diag.rejects, {
      reason:"signal_rejected",
      matchId:key,
      teams:[teamA,teamB],
      series:info.series,
      margin:info.margin,
      marginValue,marginRatio,
      pre:[entry.pre.a,entry.pre.b],
      post:[sides.a.prob,sides.b.prob],
      move,
      reasons
    }, 20);
  }

  log("SIGNAL_CHECK", JSON.stringify({
    key,match:teamA+" vs "+teamB,map1:info.series,margin:info.margin,marginValue,marginRatio,
    preA:entry.pre.a,preB:entry.pre.b,postA:sides.a.prob,postB:sides.b.prob,
    move,balancedPre,overshoot,mapFilter
  }));

  if (!(balancedPre && overshoot && mapFilter)) continue;

  const loser = info.loser === 0 ? teamA : teamB;
  const loserProb = postLoser;
  const winner = info.winner === 0 ? teamA : teamB;
  const marginText = Number.isFinite(marginValue) ? String(marginValue) : "—";

  const text =
    "<b>ESPORTS — MAP 2</b>\n\n" +
    "<b>"+winner+"</b> won Map 1 vs <b>"+loser+"</b>\n" +
    "MAP 1 SERIES SCORE: "+info.series[0]+"–"+info.series[1]+"\n" +
    "MAP MARGIN: "+marginText+"\n\n" +
    "PRE-MATCH\n" +
    teamA+": "+Math.round(entry.pre.a*100)+"%\n" +
    teamB+": "+Math.round(entry.pre.b*100)+"%\n\n" +
    "AFTER MAP 1\n" +
    teamA+": "+Math.round(sides.a.prob*100)+"%\n" +
    teamB+": "+Math.round(sides.b.prob*100)+"%\n\n" +
    "MOVE: +"+Math.round(move*100)+" pp\n" +
    "NEXT MAP CANDIDATE: <b>"+loser+"</b>\n" +
    "CURRENT: "+Math.round(loserProb*100)+"%";

  // Polymarket's canonical share link is the EVENT URL.
  // The market slug is not appended: some sport events expose the same
  // event/market slug pair, but the event page is the reliable live link.
  const eventSlug = String(poly.event?.slug || "").trim();
  const marketSlug = String(poly.market?.slug || "").trim();
  const explicitMarketUrl = String(poly.market?.url || "").trim();
  const marketUrl = eventSlug
    ? "https://polymarket.com/event/" + encodeURIComponent(eventSlug)
    : explicitMarketUrl;
  if (!marketUrl) {
    diag.noMarketUrl++;
    sample(diag.rejects, {reason:"no_market_url",matchId:key,teamA,teamB,marketId:String(poly.market?.id || ""),eventSlug,marketSlug}, 20);
    log("NO_MARKET_URL", {
      marketId:String(poly.market?.id || ""),
      eventSlug,
      marketSlug,
      hasExplicitUrl:Boolean(explicitMarketUrl)
    });
    continue;
  }
  log("MARKET_URL_RESOLVED", {
    source: explicitMarketUrl ? "market.url" : "event_slug+market_slug",
    marketId:String(poly.market?.id || ""),
    eventSlug,
    marketSlug,
    url:marketUrl
  });
  const strictKey = "ESPORTS_MAP1:" + key;
  let claimed = false;
  try {
    claimed = await claimAlertStrict(strictKey, {
      matchId:key, teamA, teamB,
      eventSlug:String(poly.event?.slug || ""),
      marketId:String(poly.market?.id || "")
    });
  } catch (e) {
    log("STRICT_DEDUPE_ERROR", {key,error:String(e)});
    throw e;
  }
  if (!claimed) {
    diag.alreadyAlerted++;
    sample(diag.rejects, {reason:"strict_duplicate_blocked",matchId:key,teamA,teamB}, 20);
    continue;
  }

  await telegram(text + "\n\n" + marketUrl);

  entry.alerted = true;
  entry.alertedAt = new Date().toISOString();
  diag.alertsSent++;
  state.value.alerts.push({matchId:key,teamA,teamB,winner,loser,preWinner,postWinner,move,at:entry.alertedAt});
  state.value.alerts = state.value.alerts.slice(-500);
  saveState(state);
  log("ALERT_SENT", JSON.stringify({key,teamA,teamB,loser,move}));
}


saveState(state);
await publishHeartbeat("POLL_RESULT", {
  diagnostics:diag,
  config:{
    minPreFavorite:CFG.minPreFavorite,
    maxPreFavorite:CFG.maxPreFavorite,
    minMove:CFG.minMove,
    minPostFavorite:CFG.minPostFavorite,
    maxPostFavorite:CFG.maxPostFavorite,
    requireMapMargin:CFG.requireMapMargin,
    minMapMargin:CFG.minMapMargin,
    maxUpcomingHours:CFG.maxUpcomingHours
  },
  tracked:Object.keys(state.value.matches).length,
  alerts:state.value.alerts.length
});
log("POLL_RESULT", {
  tracked:Object.keys(state.value.matches).length,
  alerts:state.value.alerts.length,
  diagnostics:diag
});
}

while (true) {
  const started = Date.now();
  try {
    await poll();
  } catch (e) {
    log("POLL_ERROR", JSON.stringify({error:String(e),stack:e?.stack}));
  }
  persistRemoteState();
  const elapsed = Date.now() - started;
  const wait = Math.max(5000, 20000 - elapsed);
  log("NEXT_POLL", JSON.stringify({waitMs:wait}));
  await sleep(wait);
}


// Trigger fresh GitHub Actions run on the corrected Map 1 detection code.
