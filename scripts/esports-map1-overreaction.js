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
  maxPostFavorite: 0.95,
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
  for (let page=1; page<=maxPages; page++) {
    const sep=path.includes("?")?"&":"?";
    const batch=await ps(path+sep+"page="+page+"&per_page=100");
    if (!Array.isArray(batch)||!batch.length) break;
    all.push(...batch);
    if (batch.length<100) break;
  }
  return [...new Map(all.filter(x=>x?.id!=null).map(x=>[String(x.id),x])).values()];
}
function opponents(match) { return Array.isArray(match.opponents) ? match.opponents : []; }
function teams(match) { return opponents(match).map(x => x?.opponent?.name || x?.opponent?.acronym).filter(Boolean).slice(0,2); }
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
  return (type === "best_of" && (games === 3 || games === 5)) ||
         (type === "first_to" && games === 3) ||
         (type === "red_bull_home_ground" && games === 5);
}
function beginAt(match) {
  const v = match.begin_at || match.scheduled_at;
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : null;
}
function parseJsonMaybe(v) { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } }
function eventTeams(event) {
  const out = [];
  const add = v => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (v && typeof v === "object") { const n = v.name || v.teamName || v.title; if (n) out.push(String(n)); }
  };
  add(event.homeTeam); add(event.awayTeam); add(event.homeTeamName); add(event.awayTeamName);
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
  if (/\bmap\s*\d+\b/i.test(q)) return false;
  if (/\b(total|over|under|spread|handicap|rounds?|kills?|first\s+map|map\s+winner|game\s*\d+)\b/i.test(q)) return false;
  return true;
}
async function loadPolyEvents() {
  const urls = [
    GAMMA + "/events?active=true&closed=false&limit=500&tag_slug=esports",
    GAMMA + "/events?active=true&closed=false&limit=500&order=startDate&ascending=true",
  ];
  let events = [];
  for (const u of urls) {
    try { const x = await getJson(u); if (Array.isArray(x.data)) events.push(...x.data); }
    catch (e) { log("POLY_DISCOVERY_ERROR", String(e)); }
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
      const url = GAMMA + "/public-search?q=" + encodeURIComponent(q) + "&limit_per_type=20&page=1&keep_closed_markets=0";
      const x = await getJson(url);
      const data = x.data || {};
      for (const e of (Array.isArray(data.events) ? data.events : [])) found.push(e);
      for (const m of (Array.isArray(data.markets) ? data.markets : [])) if (m?.event) found.push(m.event);
    } catch (e) { log("POLY_SEARCH_ERROR", {teamA,teamB,error:String(e)}); }
  }
  const result = [...new Map(found.filter(e=>e?.id!=null).map(e=>[String(e.id),e])).values()];
  polySearchCache.set(cacheKey, result);
  return result;
}
async function hydratePolyEvent(candidate, teamA, teamB) {
  if (!candidate?.event) return null;
  const e = candidate.event;
  let markets = Array.isArray(e.markets) ? e.markets : [];
  if (!markets.length && e.id) {
    try { const x=await getJson(GAMMA+"/events/"+encodeURIComponent(String(e.id))); markets=Array.isArray(x.data?.markets)?x.data.markets:[]; }
    catch (err) { log("POLY_EVENT_ERROR", {eventId:e.id,error:String(err)}); }
  }
  const m=markets.find(x=>isMatchWinnerMarket(x,teamA,teamB));
  return m ? {event:e,market:m} : null;
}
const priceCache = new Map();
async function price(tokenId) {
  const c=priceCache.get(tokenId);
  if(c && Date.now()-c.at<30000) return c.value;
  try {
    const x=await getJson(CLOB+"/price?token_id="+encodeURIComponent(tokenId)+"&side=BUY");
    const v=Number(x.data?.price);
    if(!Number.isFinite(v)) return null;
    priceCache.set(tokenId,{at:Date.now(),value:v});
    return v;
  } catch { return null; }
}
const polyPriceCache = new Map();
async function marketPrices(poly) {
  if (!poly?.market) return null;
  const parsed = parseMarket(poly.market);
  if (!parsed) return null;
  const cacheKey = String(poly.market.id || parsed.map(x => x.tokenId).join("|"));
  const cached = polyPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 30000) return cached.data;
  const vals = await Promise.all(parsed.map(async o => ({ ...o, price: await price(o.tokenId) })));
  if (vals.some(x => x.price == null)) return null;
  const total = vals[0].price + vals[1].price;
  if (total <= 0) return null;
  const data = vals.map(x => ({ ...x, prob: x.price / total }));
  polyPriceCache.set(cacheKey, {at:Date.now(), data});
  return data;
}
function identifySides(prices, teamA, teamB) {
  const pa=prices.find(x=>sim(x.name,teamA)>=.5), pb=prices.find(x=>sim(x.name,teamB)>=.5);
  return {a:pa||prices[0],b:pb||prices[1]};
}
function parseGameScore(g) {
  for (const s of [g?.score,g?.map_score,g?.game_score,g?.results]) {
    let a,b;
    if (Array.isArray(s) && s.length >= 2) {
      if (typeof s[0] === "object" && typeof s[1] === "object") {
        a=Number(s[0]?.score ?? s[0]?.result ?? s[0]?.value);
        b=Number(s[1]?.score ?? s[1]?.result ?? s[1]?.value);
      } else { a=Number(s[0]); b=Number(s[1]); }
    } else if (s && typeof s === "object") {
      a=Number(s.home??s.team1??s.a??s.home_score??s.team1_score);
      b=Number(s.away??s.team2??s.b??s.away_score??s.team2_score);
    }
    if (Number.isFinite(a)&&Number.isFinite(b)&&a!==b) {
      if (Math.max(a,b)<=1) return {value:null,type:"binary",score:[a,b]};
      return {value:Math.abs(a-b),type:"score",score:[a,b]};
    }
  }
  return {value:null,type:"unknown",score:null};
}
function firstFinishedGame(match) {
  const games=Array.isArray(match.games)?match.games:[];
  const finished=games.filter(g=>/^(finished|completed|complete|ended)$/i.test(String(g?.status||g?.state||"")));
  if (!finished.length) return null;
  finished.sort((a,b)=>Number(a?.position??a?.number??a?.id??0)-Number(b?.position??b?.number??b?.id??0));
  return finished[0];
}
function map1Info(match) {
  const g=firstFinishedGame(match);
  if (!g) return null;
  const score=parseGameScore(g);
  const series=seriesScore(match);
  if (!series || series[0]===series[1]) return null;
  const winner=series[0]>series[1]?0:1;
  const loser=winner===0?1:0;
  let marginValue=score.value;
  let marginRatio=null;
  if (Number.isFinite(marginValue) && score.score) marginRatio=marginValue/Math.max(...score.score);
  return {winner,loser,series,margin:score.score,marginValue,marginRatio};
}
function diagInit() {
  return {events:0,candidates:0,matchedPoly:0,map1Finished:0,signalChecks:0,balancedPrePass:0,movePass:0,postRangePass:0,mapFilterPass:0,signalPass:0,alertsSent:0,alreadyAlerted:0,noMarketUrl:0, rejects:[]};
}
function sample(arr,v,max=20) { if(arr.length<max) arr.push(v); }
function pushStageLog(diag,key,stage,extra={}) { sample(diag.rejects,{reason:stage,matchId:key,...extra},20); }
function mapMarginPass(info) {
  if (!CFG.requireMapMargin) return true;
  if (!Number.isFinite(info.marginValue)) return true;
  return info.marginValue >= CFG.minMapMargin && Number.isFinite(info.marginRatio) && info.marginRatio >= CFG.minMapMarginRatio;
}
function map1Finished(match) { return Boolean(map1Info(match)); }

async function assertCurrentRun() {
  const runId=String(process.env.GITHUB_RUN_ID||"");
  const sha=String(process.env.GITHUB_SHA||"");
  if(!runId||!sha)return;
  const r=await fetch("https://api.github.com/repos/"+GH_REPO+"/actions/runs/"+runId,{headers:{accept:"application/vnd.github+json",authorization:"Bearer "+GH_TOKEN,"x-github-api-version":"2022-11-28"},signal:AbortSignal.timeout(5000)});
  if(!r.ok)throw new Error("RUN_GUARD_HTTP_"+r.status);
  const j=await r.json();
  if(String(j.head_sha||"")!==sha||String(j.status||"")!=="in_progress")throw new Error("STALE_RUN_BLOCKED");
}

async function telegram(text) {
  const r=await fetch("https://api.telegram.org/bot"+TG_TOKEN+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:"HTML",disable_web_page_preview:false}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error("TELEGRAM_HTTP_"+r.status);
}

async function claimAlertStrict(key, meta = {}) {
  const path="state/esports-alert-dedupe.json";
  const apiFor=p=>"https://api.github.com/repos/"+GH_REPO+"/contents/"+p;
  const headers={accept:"application/vnd.github+json",authorization:"Bearer "+GH_TOKEN,"x-github-api-version":"2022-11-28"};
  const canonicalKey="ESPORTS_MAP1:"+String(meta.matchId||key).replace(/^.*:/,"");
  for(let attempt=1;attempt<=7;attempt++){
    const rr=await fetch(apiFor(path),{headers,signal:AbortSignal.timeout(5000)});
    const j=rr.status===404?{sha:null,content:null}:await rr.json();
    if(!rr.ok&&rr.status!==404)throw new Error("DEDUPE_READ_HTTP_"+rr.status);
    const data=j.content?JSON.parse(Buffer.from(j.content.replace(/\n/g,""),"base64").toString("utf8")):{version:2,alerts:{}};
    data.alerts ||= {};
    if(data.alerts[canonicalKey])return false;
    data.alerts[canonicalKey]={claimedAt:new Date().toISOString(),runId:process.env.GITHUB_RUN_ID||null,matchId:String(meta.matchId||""),teamA:meta.teamA||null,teamB:meta.teamB||null};
    const body={message:"Strict esports Map 1 alert claim "+canonicalKey,content:Buffer.from(JSON.stringify(data,null,2)+"\n").toString("base64"),branch:"main"};
    if(j.sha)body.sha=j.sha;
    const w=await fetch(apiFor(path),{method:"PUT",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    if(w.ok)return true;
    if(w.status===409||w.status===422){await sleep(250*attempt);continue;}
    throw new Error("DEDUPE_WRITE_HTTP_"+w.status);
  }
  throw new Error("STRICT_DEDUPE_UNAVAILABLE");
}

async function runPoll(state) {
  const diag=diagInit();
  const upcoming=Date.now();
  const [upcomingMatches,runningMatches,polyEvents]=await Promise.all([
    psPaged("/matches/upcoming",5),
    psPaged("/matches/running",3),
    loadPolyEvents()
  ]);
  const all=[...new Map([...upcomingMatches,...runningMatches].filter(x=>x?.id!=null).map(x=>[String(x.id),x])).values()];
  const candidates=all.filter(supportedSeries);
  diag.events=all.length; diag.candidates=candidates.length;
  const prioritizedCandidates=[...candidates].sort((a,b)=>{
    const score=m=>{const status=String(m?.status||"").toLowerCase();const t=beginAt(m);if(["running","live","in_progress"].includes(status))return 0;if(t!=null&&t<=Date.now())return 1;const games=Array.isArray(m?.games)?m.games:[];if(games.some(g=>/^(finished|completed|complete|ended)$/i.test(String(g?.status||g?.state||""))))return 2;return 3;};
    return score(a)-score(b);
  });
  for(const match of prioritizedCandidates){
    const ts=beginAt(match);
    if(ts!=null && ts>Date.now()+CFG.maxUpcomingHours*3600000)continue;
    const tt=teams(match); if(tt.length!==2)continue;
    const [teamA,teamB]=tt;
    const candidatesPoly=[];
    for(const e of polyEvents){const et=eventTeams(e);if(et.length>=2&&Math.max(nameScore(et[0],teamA)+nameScore(et[1],teamB),nameScore(et[0],teamB)+nameScore(et[1],teamA))>=1.25)candidatesPoly.push({event:e});}
    let poly=null;
    for(const pc of candidatesPoly.slice(0,8)){poly=await hydratePolyEvent(pc,teamA,teamB);if(poly)break;}
    if(!poly){const found=await searchPolyForMatch(teamA,teamB);for(const e of found.slice(0,8)){poly=await hydratePolyEvent({event:e},teamA,teamB);if(poly)break;}}
    if(!poly)continue;
    diag.matchedPoly++;
    const key=String(match.id);
    state.matches ||= {};
    const entry=state.matches[key] ||= {matchId:key,teamA,teamB};
    const pre=await ensurePrematchBaseline(match,poly,entry); if(!pre)continue;
    const info=map1Info(match); if(!info)continue;
    diag.map1Finished++;
    const prices=await marketPrices(poly); if(!prices)continue;
    diag.signalChecks++;
    const sides=identifySides(prices,teamA,teamB);
    const preFav=Math.max(pre.a,pre.b), balancedPre=preFav>=CFG.minPreFavorite&&preFav<=CFG.maxPreFavorite;
    const winnerProb=info.winner===0?sides.a.prob:sides.b.prob;
    const loserProb=info.loser===0?sides.a.prob:sides.b.prob;
    const preWinner=info.winner===0?pre.a:pre.b;
    const move=winnerProb-preWinner;
    const overshoot=winnerProb>=CFG.minPostFavorite&&winnerProb<=CFG.maxPostFavorite;
    const mapFilter=mapMarginPass(info);
    if(balancedPre)diag.balancedPrePass++;
    if(move>=CFG.minMove)diag.movePass++;
    if(overshoot)diag.postRangePass++;
    if(mapFilter)diag.mapFilterPass++;
    if(balancedPre&&move>=CFG.minMove&&overshoot&&mapFilter){
      diag.signalPass++;
      const loser=info.loser===0?teamA:teamB; const marginText=Number.isFinite(info.marginValue)?String(info.marginValue):"—";
      const text="<b>ESPORTS — MAP 2</b>\n\n<b>"+(info.winner===0?teamA:teamB)+"</b> won Map 1 vs <b>"+loser+"</b>\nMAP 1 SERIES SCORE: "+info.series[0]+"–"+info.series[1]+"\nMAP MARGIN: "+marginText+"\n\nPRE-MATCH\n"+teamA+": "+Math.round(pre.a*100)+"%\n"+teamB+": "+Math.round(pre.b*100)+"%\n\nAFTER MAP 1\n"+teamA+": "+Math.round(sides.a.prob*100)+"%\n"+teamB+": "+Math.round(sides.b.prob*100)+"%\n\nMOVE: +"+Math.round(move*100)+" pp\nNEXT MAP CANDIDATE: <b>"+loser+"</b>\nCURRENT: "+Math.round(loserProb*100)+"%";
      const eventSlug=String(poly.event?.slug||"").trim(); const explicitMarketUrl=String(poly.market?.url||"").trim(); const marketUrl=eventSlug?"https://polymarket.com/event/"+encodeURIComponent(eventSlug):explicitMarketUrl; if(!marketUrl)continue;
      const claimed=await claimAlertStrict("ESPORTS_MAP1:"+key,{matchId:key,teamA,teamB}); if(!claimed){diag.alreadyAlerted++;continue;}
      await assertCurrentRun(); await telegram(text+"\n\n"+marketUrl); diag.alertsSent++;
      entry.alerted=true; entry.alertedAt=new Date().toISOString(); state.alerts ||= []; state.alerts.push({matchId:key,teamA,teamB,move,at:entry.alertedAt}); state.alerts=state.alerts.slice(-500);
    }
  }
  saveState(state); telemetry.polls++; await publishHeartbeat("POLL_RESULT",{diagnostics:diag,config:CFG});
}

const state={matches:{},alerts:[]};
function saveState(s){fs.mkdirSync("state",{recursive:true});fs.writeFileSync("state/esports-live.json",JSON.stringify(s,null,2)+"\n");}
async function publishHeartbeat(event,data){log(event,data);try{const now=Date.now();if(now-lastRemotePushAt<5000)return;lastRemotePushAt=now;}catch{}}

async function main(){log("MONITOR_STARTING",{source:"PandaScore + Polymarket"});await runPoll(state);log("MONITOR_FINISHED",{alerts:state.alerts.length});}
main().catch(e=>{log("POLL_ERROR",{error:String(e),stack:e?.stack});process.exitCode=1;});
