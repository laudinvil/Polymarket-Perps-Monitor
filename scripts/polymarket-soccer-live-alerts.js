// PRODUCTION LIVE MONITOR: continuous LIVE-only soccer alerts.
// Diagnostic probe: verify soccer-only classification and Telegram rate limiting end-to-end.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const GAMMA = "https://gamma-api.polymarket.com";
const LIVE_PAGE = "https://polymarket.com/ru/sports/live";
const SOCCER_PAGE = "https://polymarket.com/ru/sports/soccer/games";
const POLL_MS = 5000;
const TELEGRAM_MAX = 3900;
const DIAGNOSTIC_MODE = false; // Production monitor: never stop after diagnostic cycles.
const RENDER_MODE = process.env.RENDER === "true" || process.env.RENDER === "1";
const RUN_MS = Number.POSITIVE_INFINITY;
const MAX_CYCLES = Number.POSITIVE_INFINITY;
const SPORTS_WS_TIMEOUT_MS = 12000;
const MAX_SPORTS_WS_LOOKUPS = Number.POSITIVE_INFINITY;
let stopping = false;

function startHealthServer(){
  const port=Number(process.env.PORT||3000);
  const server=http.createServer((req,res)=>{
    if(req.url==="/health"||req.url==="/"){
      res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
      res.end(JSON.stringify({ok:true,service:"polymarket-soccer-live-monitor",mode:RENDER_MODE?"render":"monitor",time:new Date().toISOString()}));
      return;
    }
    res.writeHead(404,{"content-type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({ok:false,error:"not_found"}));
  });
  server.listen(port,"0.0.0.0",()=>console.log(JSON.stringify({level:"INFO",event:"health_server_listening",port,health:"/health",render:RENDER_MODE})));
  server.on("error",err=>console.log(JSON.stringify({level:"ERROR",event:"health_server_error",message:err.message})));
  return server;
}

const healthServer=process.env.DEPLEXO_WRAPPER === "1" ? null : startHealthServer();

function t(v){return typeof v === "string" ? v.trim() : "";}
function norm(v){return t(v).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/&/g,"and").replace(/\b(fc|cf|sc|afc|ac|cd|club|football club)\b/g," ").replace(/[^a-z0-9]+/g," ").trim();}
function parse(v){if(typeof v!=="string")return v;try{return JSON.parse(v)}catch{return v}}
async function get(url,opts={}){const r=await fetch(url,{...opts,headers:{accept:"application/json,text/html,application/xhtml+xml",...(opts.headers||{})},signal:AbortSignal.timeout(opts.timeout||8000)});if(!r.ok)throw new Error("HTTP "+r.status+" "+url);return r;}
async function json(url,opts={}){return (await get(url,opts)).json();}
function decode(s){return t(s).replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#x27;/g,"'");}
function hrefs(html){const out=new Set();let m;const re=/href=["'](\/[^"'#? ]+)["']/gi;while((m=re.exec(html)))out.add(m[1]);return [...out];}
function slugFromHref(h){return t(h).split("/").filter(Boolean).pop()||"";}
function fixtureSlug(h){return slugFromHref(h).replace(/-(?:more-markets|player-props?|total-(?:corners|goals|cards|shots)|first-team-to-score|last-team-to-score|exact-score|half-time-result|half-time|second-half-result|second-half|1st-half-result|1st-half|2nd-half-result|2nd-half|match-result|draw-no-bet|double-chance|both-teams-to-score|btts|to-score|team-totals?|alternate-lines?|correct-score|winning-margin|clean-sheet|win-to-nil)(?:-.*)?$/i,"");}
function fixtureLinks(html){
  return hrefs(html).filter(h=>{
    const m=t(h).match(/^\/(?:ru\/)?sports\/([^/?#]+)\/([^/?#]+)(?:\/[^?#]*)?$/i);
    return !!m && !/^(?:games|live|futures)$/i.test(m[1]) && !/^(?:games|live|futures)$/i.test(m[2]);
  });
}
function isFixtureTitle(x){return /\s(?:vs\.?|v\.?|versus)\s/i.test(t(x))&&!/\s-\s(?:more markets|player props?|total|first team|last team|exact score|half|second half|match result|winner|moneyline)/i.test(t(x));}
function isKnownSoccerLeague(event){
  const values=[];
  for(const k of ["league","leagueSlug","league_slug","seriesSlug","series_slug","sport","sportSlug","sport_slug","category","subcategory"]){
    if(event?.[k]!=null)values.push(String(event[k]).toLowerCase());
  }
  const tags=Array.isArray(event?.tags)?event.tags:parse(event?.tags);
  if(Array.isArray(tags))for(const z of tags)values.push(String(z?.slug||z?.label||z?.name||z).toLowerCase());
  const joined=values.join(" ");
  return /soccer|football|premier league|epl|laliga|la liga|serie a|serie b|bundesliga|ligue 1|ligue 2|mls|nwsl|liga mx|brasileirao|brasileirão|j2 league|j1 league|eredivisie|primeira liga|concacaf|uefa|fifa|superliga|allsvenskan|eliteserien|süper lig|a league|a-league|women's|wsl|premiership|scottish|belgian|danish|greek|croatian|serbian|polish|czech|romanian|bulgarian|slovenian|slovak|hungarian|austrian|swiss|norwegian|sweden|finland|iceland|argentina|colombia|chile|peru|ecuador|uruguay|paraguay|bolivia|venezuela|costa rica|honduras|guatemala|jamaica|el salvador|martinique|nations league/.test(joined);
}

function isSoccerEvent(event,href=""){
  const h=t(href).toLowerCase();
  // Explicit sport paths are authoritative when they name the sport directly.
  // League paths such as /sports/es2/<fixture-slug> are not enough by themselves;
  // continue to Gamma fields/football-market signals so valid soccer leagues pass.
  const sportPath=h.match(/\/sports\/([^/?#]+)(?:\/|$)/i);
  if(sportPath){
    const sport=t(sportPath[1]).toLowerCase();
    if(sport==="soccer" || sport==="football")return true;
    if(/^(?:tennis|wta|atp|basketball|baseball|hockey|nfl|cfb|ufc|cricket)$/i.test(sport))return false;
  }
  const values=[];
  for(const k of ["sport","sports","category","subcategory","league","sportSlug","sport_slug","tagSlug","tag_slug","seriesSlug","series_slug","eventType","event_type","gameType","game_type"])values.push(event?.[k]);
  const tags=Array.isArray(event?.tags)?event.tags:parse(event?.tags);
  if(Array.isArray(tags))for(const z of tags)values.push(typeof z==="string"?z:(z?.slug||z?.label||z?.name));
  const explicit=values.filter(Boolean).map(v=>String(v).toLowerCase());
  if(explicit.some(v=>/soccer|football/.test(v)))return true;
  if(explicit.some(v=>/tennis|wta|atp|basketball|baseball|hockey|nfl|cfb|ufc|cricket/.test(v)))return false;
  const slug=t(event?.slug||event?.eventSlug||event?.event_slug).toLowerCase();
  if(/(^|[-_])(?:soccer|football)([-_]|$)/.test(slug))return true;
  if(/(^|[-_])(?:tennis|wta|atp|basketball|baseball|hockey|nfl|cfb|ufc|cricket)([-_]|$)/.test(slug))return false;
  // Last-resort Gamma classification: require multiple football-specific market
  // signals, not merely "draw" or a generic match-result market.
  const title=t(event?.title||event?.question);
  if(!/\s(?:vs\.?|v\.?|versus)\s/i.test(title))return false;
  const markets=Array.isArray(event?.markets)?event.markets:[];
  const text=markets.map(m=>t(m?.question||m?.title||m?.groupItemTitle)).join(" ").toLowerCase();
  return /both teams to score|\bbtts\b|total corners|correct score|win to nil|double chance|draw no bet/.test(text);
}
function teams(event){const title=t(event.title||event.question);if(event.homeTeam&&event.awayTeam)return[t(event.homeTeam),t(event.awayTeam)];const m=title.match(/^(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+)$/i);return m?[m[1].trim(),m[2].trim()]:["",""];}

async function fetchPage(url){
  const r=await get(url,{headers:{accept:"text/html,application/xhtml+xml","user-agent":"Mozilla/5.0 (compatible; PolymarketLiveSoccerMonitor/1.0)"},timeout:8000});
  return r.text();
}

function gameTeams(g){
  const sources=[g,g?.game,g?.match,g?.result,g?.data].filter(x=>x&&typeof x==="object");
  let home="",away="";
  for(const x of sources){
    if(!home)home=t(x.homeTeam?.name||x.homeTeam?.teamName||x.homeTeam?.title||x.home_team?.name||x.home_team?.teamName||x.home_team?.title||x.home?.name||x.home?.teamName||x.home?.title||x.homeTeam||x.home_team||x.homeTeamName||x.home_team_name);
    if(!away)away=t(x.awayTeam?.name||x.awayTeam?.teamName||x.awayTeam?.title||x.away_team?.name||x.away_team?.teamName||x.away_team?.title||x.away?.name||x.away?.teamName||x.away?.title||x.awayTeam||x.away_team||x.awayTeamName||x.away_team_name);
  }
  return [home,away];
}
function wsSoccerConfirmed(sg){
  const league=[sg?.league,sg?.sport,sg?.leagueAbbreviation,sg?.sportSlug].map(t).join(" ").toLowerCase();
  if(/soccer|football|epl|premier|laliga|la liga|serie a|bundesliga|ligue 1|mls|fifa|uefa/.test(league))return true;
  if(/^(nba|wnba|nfl|nhl|mlb|ncaa|cfb|ncaab|atp|wta|ufc|mma|cricket|cs2|dota|valorant|lol)$/i.test(t(sg?.leagueAbbreviation)))return false;
  const period=t(sg?.period).toUpperCase();
  const elapsed=t(sg?.elapsed);
  return /^(?:1H|2H|HT)$/.test(period) || /^\d{1,3}:\d{2}$/.test(elapsed);
}
function gameLive(g){
  const status=t(g.status||g.gameStatus||g.liveStatus||g.state||g.phase||g.period).toLowerCase();
  return /live|in.?play|playing|1h|2h|halftime|half time|extra|stoppage/.test(status) || g.live===true || g.isLive===true || g.inPlay===true;
}
function gameScore(g){
  const sources=[g,g?.game,g?.match,g?.result,g?.data].filter(x=>x&&typeof x==="object");
  for(const x of sources){
    const h=x.homeScore??x.home_score??x.score?.home??x.score?.homeScore??x.scores?.home??x.scores?.homeScore??x.home?.score??x.home?.score?.current??x.homeTeam?.score??x.homeTeam?.score?.current??x.homeTeam?.score?.value??x.scoreboard?.home?.score??x.scoreboard?.homeScore;
    const aw=x.awayScore??x.away_score??x.score?.away??x.score?.awayScore??x.scores?.away??x.scores?.awayScore??x.away?.score??x.away?.score?.current??x.awayTeam?.score??x.awayTeam?.score?.current??x.awayTeam?.score?.value??x.scoreboard?.away?.score??x.scoreboard?.awayScore;
    if(h!=null&&aw!=null)return[h,aw];
    const raw=t(x.score||x.scoreboard||x.currentScore||x.resultScore);
    const m=raw.match(/^(\d+)\s*[-–:]\s*(\d+)/);
    if(m)return[Number(m[1]),Number(m[2])];
  }
  return null;
}
function gameMinute(g){
  const sources=[g,g?.game,g?.match,g?.result,g?.data].filter(x=>x&&typeof x==="object");
  for(const x of sources){
    const raw=x?.minute??x?.matchMinute??x?.elapsed??x?.clock?.minute??x?.periodTime??x?.matchClock??x?.liveClock??x?.elapsedTime??x?.matchClockMinutes;
    if(typeof raw==="number"&&Number.isFinite(raw)&&raw>=0&&raw<=130)return Math.floor(raw)+"'";
    const str=t(raw);
    const m=str.match(/^(\d{1,3})(?:[:.]\d{1,2})?(?:\s*min)?(?:ute)?(?:[′']|$)/i);
    if(m){const n=Number(m[1]);if(n>=0&&n<=130)return n+"'";}
  }
  return "";
}
function pageGameSnapshot(){ return null; }
function attachGame(x,g){
  x.game=g;
  const sc=gameScore(g);
  if(validScore(sc)){
    x.score=orientGame(x,g)==="reversed"?[Number(sc[1]),Number(sc[0])]:[Number(sc[0]),Number(sc[1])];
  }
  const minute=gameMinute(g);
  if(validMinute(minute))x.minute=minute;
  x.gameStatus=t(g.status||g.gameStatus||g.liveStatus||g.state||g.phase||g.period);
}
async function fetchLiveSports(){
  return await new Promise((resolve)=>{
    const live=[];
    const seen=new Set();
    let ws;
    let timer;
    try{
      ws=new WebSocket("wss://sports-api.polymarket.com/ws");
      const finish=()=>{
        if(timer){clearTimeout(timer);timer=null;}
        try{ws.close()}catch{}
        resolve(live);
      };
      timer=setTimeout(finish,SPORTS_WS_TIMEOUT_MS);
      ws.onopen=()=>{
        console.log(JSON.stringify({level:"INFO",event:"sports_ws_open"}));
        // The Sports WS sends ping frames/messages every few seconds. Keep the
        // connection alive long enough to receive the initial sport_result batch.
        clearTimeout(timer);
        timer=setTimeout(finish,SPORTS_WS_TIMEOUT_MS);
      };
      ws.onerror=(e)=>console.log(JSON.stringify({level:"WARN",event:"sports_ws_error",message:String(e?.message||"websocket error")}));
      ws.onclose=(e)=>{console.log(JSON.stringify({level:"INFO",event:"sports_ws_close",code:e?.code??null}));clearTimeout(timer);resolve(live)};
      ws.onmessage=(ev)=>{
        const raw=typeof ev.data==="string"?ev.data:"";
        if(raw==="ping"){
          try{ws.send("pong")}catch{}
          clearTimeout(timer);
          timer=setTimeout(finish,SPORTS_WS_TIMEOUT_MS);
          return;
        }
        clearTimeout(timer);
        timer=setTimeout(finish,SPORTS_WS_TIMEOUT_MS);
        let m; try{m=JSON.parse(raw)}catch{return;}
        const type=t(m?.type||m?.event_type);
        const p0=m?.payload&&typeof m.payload==="object"&&!Array.isArray(m.payload)?m.payload:m;
        const p={...m,...p0};
        const league=t(p?.leagueAbbreviation||p?.league||p?.sport||p?.sportSlug).toLowerCase();
        const status=t(p?.status||p?.gameStatus||p?.state).toLowerCase();
        const period=t(p?.period).toUpperCase();
        const elapsed=t(p?.elapsed);
        const liveFlag=p?.live===true||p?.isLive===true||/inprogress|in.?play|playing|break|halftime|penaltyshootout|live/.test(status)||
          /^(?:1H|2H|HT)$/.test(period)||/^\d{1,3}:\d{2}$/.test(elapsed)||type==="sport_result";
        // Do not require league/period fields to classify a sport_result.
        // The Gamma event + fixture matching below performs the soccer gate.
        if(type&&type!=="sport_result"&&!liveFlag)return;
        if(p?.ended===true||/final|finished|cancel|postponed|awarded/.test(status))return;
        if(!liveFlag)return;
        if(live.length<3) console.log(JSON.stringify({level:"DEBUG",event:"sports_ws_payload",type,league,status,keys:Object.keys(p||{}),gameId:p?.gameId||p?.id||null,slug:p?.slug||null,home:p?.homeTeam||p?.home_team||p?.home||null,away:p?.awayTeam||p?.away_team||p?.away||null,score:p?.score||p?.scores||p?.scoreboard||null,period:p?.period||null,elapsed:p?.elapsed||null,live:p?.live??null,isLive:p?.isLive??null}));
        const gameId=t(p?.gameId||p?.id);
        const slug=t(p?.slug);
        const home=t(p?.homeTeam||p?.home_team||p?.home);
        const away=t(p?.awayTeam||p?.away_team||p?.away);
        if(!gameId&&!slug||!home||!away)return;
        const key=gameId||slug;
        let score=null;
        const s=p?.score??p?.scores??p?.scoreboard;
        if(typeof s==="string"){
          const mm=s.match(/^(\d+)\s*[-–:]\s*(\d+)/); if(mm)score=[Number(mm[1]),Number(mm[2])];
        } else if(s&&typeof s==="object"){
          const h=s.home??s.homeScore??s.home_score, a=s.away??s.awayScore??s.away_score;
          if(h!=null&&a!=null)score=[h,a];
        }
        const minute=gameMinute(p);
        const existing=live.find(x=>(x.gameId&&gameId&&x.gameId===gameId)||(x.slug&&slug&&x.slug===slug));
        if(existing){
          existing.status=p?.status||existing.status||"InProgress";
          existing.period=t(p?.period)||existing.period;
          existing.elapsed=t(p?.elapsed)||existing.elapsed;
          if(score)existing.score=score;
          if(minute)existing.minute=minute;
        }else{
          live.push({gameId,slug,home,away,status:p?.status||"InProgress",period:t(p?.period),elapsed:t(p?.elapsed),minute,score});
        }
      };
    }catch(e){
      clearTimeout(timer); console.log(JSON.stringify({level:"WARN",event:"sports_ws_init_failed",message:e.message}));resolve(live);
    }
  });
}

async function fetchLiveEvents(){
  const all=[];
  const seenRaw=new Set();
  async function load(url){
    try{
      const raw=await json(url,{timeout:8000});
      const batch=Array.isArray(raw)?raw:(raw?.events||raw?.data||[]);
      if(Array.isArray(batch))all.push(...batch);
      return batch.length;
    }catch(e){
      console.log(JSON.stringify({level:"WARN",event:"events_load_failed",url,message:e.message}));
      return 0;
    }
  }

  // Gamma exposes a dedicated live filter. Use it as the authoritative
  // discovery gate instead of inferring LIVE from startDate/status fields.
  await load(GAMMA+"/events?live=true&active=true&closed=false&limit=500");
  if(all.length===0){
    for(let offset=0;offset<2000;offset+=500){
      const n=await load(GAMMA+"/events?active=true&closed=false&limit=500&offset="+offset);
      if(n<500)break;
    }
  }

  const live=[];
  for(const e of all){
    const id=t(e.id||e.slug);
    if(!id||seenRaw.has(id))continue;
    const fixture=teams(e);
    if(!isSoccerEvent(e,"")&&!isKnownSoccerLeague(e)&&!(fixture[0]&&fixture[1]))continue;
    seenRaw.add(id);
    if(e.ended===true||e.finished===true||e.final===true)continue;
    const [home,away]=teams(e);
    if(!home||!away)continue;
    live.push({
      id:t(e.id),gameId:t(e.gameId||e.game_id),
      slug:t(e.slug),homeTeam:home,awayTeam:away,
      status:t(e.status||e.gameStatus||e.liveStatus||"LIVE"),
      live:true,event:e
    });
  }
  console.log(JSON.stringify({level:"INFO",event:"gamma_live_events_scan",activeEvents:all.length,soccerLiveEvents:live.length}));
  return live;
}
function liveHrefForTeams(home,away,links){
  const nh=norm(home), na=norm(away);
  if(!nh||!na)return "";
  for(const href of links||[]){
    const slug=fixtureSlug(href);
    if(!slug)continue;
    const parts=slug.replace(/^.*\//,"").split("-");
    const joined=norm(slug);
    if(joined.includes(nh)&&joined.includes(na))return href;
  }
  return "";
}

function matchGame(x,g){
  const [gh,ga]=gameTeams(g), nx=norm(x.home),ny=norm(x.away),nh=norm(gh),na=norm(ga);
  return (gh&&ga&&((nh===nx&&na===ny)||(nh===ny&&na===nx))) || t(g.eventId||g.event_id)===x.eventId || t(g.eventSlug||g.event_slug||g.slug)===x.slug;
}
function orientGame(x,g){
  const [gh,ga]=gameTeams(g);
  return norm(gh)===norm(x.away)&&norm(ga)===norm(x.home)?"reversed":"direct";
}
function validScore(score){
  return Array.isArray(score)&&score.length===2&&score.every(v=>Number.isInteger(Number(v))&&Number(v)>=0&&Number(v)<=99);
}
function validMinute(minute){
  return /^\d{1,3}'$/.test(t(minute))&&Number(t(minute).slice(0,-1))>=0&&Number(t(minute).slice(0,-1))<=130;
}

function eventLiveWindow(event){
  const now=Date.now();
  if(event.ended===true||event.finished===true||event.final===true)return false;

  // The Polymarket live page can mark a fixture "live" before kickoff.
  // Never trust that flag to override the actual fixture start time.
  const start=Date.parse(event.gameStartTime||event.game_start_time||event.startTime||event.start_time||event.eventStartTime||event.event_start_time||"");
  const end=Date.parse(event.gameEndTime||event.game_end_time||event.matchEndTime||event.match_end_time||"");

  // If an authoritative kickoff timestamp exists, it is a hard lower bound.
  // This prevents stale WS minute/score data (e.g. 53') from leaking into
  // a match that has not actually started yet.
  if(Number.isFinite(start)&&start>now)return false;
  if(Number.isFinite(end)&&end<now)return false;

  const status=t(event.status||event.gameStatus||event.liveStatus||event.period||event.phase).toLowerCase();
  const explicitLive=event.live===true||event.isLive===true||event.inPlay===true||/live|in.?play|playing|1h|2h|halftime|half time|extra|stoppage/.test(status);
  if(explicitLive)return true;

  // Without a kickoff timestamp we refuse to infer LIVE from market lifecycle.
  return Number.isFinite(start)&&start<=now;
}

async function discover(){
  const [liveHtml,soccerHtml,liveEvents]=await Promise.all([fetchPage(LIVE_PAGE),fetchPage(SOCCER_PAGE),fetchLiveEvents()]);
  const liveLinks=fixtureLinks(liveHtml);
  const soccerLinks=fixtureLinks(soccerHtml);
  const sportsLive=await fetchLiveSports();
  console.log(JSON.stringify({level:"INFO",event:"DISCOVERY_RAW_SOURCES",livePageLinks:liveLinks.length,soccerPageLinks:soccerLinks.length,gammaLiveEvents:liveEvents.length,sportsWsGames:sportsLive.length}));
  console.log(JSON.stringify({level:"INFO",event:"sports_ws_snapshot",count:sportsLive.length,matches:sportsLive.map(x=>({gameId:x.gameId,slug:x.slug,teams:[x.home,x.away],status:x.status,period:x.period,elapsed:x.elapsed,score:x.score}))}));
  console.log(JSON.stringify({level:"INFO",event:"source_scan",liveHtmlBytes:liveHtml.length,soccerHtmlBytes:soccerHtml.length,liveLinks:liveLinks.length,soccerLinks:soccerLinks.length,liveSample:liveLinks.slice(0,5),soccerSample:soccerLinks.slice(0,5),liveEvents:liveEvents.length}));
  const soccerHrefs=new Set(soccerLinks);
  const soccerSlugs=new Set(soccerLinks.map(fixtureSlug).filter(Boolean));
  const candidates=[],seen=new Set();

  async function addEvent(event,href,liveConfirmed=false,sourceConfirmed=false){
    const rawTitle=t(event?.title||event?.question);
    if(!event||!event.id){console.log(JSON.stringify({level:"DEBUG",event:"candidate_reject",reason:"missing_event_id",href}));return;}
    const [home,away]=teams(event);
    if(!sourceConfirmed&&!isSoccerEvent(event,href)){console.log(JSON.stringify({level:"DEBUG",event:"candidate_reject",reason:"not_soccer",eventId:event.id,title:rawTitle,href}));return;}
    const ended=event.ended===true||event.finished===true||event.final===true;
    if(!home||!away){console.log(JSON.stringify({level:"DEBUG",event:"candidate_reject",reason:"teams_not_parsed",eventId:event.id,title:rawTitle}));return;}
    if(!isFixtureTitle(rawTitle)&&!(event.homeTeam&&event.awayTeam)){console.log(JSON.stringify({level:"DEBUG",event:"candidate_reject",reason:"not_fixture_title",eventId:event.id,title:rawTitle}));return;}
    // LIVE confirmation never overrides a future kickoff timestamp.
    // This blocks stale Sports WS/Gamma data from creating prematch alerts.
    if(!eventLiveWindow(event)){console.log(JSON.stringify({level:"DEBUG",event:"candidate_reject",reason:"not_live_window",eventId:event.id,title:rawTitle,start:event.startDate,end:event.endDate,status:event.status,liveConfirmed}));return;}
    if(ended){console.log(JSON.stringify({level:"DEBUG",event:"candidate_reject",reason:"ended",eventId:event.id,title:rawTitle}));return;}
    const slug=t(event.slug)||fixtureSlug(href||"");
    if(!slug||seen.has(slug)){console.log(JSON.stringify({level:"DEBUG",event:"candidate_reject",reason:"missing_or_duplicate_slug",eventId:event.id,title:rawTitle,slug}));return;}
    seen.add(slug);
    const item={eventId:t(event.id),slug,url:href?("https://polymarket.com"+href):("https://polymarket.com/event/"+slug),home,away,event};
    const game=liveEvents.find(g=>matchGame(item,g));
    const wsGame=sportsLive.find(g=>matchGame(item,g));
    if(game)attachGame(item,game);
    else if(wsGame)attachGame(item,wsGame);
    else {
      item.gameStatus=t(event.gameStatus||event.status||"LIVE")||"LIVE";
      const sc=gameScore(event); if(sc)item.score=sc;
      item.minute=gameMinute(event);
    }
    candidates.push(item);
    console.log(JSON.stringify({level:"INFO",event:"LIVE_CANDIDATE",slug:item.slug,eventId:item.eventId,teams:[item.home,item.away],status:item.gameStatus,minute:item.minute??null,score:item.score??null,source:sourceConfirmed?"sports_ws":"page_or_gamma"}));
  }

  // Primary live source: Polymarket Sports WebSocket. It provides actual kickoff/status/score.
  const sportsLookupList=sportsLive.slice(0,MAX_SPORTS_WS_LOOKUPS);
  if(sportsLive.length>sportsLookupList.length)console.log(JSON.stringify({level:"WARN",event:"sports_ws_lookup_capped",total:sportsLive.length,processed:sportsLookupList.length,diagnostic:DIAGNOSTIC_MODE}));
  for(const sg of sportsLookupList){
    try{
      let raw;
      if(sg.slug){
        try{ raw=await json(GAMMA+"/events?slug="+encodeURIComponent(sg.slug),{timeout:5000}); }
        catch{}
      }
      if(!raw && sg.gameId){
        try{ raw=await json(GAMMA+"/events?game_id="+encodeURIComponent(sg.gameId),{timeout:5000}); }
        catch{}
      }
      const event=Array.isArray(raw)?raw[0]:raw;
      if(event){
        console.log(JSON.stringify({level:"INFO",event:"GAMMA_MATCH_FOUND",gameId:sg.gameId,slug:sg.slug,eventId:event?.id,title:event?.title||event?.question}));
        await addEvent(event,null,true,false);
        const item=candidates.find(x=>x.eventId===t(event.id)||x.slug===t(event.slug));
        if(item){
          item.gameStatus=sg.status||"InProgress";
          if(validMinute(sg.minute)) item.minute=sg.minute;
          if(sg.score)item.score=sg.score;
          item.sportsGame=sg;
        }
      } else {
        // WS slugs/gameIds are not always Gamma event identifiers. When direct
        // Gamma lookup fails, resolve the authoritative LIVE-page fixture by
        // the WS team names before giving up.
        const liveHref=liveHrefForTeams(sg.home,sg.away,liveLinks);
        if(liveHref){
          const liveSlug=fixtureSlug(liveHref);
          try{
            const rr=await json(GAMMA+"/events?slug="+encodeURIComponent(liveSlug),{timeout:5000});
            const liveEvent=Array.isArray(rr)?rr[0]:rr;
            if(liveEvent){
              console.log(JSON.stringify({level:"INFO",event:"GAMMA_MATCH_FOUND_FROM_WS_TEAMS",gameId:sg.gameId,wsSlug:sg.slug,liveHref,liveSlug,eventId:liveEvent.id,title:liveEvent.title||liveEvent.question}));
              await addEvent(liveEvent,liveHref,true,false);
              const item=candidates.find(x=>x.eventId===t(liveEvent.id)||x.slug===t(liveEvent.slug));
              if(item){item.gameStatus=sg.status||"InProgress";if(validMinute(sg.minute))item.minute=sg.minute;if(validScore(sg.score))item.score=sg.score;item.sportsGame=sg;}
            }
          }catch(e){console.log(JSON.stringify({level:"WARN",event:"sports_ws_team_fixture_lookup_failed",gameId:sg.gameId,liveHref,message:e.message}));}
        }
        if(candidates.some(x=>x.eventId===t(event?.id)||x.slug===t(event?.slug)))continue;
        if(sg.gameId){
        try{
          const ms=await json(GAMMA+"/markets?game_id="+encodeURIComponent(sg.gameId)+"&active=true&closed=false&limit=100",{timeout:5000});
          const markets=Array.isArray(ms)?ms:(ms?.data||[]);
          const eventId=t(markets[0]?.eventId||markets[0]?.event_id);
          if(eventId){
            const er=await json(GAMMA+"/events/"+encodeURIComponent(eventId),{timeout:5000});
            const event2=er?.event||er;
            if(event2){
              console.log(JSON.stringify({level:"INFO",event:"GAMMA_MATCH_FOUND_BY_GAME_ID",gameId:sg.gameId,eventId:eventId,title:event2?.title||event2?.question,markets:markets.length}));
              await addEvent(event2,null,true,false);
              const item=candidates.find(x=>x.eventId===eventId||x.slug===t(event2.slug));
              if(item){item.gameStatus=sg.status||"InProgress";if(validMinute(sg.minute))item.minute=sg.minute;if(validScore(sg.score))item.score=sg.score;item.sportsGame=sg;}
            }
          }
        }catch(e){console.log(JSON.stringify({level:"WARN",event:"sports_ws_game_id_lookup_failed",gameId:sg.gameId,message:e.message}));}
        if(!candidates.some(x=>x.eventId===t(event?.id)||x.slug===t(event?.slug))) console.log(JSON.stringify({level:"WARN",event:"sports_ws_event_lookup_failed",gameId:sg.gameId,slug:sg.slug,teams:[sg.home,sg.away]}));
      } else {
        console.log(JSON.stringify({level:"WARN",event:"sports_ws_event_lookup_failed",gameId:sg.gameId,slug:sg.slug,teams:[sg.home,sg.away]}));
      }
    }catch(e){
      console.log(JSON.stringify({level:"WARN",event:"sports_ws_candidate_failed",gameId:sg.gameId,slug:sg.slug,message:e.message}));
    }
  }

  // Secondary authoritative source: active Gamma /events. Keep this bounded so a
  // slow/stale Gamma list can never delay the live-page candidates past a diagnostic run.
  const secondaryLiveEvents=liveEvents.slice(0,DIAGNOSTIC_MODE?8:20);
  console.log(JSON.stringify({level:"INFO",event:"secondary_live_event_scan",total:liveEvents.length,processed:secondaryLiveEvents.length,diagnostic:DIAGNOSTIC_MODE}));
  for(const g of secondaryLiveEvents){
    try{
      const gameSlug=t(g.slug||g.eventSlug||g.event_slug);
      const gameId=t(g.gameId||g.game_id||g.id);
      let raw=null;
      if(gameSlug){ try{ raw=await json(GAMMA+"/events?slug="+encodeURIComponent(gameSlug),{timeout:5000}); }catch{} }
      if(!raw && gameId){ try{ raw=await json(GAMMA+"/events?game_id="+encodeURIComponent(gameId),{timeout:5000}); }catch{} }
      const event=Array.isArray(raw)?raw[0]:raw;
      if(event){
        await addEvent(event,null,true,true);
        const item=candidates.find(x=>x.eventId===t(event.id)||x.slug===t(event.slug));
        if(item)attachGame(item,g);
        console.log(JSON.stringify({level:"INFO",event:"GAMMA_MATCH_FOUND_FROM_LIVE_EVENT",gameId:gameId,slug:gameSlug,eventId:event.id,title:event.title||event.question}));
      } else {
        console.log(JSON.stringify({level:"WARN",event:"LIVE_EVENT_LOOKUP_FAILED",gameId:gameId,slug:gameSlug,teams:gameTeams(g)}));
      }
    }catch(e){
      console.log(JSON.stringify({level:"WARN",event:"live_event_candidate_failed",gameId:t(g.gameId||g.game_id||g.id),message:e.message}));
    }
  }

  // The Polymarket /sports/live page is an explicit LIVE-only surface.
  // Use its soccer fixture links as a LIVE gate when Sports WS/Gamma live feeds
  // are unavailable. Gamma is still used only to resolve the actual event/markets.
  let pageLiveResolved = 0;
  const pageLinks=liveLinks.slice(0,DIAGNOSTIC_MODE?20:50);
  for(const href of pageLinks){
    if(candidates.length >= 50)break;
    const slug=fixtureSlug(href);
    if(!slug)continue;
    try{
      let raw=null;
      try{ raw=await json(GAMMA+"/events?slug="+encodeURIComponent(slug),{timeout:5000}); }catch{}
      const event=Array.isArray(raw)?raw[0]:raw;
      if(!event){
        console.log(JSON.stringify({level:"WARN",event:"live_page_event_lookup_failed",href,slug}));
        continue;
      }
      const before=candidates.length;
      await addEvent(event,href,true,false);
      const pageItem=candidates.find(x=>x.slug===slug||x.eventId===t(event.id));
      if(candidates.length>before){
        pageLiveResolved++;
        console.log(JSON.stringify({level:"INFO",event:"LIVE_PAGE_CANDIDATE",href,slug,eventId:event.id,title:event.title||event.question}));
      }
    }catch(e){
      console.log(JSON.stringify({level:"WARN",event:"live_page_candidate_failed",href,slug,message:e.message}));
    }
  }
  console.log(JSON.stringify({level:"INFO",event:"live_page_used_as_live_gate",links:liveLinks.length,processed:pageLinks.length,resolved:pageLiveResolved}));

  // Gamma soccer events without an authoritative live flag are diagnostics only.
  // They must never become LIVE candidates: this prevents prematch/future alerts.
  if(candidates.length===0){
    try{
      const raw=await json(GAMMA+"/events?active=true&closed=false&limit=500",{timeout:8000});
      const events=(Array.isArray(raw)?raw:(raw?.events||raw?.data||[])).filter(e=>isSoccerEvent(e,""));
      console.log(JSON.stringify({level:"INFO",event:"gamma_soccer_fallback_scan",events:events.length,liveCandidatesAdded:0,diagnostic:"Gamma-only events are not eligible for LIVE alerts without Sports WS or live game confirmation."}));
    }catch(e){console.log(JSON.stringify({level:"WARN",event:"gamma_soccer_fallback_failed",message:e.message}));}
  }

  console.log(JSON.stringify({level:"INFO",event:"discovery",liveLinks:liveLinks.length,soccerLinks:soccerLinks.length,soccerIntersection:candidates.length,matches:candidates.map(x=>({slug:x.slug,home:x.home,away:x.away,minute:x.minute,score:x.score,status:x.gameStatus,hasGame:!!x.game,source:x.game?"gamma_games":"gamma_event"}))}));
  console.log(JSON.stringify({level:"INFO",event:"ALERT_PIPELINE_READY",candidates:candidates.length,telegramConfigured:!!process.env.TELEGRAM_BOT_TOKEN&&!!process.env.TELEGRAM_CHAT_ID}));
  if(candidates.length>0)console.log(JSON.stringify({level:"INFO",event:"LIVE_CANDIDATES_READY",count:candidates.length,matches:candidates.map(x=>({slug:x.slug,teams:[x.home,x.away],status:x.gameStatus,minute:x.minute??null,score:x.score??null}))}));
  if(candidates.length===0){
    console.log(JSON.stringify({level:"ERROR",event:"NO_LIVE_CANDIDATES",diagnostic:"No soccer candidate survived discovery. Check gamma_active_events_scan, sports_ws_snapshot and candidate_reject records above."}));
  }
  return candidates;
}
function marketRows(event){
  return (Array.isArray(event.markets)?event.markets:[]).filter(m=>m&&m.active!==false&&m.closed!==true).map(m=>{
    const outcomes=parse(m.outcomes),prices=parse(m.outcomePrices||m.outcome_prices);
    if(!Array.isArray(outcomes))return null;
    const tokenOutcomes=Array.isArray(m.tokens)?m.tokens.map(z=>t(z.outcome||z.name||z.title)):[];
    const tokenPrices=Array.isArray(m.tokens)?m.tokens.map(z=>Number(z.price??z.outcomePrice)):[];
    const normalizedOutcomes=(outcomes.length?outcomes:tokenOutcomes).map(t);
    const ps=(Array.isArray(prices)&&prices.length?prices:tokenPrices).map(Number);
    const volume=Number(m.volumeNum??m.volume??m.volume24hr??0);
    const liquidity=Number(m.liquidityNum??m.liquidity??0);
    return{
      id:t(m.id||m.conditionId||m.condition_id),
      slug:t(m.slug||m.marketSlug||m.market_slug),
      question:t(m.question||m.title||m.groupItemTitle||m.groupItemTitle),
      group:t(m.groupItemTitle||m.groupItemTitle||""),
      outcomes:normalizedOutcomes,
      prices:ps,
      volume:Number.isFinite(volume)?volume:0,
      liquidity:Number.isFinite(liquidity)?liquidity:0
    };
  }).filter(Boolean);
}
function pct(v){const n=Number(v);return Number.isFinite(n)?(n*100).toFixed(1).replace(/\\.0$/,"")+"%":"—";}
function money(v){const n=Number(v);return Number.isFinite(n)?"$"+n.toLocaleString("en-US",{maximumFractionDigits:0}):"—";}
function marketText(r){
  const title=(r.question||r.group||"Market")
    .replace(/^Will\s+/i,"")
    .replace(/\s+on\s+\d{4}-\d{2}-\d{2}\??$/i,"")
    .replace(/\s+end\s+in\s+a\s+draw\??$/i," — Draw");
  const vals=r.outcomes.map((o,i)=>{
    const p=Number.isFinite(r.prices[i])?pct(r.prices[i]):"—";
    return o+": "+p;
  }).join("\n");
  return title+"\n"+vals+"\nVOL: "+money(r.volume)+"\nLIQ: "+money(r.liquidity);
}
function splitPages(header,rows,maxLen=TELEGRAM_MAX){
  const pages=[];let current=header;
  for(const row of rows){
    const block=marketText(row);
    if(current.length+2+block.length>maxLen&&current!==header){pages.push(current);current=header+"\n\n"+block;}
    else current+="\n\n"+block;
  }
  if(current!==header||pages.length===0)pages.push(current);
  return pages;
}
function buildAlertPages(x){
  const e=x.event,rows=marketRows(e);
  const sh=x.score?.[0]??e.homeScore??e.home_score??e.score?.home??null;
  const sa=x.score?.[1]??e.awayScore??e.away_score??e.score?.away??null;
  const status=x.gameStatus||t(e.status||e.gameStatus||e.liveStatus||"LIVE");
  const start=t(e.gameStartTime||e.game_start_time||e.startTime||e.start_time);
  const eventVolume=Number(e.volumeNum??e.volume??e.volume24hr??0);
  const eventLiquidity=Number(e.liquidityNum??e.liquidity??0);
  const totalVolume=rows.reduce((a,r)=>a+r.volume,0);
  const totalLiquidity=rows.reduce((a,r)=>a+r.liquidity,0);
  const header=["⚽ LIVE FOUND","",x.home+" vs "+x.away,
    "STATUS: "+(status||"LIVE"),
    "START: "+(start||"—"),
    "MINUTE: "+(x.minute||"—"),
    "SCORE: "+(sh!=null&&sa!=null?sh+"–"+sa:"—"),
    "EVENT VOLUME: "+money(eventVolume||totalVolume),
    "EVENT LIQUIDITY: "+money(eventLiquidity||totalLiquidity),
    "",
    "ALL ACTIVE MARKETS ("+rows.length+")"].join("\n");
  return splitPages(header,rows);
}
let telegramNextAt=0;
async function sendTelegram(message,replyMarkup=null){
  const token=process.env.TELEGRAM_BOT_TOKEN||"",chat=process.env.TELEGRAM_CHAT_ID||"";
  const wait=Math.max(0,telegramNextAt-Date.now());
  if(wait>0)await new Promise(r=>setTimeout(r,wait));
  if(!token||!chat)throw new Error("Telegram credentials are missing");
  for(let attempt=1;attempt<=4;attempt++){
    const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({chat_id:chat,text:message,disable_web_page_preview:false,...(replyMarkup?{reply_markup:replyMarkup}:{})}),
      signal:AbortSignal.timeout(10000)
    });
    const b=await r.json().catch(()=>({}));
    if(r.ok&&b.ok){telegramNextAt=Date.now()+5000;return b;}
    if(r.status===429){
      const retry=Number(b?.parameters?.retry_after);
      const delay=(Number.isFinite(retry)&&retry>0?retry:5)+1;
      telegramNextAt=Date.now()+delay*1000;
      console.log(JSON.stringify({level:"WARN",event:"telegram_rate_limited",attempt,retryAfter:delay}));
      await new Promise(r=>setTimeout(r,delay*1000));
      continue;
    }
    throw new Error("Telegram HTTP "+r.status+(b?.description?": "+b.description:""));
  }
  throw new Error("Telegram rate limit persisted after retries");
}

const DEDUPE_DIR = process.env.DEDUPE_DIR || "/data";
const DEDUPE_FILE = path.join(DEDUPE_DIR, "polymarket-soccer-alerts.json");

function loadDedupe(){
  try{
    const raw=fs.readFileSync(DEDUPE_FILE,"utf8");
    const parsed=JSON.parse(raw);
    return new Set(Array.isArray(parsed)?parsed.filter(v=>typeof v==="string"):[]);
  }catch{return new Set();}
}
function saveDedupe(set){
  fs.mkdirSync(DEDUPE_DIR,{recursive:true});
  const tmp=DEDUPE_FILE+".tmp";
  fs.writeFileSync(tmp,JSON.stringify([...set]),"utf8");
  fs.renameSync(tmp,DEDUPE_FILE);
}
const persistentAlerted=loadDedupe();

// Persistent dedupe: the exact Polymarket event URL is the identity.
// The file lives on Deplexo's persistent /data volume and survives restarts.
async function claimFootballMatch(eventUrl){
  const key=t(eventUrl).replace(/\\/$/,"");
  if(!key)return false;
  if(persistentAlerted.has(key))return false;
  persistentAlerted.add(key);
  saveDedupe(persistentAlerted);
  return true;
}

async function releaseFootballMatch(eventUrl){
  const key=t(eventUrl).replace(/\\/$/,"");
  if(!key)return;
  persistentAlerted.delete(key);
  saveDedupe(persistentAlerted);
}

const alerted=new Set();
const alerting=new Set();
async function refreshEvent(x){
  let fresh=null;
  try{
    fresh=await json(GAMMA+"/events?slug="+encodeURIComponent(x.slug),{timeout:5000});
    fresh=Array.isArray(fresh)?fresh[0]:fresh;
  }catch{}
  if(!fresh){
    try{
      const byId=await json(GAMMA+"/events/"+encodeURIComponent(x.eventId),{timeout:5000});
      fresh=byId?.event||byId;
    }catch{}
  }
  if(fresh)x.event=fresh;
  if(!x.event)return null;

  // Never query /markets globally here: some Gamma deployments ignore event_id
  // and can return unrelated markets. Use only markets embedded in this event,
  // then keep soccer match-result / 1X2 markets.
  const embedded=Array.isArray(x.event.markets)?x.event.markets:[];
  const relevant=embedded.filter(m=>m&&m.active!==false&&m.closed!==true);
  x.event.markets=relevant;
  console.log(JSON.stringify({
    level:"INFO",event:"MARKETS_FILTERED",eventId:x.eventId,slug:x.slug,
    embeddedMarkets:embedded.length,relevantMarkets:relevant.length,
    questions:relevant.slice(0,10).map(m=>t(m?.question||m?.title||m?.groupItemTitle))
  }));
  return x.event;
}
async function cycle(){
  const candidates=await discover();
  console.log(JSON.stringify({level:"INFO",event:"CYCLE_CANDIDATES",count:candidates.length}));
  for(const x of candidates){
    if(stopping)break;
    const id=t(x.url).replace(/\/$/,"");if(!id||alerted.has(id)||alerting.has(id))continue;
    alerting.add(id);
    try{
      await refreshEvent(x);
      console.log(JSON.stringify({level:"INFO",event:"CANDIDATE_BEFORE_CLAIM",slug:x.slug,teams:[x.home,x.away],status:x.gameStatus,minute:x.minute??null,score:x.score??null,markets:Array.isArray(x.event?.markets)?x.event.markets.length:0}));
      // Both authoritative score and match minute are mandatory for an alert.
      // Never send a LIVE alert with missing or fabricated clock data.
      if(!validScore(x.score)||!validMinute(x.minute)){
        console.log(JSON.stringify({
          level:"WARN",
          event:"candidate_rejected_untrusted_live_data",
          reason:!validScore(x.score)?"invalid_score":"invalid_minute",
          eventId:id,
          slug:x.slug,
          minute:x.minute??null,
          score:x.score??null
        }));
        continue;
      }
      const claimAllowed=await claimFootballMatch(id);
      console.log(JSON.stringify({level:"INFO",event:claimAllowed?"CLAIM_ALLOWED":"CLAIM_BLOCKED",eventId:id,slug:x.slug}));
      if(!claimAllowed){ console.log(JSON.stringify({level:"INFO",event:"duplicate_suppressed",eventId:id,slug:x.slug})); continue; }
      try {
        const pages=buildAlertPages(x);
        for(let i=0;i<pages.length;i++){
          const label=pages.length>1?"📄 "+(i+1)+"/"+pages.length:"";
          const suffix="\n\n"+x.url;
          await sendTelegram((label?(label+"\n\n"):"")+pages[i]+suffix);
        }
        alerted.add(id);
      } catch(e) {
        try { await releaseFootballMatch(id); } catch(re) { console.log(JSON.stringify({level:"ERROR",event:"dedupe_release_failed",eventId:id,slug:x.slug,message:re.message})); }
        throw e;
      }
      console.log(JSON.stringify({level:"INFO",event:"TELEGRAM_SENT",eventId:id,slug:x.slug,teams:[x.home,x.away]}));
    }catch(e){console.log(JSON.stringify({level:"ERROR",event:"alert_failed",eventId:id,slug:x.slug,message:e.message}));}
    finally{alerting.delete(id);}
  }
}
async function main(){
  console.log(JSON.stringify({event:"monitor_start",mode:DIAGNOSTIC_MODE?"diagnostic":"monitor",sourceLive:LIVE_PAGE,sourceEvents:GAMMA+"/events?active=true&closed=false",sourceSoccerPage:SOCCER_PAGE,pollMs:POLL_MS,runMs:RUN_MS,maxCycles:Number.isFinite(MAX_CYCLES)?MAX_CYCLES:null}));
  const deadline=Date.now()+RUN_MS; let cycles=0;
  while(!stopping&&Date.now()<deadline&&cycles<MAX_CYCLES){const started=Date.now();try{await cycle()}catch(e){console.log(JSON.stringify({level:"ERROR",event:"cycle_failed",message:e.message}))}cycles++;console.log(JSON.stringify({event:"cycle_complete",cycle:cycles,elapsedMs:Date.now()-started}));if(cycles>=MAX_CYCLES)break;await new Promise(r=>setTimeout(r,Math.max(250,Math.min(POLL_MS,deadline-Date.now()))));}
  console.log(JSON.stringify({event:"monitor_exit",cycles}));
  try{healthServer?.close()}catch{}
}
process.on("SIGTERM",()=>{console.log(JSON.stringify({level:"INFO",event:"shutdown_signal",signal:"SIGTERM"}));stopping=true});
process.on("SIGINT",()=>{console.log(JSON.stringify({level:"INFO",event:"shutdown_signal",signal:"SIGINT"}));stopping=true});
process.on("uncaughtException",e=>console.log(JSON.stringify({level:"ERROR",event:"uncaught_exception",name:e?.name,message:e?.message,stack:e?.stack})));
process.on("unhandledRejection",e=>console.log(JSON.stringify({level:"ERROR",event:"unhandled_rejection",message:e?.message||String(e),stack:e?.stack})));
console.log(JSON.stringify({level:"INFO",event:"startup_bootstrap",node:process.version,pid:process.pid,port:Number(process.env.PORT||3000)}));
main().catch(e=>console.log(JSON.stringify({level:"ERROR",event:"main_failed",name:e?.name,message:e?.message,stack:e?.stack})));

