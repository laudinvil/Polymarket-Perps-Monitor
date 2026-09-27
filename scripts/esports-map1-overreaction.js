async function ensurePrematchBaseline(match, poly, entry) {
  const startAt=beginAt(match);
  const started=startAt!=null && startAt<=Date.now();
  if(entry.pre){
    const captured=Date.parse(entry.pre.capturedAt||"");
    if(Number.isFinite(captured) && startAt!=null && captured<=startAt) return entry.pre;
    delete entry.pre;
  }
  // A price captured after the series started is NOT a pre-match baseline.
  // Never build an overreaction signal from a synthetic/current baseline.
  if(started || firstFinishedGame(match)) return null;
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
  startedAt: new Date().toISOString(), events:0, polls:0, alerts:0, errors:0,
  byEvent:{}, recent:[], lastPoll:null, lastError:null, updatedAt:null
};
let lastRemotePushAt = 0;
async function flushLogQueue(){if(logBusy||!logQueue.length)return;logBusy=true;const item=logQueue.shift();try{const headers={"content-type":"application/json"};if(DEPLEXO_LOG_TOKEN)headers.authorization="Bearer "+DEPLEXO_LOG_TOKEN;await fetch(DEPLEXO_LOG_URL,{method:"POST",headers,body:JSON.stringify(item),signal:AbortSignal.timeout(5000)});}catch{}logBusy=false;if(logQueue.length)void flushLogQueue();}
function log(event,data={}){nativeConsoleLog(event,JSON.stringify(data));telemetry.events++;telemetry.byEvent[event]=(telemetry.byEvent[event]||0)+1;if(event==="POLL_RESULT")telemetry.polls++;if(event==="ALERT_SENT")telemetry.alerts++;if(event==="POLL_ERROR"||event==="STATE_PUSH_ERROR"){telemetry.errors++;telemetry.lastError={ts:new Date().toISOString(),event,data};}telemetry.recent.push({ts:new Date().toISOString(),event,data});if(telemetry.recent.length>80)telemetry.recent.splice(0,telemetry.recent.length-80);telemetry.updatedAt=new Date().toISOString();logQueue.push({ts:new Date().toISOString(),event,data,runId:process.env.GITHUB_RUN_ID||null,runAttempt:process.env.GITHUB_RUN_ATTEMPT||null,sha:process.env.GITHUB_SHA||null});if(logQueue.length>500)logQueue.splice(0,logQueue.length-500);void flushLogQueue();}
if(!PS_TOKEN)throw new Error("Missing PANDASCORE_API_TOKEN");if(!TG_TOKEN||!TG_CHAT)throw new Error("Missing Telegram secrets");
const PS_BASE="https://api.pandascore.co",GAMMA="https://gamma-api.polymarket.com",CLOB="https://clob.polymarket.com";
const CFG={minPreFavorite:.25,maxPreFavorite:.75,minMove:.03,minPostFavorite:.52,maxPostFavorite:1,minMapMargin:2,minMapMarginRatio:.25,requireMapMargin:true,maxUpcomingHours:24};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PS_HOURLY_LIMIT=1000,PS_SAFETY_LIMIT=Math.floor(PS_HOURLY_LIMIT*.9),psRequestTimes=[];let psUpcomingCache={at:0,data:[]},psRunningCache={at:0,data:[]};
function prunePsBudget(now=Date.now()){while(psRequestTimes.length&&now-psRequestTimes[0]>=3600000)psRequestTimes.shift();}
async function waitForPsBudget(){while(true){const now=Date.now();prunePsBudget(now);if(psRequestTimes.length<PS_SAFETY_LIMIT){psRequestTimes.push(now);return;}const wait=Math.max(1000,3600000-(now-psRequestTimes[0])+1000);log("PANDASCORE_RATE_WAIT",{used:psRequestTimes.length,limit:PS_SAFETY_LIMIT,waitMs:wait});await sleep(Math.min(wait,30000));}}
const norm=s=>String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").replace(/\b(esports?|gaming|team|academy|club|fc|gg|org)\b/g," ").replace(/\s+/g," ").trim();
function compact(s){return norm(s).replace(/\s+/g,"");}function acronym(s){return norm(s).split(" ").filter(Boolean).map(x=>x[0]).join("");}function nameScore(a,b){const na=norm(a),nb=norm(b);if(!na||!nb)return 0;if(na===nb||compact(a)===compact(b))return 1;if(na.includes(nb)||nb.includes(na))return .92;const aa=acronym(a),ab=acronym(b);if(aa&&ab&&aa===ab&&aa.length>=2)return .88;if(aa&&nb===aa)return .88;if(ab&&na===ab)return .88;const A=new Set(na.split(" ").filter(x=>x.length>1)),B=new Set(nb.split(" ").filter(x=>x.length>1));if(!A.size||!B.size)return 0;let hit=0;for(const x of A)if(B.has(x))hit++;return hit/Math.max(A.size,B.size);}const sim=(a,b)=>nameScore(a,b);
async function getJson(url,headers={}){let last;for(let i=0;i<4;i++){const started=Date.now();log("HTTP_REQUEST",{url,attempt:i+1});try{const r=await fetch(url,{headers:{accept:"application/json",...headers},signal:AbortSignal.timeout(12000)});const elapsedMs=Date.now()-started;log("HTTP_RESPONSE",{url,status:r.status,ok:r.ok,elapsedMs});if(r.ok){const data=await r.json();log("HTTP_JSON",{url,kind:Array.isArray(data)?"array":typeof data,count:Array.isArray(data)?data.length:undefined});return{data,headers:r.headers};}last=new Error("HTTP "+r.status+" "+url);if(![429,500,502,503,504].includes(r.status)){log("HTTP_NONRETRYABLE",{url,status:r.status});throw last;}log("HTTP_RETRY",{url,status:r.status,nextAttempt:i+2});}catch(e){last=e;log("HTTP_ERROR",{url,attempt:i+1,error:String(e)});if(/HTTP (?!429|500|502|503|504)\d+ /.test(String(e))||String(e).includes("AbortError"))throw e;}if(i<3)await sleep(800*(i+1));}throw last;}
async function ps(path){return(await getJson(PS_BASE+path,{authorization:"Bearer "+PS_TOKEN})).data;}async function psPaged(path,maxPages=5){const all=[];for(let page=1;page<=maxPages;page++){const sep=path.includes("?")?"&":"?";const batch=await ps(path+sep+"page="+page+"&per_page=100");if(!Array.isArray(batch)||!batch.length)break;all.push(...batch);if(batch.length<100)break;}return[...new Map(all.filter(x=>x?.id!=null).map(x=>[String(x.id),x])).values()];}
function opponents(match){return Array.isArray(match.opponents)?match.opponents:[]}function teams(match){return opponents(match).map(x=>x?.opponent?.name||x?.opponent?.acronym).filter(Boolean).slice(0,2)}function seriesScore(match){const o=opponents(match);if(o.length>=2){const a=Number(o[0]?.score),b=Number(o[1]?.score);if(Number.isFinite(a)&&Number.isFinite(b))return[a,b];}const r=Array.isArray(match.results)?match.results:[];if(r.length>=2){const a=Number(r[0]?.score??r[0]?.result),b=Number(r[1]?.score??r[1]?.result);if(Number.isFinite(a)&&Number.isFinite(b))return[a,b];}for(const c of [match.score,match.series_score,match.seriesScore]){if(Array.isArray(c)&&c.length>=2){const a=Number(c[0]),b=Number(c[1]);if(Number.isFinite(a)&&Number.isFinite(b))return[a,b];}else if(c&&typeof c==="object"){const a=Number(c.home??c.team1??c.a),b=Number(c.away??c.team2??c.b);if(Number.isFinite(a)&&Number.isFinite(b))return[a,b];}}return null;}
function supportedSeries(match){const type=String(match.match_type||"").toLowerCase(),games=Number(match.number_of_games);return(type==="best_of"&&(games===3||games===5))||(type==="first_to"&&games===3)||(type==="red_bull_home_ground"&&games===5)}function beginAt(match){const t=Date.parse(match.begin_at||match.scheduled_at||"");return Number.isFinite(t)?t:null}function parseJsonMaybe(v){if(typeof v!=="string")return v;try{return JSON.parse(v)}catch{return v}}
function eventTeams(event){const out=[];const add=v=>{if(typeof v==="string"&&v.trim())out.push(v.trim());else if(v&&typeof v==="object"){const n=v.name||v.teamName||v.title;if(n)out.push(String(n));}};add(event.homeTeam);add(event.awayTeam);add(event.homeTeamName);add(event.awayTeamName);if(Array.isArray(event.teams))event.teams.forEach(add);return[...new Set(out)];}
function parseMarket(m){if(!m||typeof m!=="object")return null;const outcomes=parseJsonMaybe(m.outcomes),ids=parseJsonMaybe(m.clobTokenIds),prices=parseJsonMaybe(m.outcomePrices);if(!Array.isArray(outcomes)||outcomes.length!==2)return null;return outcomes.map((name,i)=>({name:String(name),tokenId:Array.isArray(ids)&&ids[i]!=null?String(ids[i]):"",gammaPrice:Array.isArray(prices)&&prices[i]!=null?Number(prices[i]):null}));}
function isMatchWinnerMarket(m,teamA,teamB){const q=String(m.question||m.title||"").toLowerCase(),p=parseMarket(m);if(!p||p.length!==2)return false;const names=p.map(x=>norm(x.name)),a=norm(teamA),b=norm(teamB);if(!(names.some(x=>sim(x,a)>=.5)&&names.some(x=>sim(x,b)>=.5)))return false;if(/\bmap\s*\d+\b/i.test(q))return false;if(/\b(total|over|under|spread|handicap|rounds?|kills?|first\s+map|map\s+winner|game\s*\d+)\b/i.test(q))return false;return true;}
async function loadPolyEvents(){const urls=[GAMMA+"/events?active=true&closed=false&limit=500&tag_slug=esports",GAMMA+"/events?active=true&closed=false&limit=500&order=startDate&ascending=true"];let events=[];for(const u of urls){try{const x=await getJson(u);if(Array.isArray(x.data))events.push(...x.data)}catch(e){log("POLY_DISCOVERY_ERROR",String(e))}}return[...new Map(events.filter(e=>e?.id!=null).map(e=>[String(e.id),e])).values()]}
const polySearchCache=new Map();async function searchPolyForMatch(teamA,teamB){const cacheKey=norm(teamA)+"|"+norm(teamB);if(polySearchCache.has(cacheKey))return polySearchCache.get(cacheKey);const queries=[teamA+" "+teamB,teamA,teamB],found=[];for(const q of queries){try{const x=await getJson(GAMMA+"/public-search?q="+encodeURIComponent(q)+"&limit_per_type=20&page=1&keep_closed_markets=0");const data=x.data||{};for(const e of Array.isArray(data.events)?data.events:[])found.push(e);for(const m of Array.isArray(data.markets)?data.markets:[])if(m?.event)found.push(m.event)}catch(e){log("POLY_SEARCH_ERROR",{teamA,teamB,error:String(e)})}}const result=[...new Map(found.filter(e=>e?.id!=null).map(e=>[String(e.id),e])).values()];polySearchCache.set(cacheKey,result);return result;}
async function hydratePolyEvent(candidate,teamA,teamB){if(!candidate?.event)return null;const e=candidate.event;let markets=Array.isArray(e.markets)?e.markets:[];if(!markets.length&&e.id){try{const x=await getJson(GAMMA+"/events/"+encodeURIComponent(String(e.id)));markets=Array.isArray(x.data?.markets)?x.data.markets:[]}catch(err){log("POLY_EVENT_ERROR",{eventId:e.id,error:String(err)})}}const m=markets.find(x=>isMatchWinnerMarket(x,teamA,teamB));return m?{event:e,market:m}:null;}
const priceCache=new Map();async function price(tokenId){const c=priceCache.get(tokenId);if(c&&Date.now()-c.at<30000)return c.value;try{const x=await getJson(CLOB+"/price?token_id="+encodeURIComponent(tokenId)+"&side=BUY");const v=Number(x.data?.price);if(!Number.isFinite(v))return null;priceCache.set(tokenId,{at:Date.now(),value:v});return v}catch{return null;}}
const polyPriceCache=new Map();async function marketPrices(poly){if(!poly?.market)return null;const parsed=parseMarket(poly.market);if(!parsed)return null;const cacheKey=String(poly.market.id||parsed.map(x=>x.tokenId).join("|")),cached=polyPriceCache.get(cacheKey);if(cached&&Date.now()-cached.at<30000)return cached.data;const vals=await Promise.all(parsed.map(async o=>{if(Number.isFinite(o.gammaPrice))return{...o,price:o.gammaPrice};const clob=o.tokenId?await price(o.tokenId):null;return{...o,price:Number.isFinite(clob)?clob:null};}));if(vals.some(x=>!Number.isFinite(x.price)))return null;const total=vals[0].price+vals[1].price;if(total<=0)return null;const data=vals.map(x=>({...x,prob:x.price/total}));polyPriceCache.set(cacheKey,{at:Date.now(),data});return data;}
function identifySides(prices,teamA,teamB){const pa=prices.find(x=>sim(x.name,teamA)>=.5),pb=prices.find(x=>sim(x.name,teamB)>=.5);return{a:pa||prices[0],b:pb||prices[1]};}
async function psLives(){
  try{
    const data=await ps("/lives");
    return Array.isArray(data)?data:[];
  }catch(e){
    log("PANDASCORE_LIVES_ERROR",{error:String(e)});
    return[];
  }
}
function liveMatchId(x){return String(x?.match_id??x?.matchId??x?.match?.id??x?.id??"");}
function mergeLiveIntoMatch(match,lives){
  const id=String(match?.id||"");
  const live=(lives||[]).find(x=>liveMatchId(x)===id);
  if(!live)return match;
  const games=[...(Array.isArray(match?.games)?match.games:[])];
  for(const k of ["games","maps"]){
    if(Array.isArray(live?.[k]))games.push(...live[k]);
  }
  const out={...match};
  if(games.length){
    out.games=[...new Map(games.filter(g=>g&&typeof g==="object").map(g=>[
      String(g.id??g.position??g.number??JSON.stringify(g)),g
    ])).values()];
  }
  if(live?.match&&typeof live.match==="object")Object.assign(out,live.match);
  out.__live=live;
  return out;
}
async function collectLiveFrames(lives,state,diag){
  if(typeof WebSocket!=="function"){
    diag.liveWsUnavailable=(diag.liveWsUnavailable||0)+1;
    return;
  }
  const targets=[];
  for(const live of lives||[]){
    const matchId=liveMatchId(live);if(!matchId)continue;
    const endpoints=Array.isArray(live?.endpoints)?live.endpoints:[];
    for(const ep of endpoints){
      if(String(ep?.type||"").toLowerCase()!=="frames"||!ep?.url)continue;
      targets.push({matchId,url:String(ep.url)});
    }
  }
  if(!targets.length)return;
  const runOne=({matchId,url})=>new Promise(resolve=>{
    let settled=false,seen=0,socket=null,timer=null;
    const finish=(reason)=>{if(settled)return;settled=true;try{socket?.close()}catch{}if(timer)clearTimeout(timer);if(reason)diag.liveWsLastError=String(reason);resolve();};
    try{
      const sep=url.includes("?")?"&":"?";
      socket=new WebSocket(url+sep+"token="+encodeURIComponent(PS_TOKEN));
      diag.liveWsConnections=(diag.liveWsConnections||0)+1;
      socket.onopen=()=>{diag.liveWsOpen=(diag.liveWsOpen||0)+1;};
      socket.onmessage=ev=>{
        try{
          const frame=JSON.parse(typeof ev.data==="string"?ev.data:Buffer.from(ev.data).toString("utf8"));
          if(frame?.type==="hello")return;
          const payload=frame?.payload??frame;
          const snaps=liveGameSnapshots(payload);
          for(const snap of snaps){
            if(!snap.score)continue;
            const existing=state.liveScores?.[matchId]||{matchId,updatedAt:null,games:{}};
            const key=snap.id||("pos:"+String(snap.position??"1"));
            const old=existing.games?.[key];
            existing.games=existing.games||{};
            existing.games[key]={...old,...snap,source:"websocket",observedAt:new Date().toISOString()};
            existing.updatedAt=new Date().toISOString();
            existing.liveWs=true;
            state.liveScores=state.liveScores||{};
            state.liveScores[matchId]=existing;
            diag.liveMapScoresObserved=(diag.liveMapScoresObserved||0)+1;
            seen++;
          }
        }catch(e){diag.liveWsParseErrors=(diag.liveWsParseErrors||0)+1;}
      };
      socket.onerror=()=>finish("ws_error");
      socket.onclose=ev=>finish("ws_close_"+String(ev?.code??""));
      timer=setTimeout(()=>finish(seen?null:"ws_timeout_no_score"),7000);
    }catch(e){finish(e);}
  });
  await Promise.all(targets.slice(0,5).map(runOne));
}

function liveGameSnapshots(live){
  const out=[];
  const walk=(v,depth=0,source="root")=>{
    if(depth>6||v==null)return;
    if(Array.isArray(v)){for(const x of v)walk(x,depth+1,source);return;}
    if(typeof v!=="object")return;
    const id=v.id??v.game_id??v.gameId??v.map_id??v.mapId;
    const position=v.position??v.number??v.map_number??v.mapNumber;
    // For CS2 frames, Map 1 means the in-map round score. Prefer round_score over
    // any series-level score so 0-1/1-0 series state can never masquerade as a map score.
    let score=null;
    if(v.counter_terrorists&&v.terrorists){
      const p=scorePair({home:v.counter_terrorists?.round_score,away:v.terrorists?.round_score});
      if(p)score=p;
    }
    if(!score){
      const scoreCandidates=[v.map_score,v.game_score,v.round_score,v.results,v.opponents,v.teams];
      for(const s of scoreCandidates){const p=scorePair(s);if(p){score=p;break;}}
    }
    const hasGameIdentity=id!=null||position!=null||/game|map/i.test(source);
    if(score&&hasGameIdentity){
      out.push({id:id!=null?String(id):null,position:position!=null?Number(position):null,score,status:String(v.status??v.state??""),finished:v.finished===true||v.complete===true||/^(finished|completed|complete|ended)$/i.test(String(v.status??v.state??"")),winnerId:v.winner_id??v.winnerId??v.winner?.id??null,observedAt:new Date().toISOString(),source,raw:{score:v.score??null,map_score:v.map_score??null,game_score:v.game_score??null,round_score:v.round_score??null,results:v.results??null,opponents:v.opponents??null,teams:v.teams??null}});
    }
    for(const [k,x] of Object.entries(v))walk(x,depth+1,k);
  };
  walk(live,0,"live");
  return out;
}
function rememberLiveScores(state,lives,diag){
  state.liveScores&&typeof state.liveScores==="object"||(state.liveScores={});
  for(const live of lives||[]){
    const matchId=liveMatchId(live);if(!matchId)continue;
    const snaps=liveGameSnapshots(live);
    if(!snaps.length)continue;
    const existing=state.liveScores[matchId]||{matchId,updatedAt:null,games:{}};
    for(const s of snaps){
      const key=s.id||("pos:"+String(s.position??""));
      if(!key)continue;
      const old=existing.games[key];
      // Never overwrite a real score with an empty/binary observation.
      if(!old||s.score||(old.score&&old.score[0]!==old.score[1])) existing.games[key]={...old,...s};
    }
    existing.updatedAt=new Date().toISOString();
    existing.liveFields={status:live.status??null,started_at:live.started_at??null,ended_at:live.ended_at??null,match_id:matchId,gamesCount:Array.isArray(live.games)?live.games.length:null,mapsCount:Array.isArray(live.maps)?live.maps.length:null};
    state.liveScores[matchId]=existing;
    diag.liveScoresObserved=(diag.liveScoresObserved||0)+snaps.length;
  }
}
function cachedLiveGames(state,matchId){
  const x=state?.liveScores?.[String(matchId)];
  return x?Object.values(x.games||{}):[];
}
function mergeCachedLiveScores(match,state){
  const cached=cachedLiveGames(state,match?.id);if(!cached.length)return match;
  const games=[...(Array.isArray(match?.games)?match.games:[])];
  for(const s of cached){
    const idx=games.findIndex(g=>String(g?.id??"")===String(s.id??"")||(s.position!=null&&Number(g?.position??g?.number)===Number(s.position)));
    const game={id:s.id||undefined,position:s.position,status:s.status,finished:s.finished,complete:s.finished,score:s.score,winner_id:s.winnerId??undefined,__liveObservedAt:s.observedAt};
    if(idx>=0)games[idx]={...games[idx],...game};else games.push(game);
  }
  return {...match,games};
}

function scorePair(s){
  if(Array.isArray(s)&&s.length>=2){
    const vals=s.map(x=>typeof x==="object"?Number(x?.score??x?.result??x?.value??x?.points):Number(x));
    if(vals.every(Number.isFinite))return[vals[0],vals[1]];
  }
  if(s&&typeof s==="object"){
    const a=s.home??s.team1??s.a??s.home_score??s.team1_score;
    const b=s.away??s.team2??s.b??s.away_score??s.team2_score;
    const av=typeof a==="object"?Number(a?.score??a?.result??a?.value??a?.points):Number(a);
    const bv=typeof b==="object"?Number(b?.score??b?.result??b?.value??b?.points):Number(b);
    if(Number.isFinite(av)&&Number.isFinite(bv))return[av,bv];
  }
  return null;
}
function parseGameScore(g,match=null){
  const liveSources=[g?.score,g?.map_score,g?.game_score,g?.results,g?.opponents,g?.teams,g?.counter_terrorists&&g?.terrorists?{
    home:g?.counter_terrorists?.round_score??g?.counter_terrorists?.score,
    away:g?.terrorists?.round_score??g?.terrorists?.score
  }:null];
  for(const s of liveSources){
    const pair=scorePair(s);
    if(pair&&pair[0]!==pair[1]){
      if(Math.max(...pair)<=1)return{value:null,type:"binary",score:pair};
      return{value:Math.abs(pair[0]-pair[1]),type:"score",score:pair};
    }
  }
  const winnerId=String(g?.winner_id??g?.winnerId??g?.winner?.id??"");
  if(winnerId&&match){
    const os=opponents(match);
    const idx=os.findIndex(o=>String(o?.opponent?.id??o?.id??"")===winnerId);
    if(idx>=0)return{value:null,type:"winner_only",score:null,winner:idx};
  }
  return{value:null,type:"unknown",score:null};
}
function gameFinished(g){
  const status=String(g?.status||g?.state||"").toLowerCase();
  return /^(finished|completed|complete|ended)$/.test(status)||g?.finished===true||g?.complete===true;
}
function firstFinishedGame(match){
  const games=Array.isArray(match.games)?match.games:[];
  const finished=games.filter(gameFinished);
  if(!finished.length)return null;
  finished.sort((a,b)=>Number(a?.position??a?.number??a?.id??0)-Number(b?.position??b?.number??b?.id??0));
  return finished[0];
}
async function fetchGameDetails(match, game){
  if(!game?.id)return game;
  try{
    const slug=String(match?.videogame?.slug||"").toLowerCase();
    const title=String(match?.videogame_title?.slug||match?.videogame_title?.name||"").toLowerCase();
    const isCS=slug==="csgo"||slug.includes("counter")||slug.includes("cs")||title==="cs-2"||title.includes("counter-strike");
    const path=isCS?"/csgo/games/"+encodeURIComponent(String(game.id)):"/games/"+encodeURIComponent(String(game.id));
    const detail=await ps(path);
    return detail||game;
  }catch(e){log("GAME_DETAILS_ERROR",{matchId:String(match?.id||""),gameId:String(game.id),error:String(e)});return game;}
}
const bo3Cache=new Map();
async function bo3Map1Fallback(teamA,teamB,diag){
  const cacheKey=norm(teamA)+"|"+norm(teamB),cached=bo3Cache.get(cacheKey);
  if(cached&&Date.now()-cached.at<30000)return cached.value;
  const headers={"accept":"application/json, text/plain, */*","origin":"https://bo3.gg","referer":"https://bo3.gg/","user-agent":"Mozilla/5.0"};
  const urls=[
    "https://api.bo3.gg/api/v1/matches/current",
    "https://api.bo3.gg/api/v1/matches/current?game=cs2"
  ];
  try{
    let rows=[];
    for(const url of urls){
      try{
        const r=await fetch(url,{headers,signal:AbortSignal.timeout(7000)});
        if(!r.ok)continue;
        const j=await r.json();
        const arr=Array.isArray(j)?j:(Array.isArray(j?.data)?j.data:(Array.isArray(j?.matches)?j.matches:[]));
        rows.push(...arr);
        if(arr.length)break;
      }catch{}
    }
    const ranked=rows.map(m=>{
      const ts=Array.isArray(m?.teams)?m.teams:[m?.team1,m?.team2,m?.home_team,m?.away_team];
      const names=ts.map(x=>String(x?.name||x?.title||x||"")).filter(Boolean).slice(0,2);
      return{m,names,score:names.length>=2?Math.max(nameScore(names[0],teamA)+nameScore(names[1],teamB),nameScore(names[0],teamB)+nameScore(names[1],teamA)):0};
    }).filter(x=>x.score>=1.25).sort((a,b)=>b.score-a.score);
    for(const hit of ranked.slice(0,3)){
      let detail=hit.m;
      const id=hit.m?.id??hit.m?.match_id??hit.m?.matchId;
      const detailUrls=id?[
        "https://api.bo3.gg/api/v1/matches/"+encodeURIComponent(String(id)),
        "https://api.bo3.gg/api/v1/matches/"+encodeURIComponent(String(id))+"?game=cs2"
      ]:[];
      for(const url of detailUrls){
        try{const r=await fetch(url,{headers,signal:AbortSignal.timeout(7000)});if(r.ok){detail=await r.json();break;}}catch{}
      }
      const maps=Array.isArray(detail?.maps)?detail.maps:(Array.isArray(detail?.games)?detail.games:[]);
      const map=maps[0];
      const a=Number(map?.home_rounds??map?.team1Score??map?.team1_score??map?.score?.team1);
      const b=Number(map?.away_rounds??map?.team2Score??map?.team2_score??map?.score?.team2);
      if(!Number.isFinite(a)||!Number.isFinite(b)||a===b||Math.max(a,b)<=1)continue;
      const names2=hit.names,forward=nameScore(names2[0],teamA)+nameScore(names2[1],teamB),reverse=nameScore(names2[0],teamB)+nameScore(names2[1],teamA),score=reverse>forward?[b,a]:[a,b];
      const value={score,marginValue:Math.abs(score[0]-score[1]),marginRatio:Math.abs(score[0]-score[1])/Math.max(...score),source:"bo3gg",bo3MatchId:String(id||"")};
      bo3Cache.set(cacheKey,{at:Date.now(),value});diag.bo3FallbackMatches=(diag.bo3FallbackMatches||0)+1;log("BO3GG_MAP1_FOUND",{teamA,teamB,...value});return value;
    }
    bo3Cache.set(cacheKey,{at:Date.now(),value:null});diag.bo3FallbackMisses=(diag.bo3FallbackMisses||0)+1;return null;
  }catch(e){diag.bo3FallbackErrors=(diag.bo3FallbackErrors||0)+1;log("BO3GG_FALLBACK_ERROR",{teamA,teamB,error:String(e)});bo3Cache.set(cacheKey,{at:Date.now(),value:null});return null;}
}

let hltvLibPromise=null;
const hltvCache=new Map();
async function getHltv(){if(!hltvLibPromise)hltvLibPromise=import("hltv").then(m=>m.default||m.HLTV||m).catch(e=>{log("HLTV_LOAD_ERROR",{error:String(e)});return null;});return hltvLibPromise;}
async function hltvResultsFallback(teamA,teamB,diag){
  try{
    const HLTV=await getHltv();
    if(!HLTV?.getResults)return null;
    const now=new Date(), start=new Date(now.getTime()-24*3600000), end=new Date(now.getTime()+3600000);
    const rows=await HLTV.getResults({startDate:start.toISOString().slice(0,10),endDate:end.toISOString().slice(0,10),bestOfX:[3,5],delayBetweenPageRequests:0});
    const arr=Array.isArray(rows)?rows:(Array.isArray(rows?.results)?rows.results:[]);
    const ranked=arr.map(r=>{
      const n1=String(r?.team1?.name||r?.teams?.[0]?.name||r?.team1Name||"");
      const n2=String(r?.team2?.name||r?.teams?.[1]?.name||r?.team2Name||"");
      return{r,n1,n2,score:Math.max(nameScore(n1,teamA)+nameScore(n2,teamB),nameScore(n1,teamB)+nameScore(n2,teamA))};
    }).filter(x=>x.score>=1.25).sort((a,b)=>b.score-a.score);
    for(const hit of ranked.slice(0,5)){
      const r=hit.r, maps=Array.isArray(r?.maps)?r.maps:(Array.isArray(r?.games)?r.games:[]);
      const m=maps[0];
      const a=Number(m?.team1Score??m?.team1_score??m?.score?.team1??m?.result?.team1);
      const b=Number(m?.team2Score??m?.team2_score??m?.score?.team2??m?.result?.team2);
      if(!Number.isFinite(a)||!Number.isFinite(b)||a===b||Math.max(a,b)<=1)continue;
      const forward=nameScore(hit.n1,teamA)+nameScore(hit.n2,teamB),reverse=nameScore(hit.n1,teamB)+nameScore(hit.n2,teamA),score=reverse>forward?[b,a]:[a,b];
      const value={score,marginValue:Math.abs(score[0]-score[1]),marginRatio:Math.abs(score[0]-score[1])/Math.max(...score),source:"hltv-results"};
      diag.hltvResultsMatches=(diag.hltvResultsMatches||0)+1;log("HLTV_RESULTS_MAP1_FOUND",{teamA,teamB,...value});return value;
    }
    diag.hltvResultsMisses=(diag.hltvResultsMisses||0)+1;return null;
  }catch(e){diag.hltvResultsErrors=(diag.hltvResultsErrors||0)+1;log("HLTV_RESULTS_ERROR",{teamA,teamB,error:String(e)});return null;}
}

async function hltvMap1Fallback(teamA,teamB,diag){
  const cacheKey=norm(teamA)+"|"+norm(teamB),cached=hltvCache.get(cacheKey);
  if(cached&&Date.now()-cached.at<90000)return cached.value;
  const HLTV=await getHltv();if(!HLTV?.getMatches)return null;
  try{
    const matches=await HLTV.getMatches();
    const ranked=(Array.isArray(matches)?matches:[]).map(m=>{const a=String(m?.team1?.name||""),b=String(m?.team2?.name||"");return{m,score:Math.max(nameScore(a,teamA)+nameScore(b,teamB),nameScore(a,teamB)+nameScore(b,teamA))};}).filter(x=>x.score>=1.25).sort((a,b)=>b.score-a.score);
    for(const hit of ranked.slice(0,3)){if(!hit.m?.id)continue;const detail=await HLTV.getMatch({id:Number(hit.m.id)}),map=Array.isArray(detail?.maps)?detail.maps[0]:null,r=map?.result,a=Number(r?.team1TotalRounds),b=Number(r?.team2TotalRounds);if(!Number.isFinite(a)||!Number.isFinite(b)||a===b||Math.max(a,b)<=1)continue;const forward=nameScore(String(hit.m?.team1?.name||""),teamA)+nameScore(String(hit.m?.team2?.name||""),teamB),reverse=nameScore(String(hit.m?.team1?.name||""),teamB)+nameScore(String(hit.m?.team2?.name||""),teamA),score=reverse>forward?[b,a]:[a,b];const value={score,marginValue:Math.abs(score[0]-score[1]),marginRatio:Math.abs(score[0]-score[1])/Math.max(...score),source:"hltv",hltvMatchId:String(hit.m.id),mapName:map?.name||null,status:String(detail?.status||"")};hltvCache.set(cacheKey,{at:Date.now(),value});diag.hltvFallbackMatches=(diag.hltvFallbackMatches||0)+1;log("HLTV_MAP1_FOUND",{teamA,teamB,...value});return value;}
    hltvCache.set(cacheKey,{at:Date.now(),value:null});diag.hltvFallbackMisses=(diag.hltvFallbackMisses||0)+1;return null;
  }catch(e){diag.hltvFallbackErrors=(diag.hltvFallbackErrors||0)+1;log("HLTV_FALLBACK_ERROR",{teamA,teamB,error:String(e)});hltvCache.set(cacheKey,{at:Date.now(),value:null});return null;}
}

async function map1InfoAsync(match,diag){
  const games=Array.isArray(match?.games)?match.games:[];
  const finished=games.filter(gameFinished).sort((a,b)=>Number(a?.position??a?.number??a?.id??0)-Number(b?.position??b?.number??b?.id??0));
  if(finished.length)diag.finishedGamesFound=(diag.finishedGamesFound||0)+1;
  const g=finished[0]||null;
  const series=seriesScore(match);
  if(!g){
    if(!series||series[0]===series[1])return null;
    const seriesHasMap1=Math.min(series[0],series[1])===0&&Math.max(series[0],series[1])>=1;
    if(!seriesHasMap1)return null;
    diag.map1DetectedFromSeries=(diag.map1DetectedFromSeries||0)+1;
    return null;
  }
  diag.map1Finished++;
  let score=parseGameScore(g,match);
  if(!Number.isFinite(score.value)&&g?.id){
    diag.gameDetailsRequested=(diag.gameDetailsRequested||0)+1;if(score.type==="winner_only")diag.gameDetailsWinnerOnlyRequested=(diag.gameDetailsWinnerOnlyRequested||0)+1;
    const detail=await fetchGameDetails(match,g);
    score=parseGameScore(detail,match);
  }
  if(score.type==="winner_only"){
    diag.gameWinnerFound=(diag.gameWinnerFound||0)+1;
    diag.marginUnavailable=(diag.marginUnavailable||0)+1;
    diag.winnerOnlyRejected=(diag.winnerOnlyRejected||0)+1;
    return null;
  }else if(Number.isFinite(score.value)){
    diag.gameScoreFound=(diag.gameScoreFound||0)+1;
  }else{
    diag.marginUnavailable=(diag.marginUnavailable||0)+1;
    return null;
  }
  const winner=score.score[0]>score.score[1]?0:1;
  const loser=winner===0?1:0;
  return{winner,loser,series:score.score,margin:score.score,marginValue:score.value,marginRatio:score.value/Math.max(...score.score)};
}

function diagInit(){return{events:0,candidates:0,livesFetched:0,liveScoresObserved:0, hltvFallbackMatches:0,hltvFallbackMisses:0,hltvFallbackErrors:0,hltvResultsMatches:0,hltvResultsMisses:0,hltvResultsErrors:0,bo3FallbackMatches:0,bo3FallbackMisses:0,bo3FallbackErrors:0,polyHydrateAttempts:0,polyFastMatched:0,polySearchCalls:0,matchedPoly:0,finishedGamesFound:0,map1Finished:0,gameDetailsRequested:0,gameDetailsWinnerOnlyRequested:0,gameScoreFound:0,gameWinnerFound:0,winnerOnlyRejected:0,marginUnavailable:0,signalChecks:0,fallbackSignalPass:0,balancedPrePass:0,movePass:0,postRangePass:0,mapFilterPass:0,signalPass:0,alertsSent:0,alreadyAlerted:0,noMarketUrl:0,rejects:[]};}function sample(arr,v,max=20){if(arr.length<max)arr.push(v)}function pushStageLog(diag,key,stage,extra={}){sample(diag.rejects,{reason:stage,matchId:key,...extra},20)}function mapMarginPass(info){if(!CFG.requireMapMargin&&!Number.isFinite(info?.marginValue))return true;if(!Number.isFinite(info?.marginValue))return false;/* Ignore 0-0, 1-0 and 0-1; analysis starts at a 2-round minimum margin. */return info.marginValue>=CFG.minMapMargin&&Number.isFinite(info.marginRatio)&&info.marginRatio>=CFG.minMapMarginRatio;}
async function assertCurrentRun(){const runId=String(process.env.GITHUB_RUN_ID||""),sha=String(process.env.GITHUB_SHA||"");if(!runId||!sha)return;const r=await fetch("https://api.github.com/repos/"+GH_REPO+"/actions/runs/"+runId,{headers:{accept:"application/vnd.github+json",authorization:"Bearer "+GH_TOKEN,"x-github-api-version":"2022-11-28"},signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error("RUN_GUARD_HTTP_"+r.status);const j=await r.json();if(String(j.head_sha||"")!==sha||String(j.status||"")!=="in_progress")throw new Error("STALE_RUN_BLOCKED");}
async function telegram(text){const r=await fetch("https://api.telegram.org/bot"+TG_TOKEN+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:"HTML",disable_web_page_preview:false}),signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error("TELEGRAM_HTTP_"+r.status);}
async function claimAlertStrict(key,meta={}){const path="state/esports-alert-dedupe.json",apiFor=p=>"https://api.github.com/repos/"+GH_REPO+"/contents/"+p,headers={accept:"application/vnd.github+json",authorization:"Bearer "+GH_TOKEN,"x-github-api-version":"2022-11-28"},canonicalKey="ESPORTS_MAP1:"+String(meta.matchId||key).replace(/^.*:/,"");for(let attempt=1;attempt<=7;attempt++){const rr=await fetch(apiFor(path),{headers,signal:AbortSignal.timeout(5000)}),j=rr.status===404?{sha:null,content:null}:await rr.json();if(!rr.ok&&rr.status!==404)throw new Error("DEDUPE_READ_HTTP_"+rr.status);const data=j.content?JSON.parse(Buffer.from(j.content.replace(/\n/g,""),"base64").toString("utf8")):{version:2,alerts:{}};data.alerts||={};const existing=data.alerts[canonicalKey];if(existing?.sentAt)return false;data.alerts[canonicalKey]={claimedAt:new Date().toISOString(),runId:process.env.GITHUB_RUN_ID||null,matchId:String(meta.matchId||""),teamA:meta.teamA||null,teamB:meta.teamB||null,sentAt:null};const body={message:"Claim esports Map 1 alert "+canonicalKey,content:Buffer.from(JSON.stringify(data,null,2)+"\n").toString("base64"),branch:"main"};if(j.sha)body.sha=j.sha;const w=await fetch(apiFor(path),{method:"PUT",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});if(w.ok)return true;if(w.status===409||w.status===422){await sleep(250*attempt);continue;}throw new Error("DEDUPE_WRITE_HTTP_"+w.status);}throw new Error("STRICT_DEDUPE_UNAVAILABLE");}
async function markAlertSent(key){const path="state/esports-alert-dedupe.json",apiFor=p=>"https://api.github.com/repos/"+GH_REPO+"/contents/"+p,headers={accept:"application/vnd.github+json",authorization:"Bearer "+GH_TOKEN,"x-github-api-version":"2022-11-28"},canonicalKey="ESPORTS_MAP1:"+String(key).replace(/^.*:/,"");for(let attempt=1;attempt<=7;attempt++){const rr=await fetch(apiFor(path),{headers,signal:AbortSignal.timeout(5000)}),j=rr.status===404?{sha:null,content:null}:await rr.json();if(!rr.ok&&rr.status!==404)throw new Error("DEDUPE_READ_HTTP_"+rr.status);const data=j.content?JSON.parse(Buffer.from(j.content.replace(/\n/g,""),"base64").toString("utf8")):{version:2,alerts:{}};data.alerts||={};if(!data.alerts[canonicalKey])data.alerts[canonicalKey]={};data.alerts[canonicalKey].sentAt=new Date().toISOString();data.alerts[canonicalKey].sentRunId=process.env.GITHUB_RUN_ID||null;const body={message:"Confirm Telegram delivery "+canonicalKey,content:Buffer.from(JSON.stringify(data,null,2)+"\n").toString("base64"),branch:"main"};if(j.sha)body.sha=j.sha;const w=await fetch(apiFor(path),{method:"PUT",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});if(w.ok)return true;if(w.status===409||w.status===422){await sleep(250*attempt);continue;}throw new Error("DEDUPE_CONFIRM_HTTP_"+w.status);}throw new Error("DEDUPE_CONFIRM_UNAVAILABLE");}
async function runPoll(state){const diag=diagInit();const safe=async(label,fn)=>{try{return await fn();}catch(e){log("SOURCE_ERROR",{source:label,error:String(e)});return[];}};
  const[upcomingMatches,runningMatches,polyEvents,lives]=await Promise.all([safe("PANDASCORE_UPCOMING",()=>psPaged("/matches/upcoming",5)),safe("PANDASCORE_RUNNING",()=>psPaged("/matches/running",3)),safe("POLYMARKET_EVENTS",loadPolyEvents),safe("PANDASCORE_LIVES",psLives)]);
  diag.livesFetched=Array.isArray(lives)?lives.length:0;rememberLiveScores(state,lives,diag);await collectLiveFrames(lives,state,diag);diag.sourceErrors=telemetry.byEvent.SOURCE_ERROR||0;const all=[...new Map([...upcomingMatches,...runningMatches].filter(x=>x?.id!=null).map(x=>[String(x.id),x])).values()];const candidates=all.filter(supportedSeries);diag.events=all.length;diag.candidates=candidates.length;const prioritizedCandidates=[...candidates].sort((a,b)=>{const score=m=>{const status=String(m?.status||"").toLowerCase(),t=beginAt(m);if(["running","live","in_progress"].includes(status))return 0;if(t!=null&&t<=Date.now())return 1;const games=Array.isArray(m?.games)?m.games:[];if(games.some(gameFinished))return 2;return 3;};return score(a)-score(b);});for(const match of prioritizedCandidates){const ts=beginAt(match);if(ts!=null&&ts>Date.now()+CFG.maxUpcomingHours*3600000)continue;const tt=teams(match);if(tt.length!==2)continue;const[teamA,teamB]=tt;const candidatesPoly=[];for(const e of polyEvents){const et=eventTeams(e);if(et.length>=2){const s=Math.max(nameScore(et[0],teamA)+nameScore(et[1],teamB),nameScore(et[0],teamB)+nameScore(et[1],teamA));if(s>=1.25)candidatesPoly.push({event:e,score:s});}}candidatesPoly.sort((a,b)=>b.score-a.score);let poly=null;for(const pc of candidatesPoly.slice(0,2)){diag.polyHydrateAttempts++;poly=await hydratePolyEvent(pc,teamA,teamB);if(poly){diag.polyFastMatched++;break;}}if(!poly&&candidatesPoly.length===0){diag.polySearchCalls++;const found=await searchPolyForMatch(teamA,teamB);for(const e of found.slice(0,2)){diag.polyHydrateAttempts++;poly=await hydratePolyEvent({event:e},teamA,teamB);if(poly)break;}}if(!poly)continue;diag.matchedPoly++;const key=String(match.id);state.matches||={};const entry=state.matches[key]||={matchId:key,teamA,teamB};const pre=await ensurePrematchBaseline(match,poly,entry);if(!pre)continue;let info=null;try{info=await map1InfoAsync(mergeCachedLiveScores(mergeLiveIntoMatch(match,lives),state),diag)}catch(e){log("MATCH_SCORE_ERROR",{matchId:key,error:String(e)});continue}if(!info){const hr=await hltvResultsFallback(teamA,teamB,diag);if(hr)info={winner:hr.score[0]>hr.score[1]?0:1,loser:hr.score[0]>hr.score[1]?1:0,series:hr.score,margin:hr.score,marginValue:hr.marginValue,marginRatio:hr.marginRatio,source:hr.source};}if(!info){const b=await bo3Map1Fallback(teamA,teamB,diag);if(b)info={winner:b.score[0]>b.score[1]?0:1,loser:b.score[0]>b.score[1]?1:0,series:b.score,margin:b.score,marginValue:b.marginValue,marginRatio:b.marginRatio,source:b.source};}if(!info){const h=await hltvMap1Fallback(teamA,teamB,diag);if(h)info={winner:h.score[0]>h.score[1]?0:1,loser:h.score[0]>h.score[1]?1:0,series:h.score,margin:h.score,marginValue:h.marginValue,marginRatio:h.marginRatio,source:h.source};}if(!info)continue;let prices=null;try{prices=await marketPrices(poly)}catch(e){log("MARKET_PRICE_ERROR",{matchId:key,error:String(e)})}if(!prices)continue;diag.signalChecks++;const sides=identifySides(prices,teamA,teamB),preFav=Math.max(pre.a,pre.b),balancedPre=preFav>=CFG.minPreFavorite&&preFav<=CFG.maxPreFavorite,winnerProb=info.winner===0?sides.a.prob:sides.b.prob,loserProb=info.loser===0?sides.a.prob:sides.b.prob,preWinner=info.winner===0?pre.a:pre.b,move=winnerProb-preWinner,overshoot=winnerProb>=CFG.minPostFavorite&&winnerProb<=CFG.maxPostFavorite,mapFilter=mapMarginPass(info);if(balancedPre)diag.balancedPrePass++;if(move>=CFG.minMove)diag.movePass++;if(overshoot)diag.postRangePass++;if(mapFilter)diag.mapFilterPass++;const fallbackSignal=false;if((balancedPre&&move>=CFG.minMove&&overshoot&&mapFilter)){diag.signalPass++;const loser=info.loser===0?teamA:teamB,marginText=String(info.marginValue);const text="<b>ESPORTS — MAP 2</b>\n\n<b>"+(info.winner===0?teamA:teamB)+"</b> won Map 1 vs <b>"+loser+"</b>\nMAP 1 SCORE: "+info.series[0]+"–"+info.series[1]+"\nMAP MARGIN: "+marginText+"\n\nPRE-MATCH\n"+teamA+": "+Math.round(pre.a*100)+"%\n"+teamB+": "+Math.round(pre.b*100)+"%\n\nAFTER MAP 1\n"+teamA+": "+Math.round(sides.a.prob*100)+"%\n"+teamB+": "+Math.round(sides.b.prob*100)+"%\n\nMOVE: +"+Math.round(move*100)+" pp\nNEXT MAP CANDIDATE: <b>"+loser+"</b>\nCURRENT: "+Math.round(loserProb*100)+"%";const eventSlug=String(poly.event?.slug||"").trim(),explicitMarketUrl=String(poly.market?.url||"").trim(),marketUrl=eventSlug?"https://polymarket.com/event/"+encodeURIComponent(eventSlug):explicitMarketUrl;if(!marketUrl)continue;const claimed=await claimAlertStrict("ESPORTS_MAP1:"+key,{matchId:key,teamA,teamB});if(!claimed){diag.alreadyAlerted++;continue;}await assertCurrentRun();try{await telegram(text+"\n\n"+marketUrl);await markAlertSent(key);diag.alertsSent++;entry.alerted=true;}catch(e){log("TELEGRAM_SEND_ERROR",{matchId:key,error:String(e)});delete state.matches[key].alerted;continue;}entry.alertedAt=new Date().toISOString();state.alerts||=[];state.alerts.push({matchId:key,teamA,teamB,move,at:entry.alertedAt});state.alerts=state.alerts.slice(-500);}}state.updatedAt=new Date().toISOString();state.stage="POLL_RESULT";state.runId=String(process.env.GITHUB_RUN_ID||"");state.sha=String(process.env.GITHUB_SHA||"");state.telemetry={...telemetry};state.diagnostics=diag;saveState(state);await publishState(state);telemetry.polls++;await publishHeartbeat("POLL_RESULT",{diagnostics:diag,config:CFG});}
function loadState(){try{const p="state/esports-live.json";if(!fs.existsSync(p))return{version:2,matches:{},alerts:[],liveScores:{}};const s=JSON.parse(fs.readFileSync(p,"utf8"));return{version:2,matches:s?.matches&&typeof s?.matches==="object"?s.matches:{},alerts:Array.isArray(s?.alerts)?s.alerts:[],liveScores:s?.liveScores&&typeof s?.liveScores==="object"?s.liveScores:{}};}catch{return{version:2,matches:{},alerts:[],liveScores:{}};}}const state=loadState();function saveState(s){fs.mkdirSync("state",{recursive:true});fs.writeFileSync("state/esports-live.json",JSON.stringify(s,null,2)+"\n");}async function publishHeartbeat(event,data){log(event,data);try{const now=Date.now();if(now-lastRemotePushAt<5000)return;lastRemotePushAt=now;}catch{}}
async function publishState(state){if(!GH_TOKEN)return;try{const path="state/esports-live.json",url="https://api.github.com/repos/"+GH_REPO+"/contents/"+path,headers={accept:"application/vnd.github+json",authorization:"Bearer "+GH_TOKEN,"x-github-api-version":"2022-11-28"};const r=await fetch(url,{headers,signal:AbortSignal.timeout(5000)});const j=r.status===404?{}:await r.json();const body={message:"Update esports monitor state",content:Buffer.from(JSON.stringify(state,null,2)+"\n").toString("base64"),branch:"main"};if(j.sha)body.sha=j.sha;const w=await fetch(url,{method:"PUT",headers:{...headers,"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(5000)});if(!w.ok)throw new Error("STATE_WRITE_HTTP_"+w.status);}catch(e){nativeConsoleLog("STATE_WRITE_ERROR",JSON.stringify({error:String(e)}));}}
async function main(){log("MONITOR_STARTING",{source:"PandaScore + Polymarket",mode:"continuous"});const startedAt=Date.now();while(Date.now()-startedAt<350*60*1000){try{await runPoll(state);}catch(e){log("POLL_ERROR",{error:String(e),stack:e?.stack});}await sleep(60000);}log("MONITOR_FINISHED",{alerts:state.alerts.length});}main().catch(e=>{log("POLL_ERROR",{error:String(e),stack:e?.stack});process.exitCode=1;});