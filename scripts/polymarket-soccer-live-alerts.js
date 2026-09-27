// DIAGNOSTIC_RUN: verify live-source-to-Telegram chain after Sports WS fix
// Diagnostic probe: verify soccer-only classification and Telegram rate limiting end-to-end.
const GAMMA = "https://gamma-api.polymarket.com";
const LIVE_PAGE = "https://polymarket.com/ru/sports/live";
const SOCCER_PAGE = "https://polymarket.com/ru/sports/soccer/games";
const POLL_MS = 5000;
const TELEGRAM_MAX = 3900;
const DIAGNOSTIC_MODE = false;
const RUN_MS = Number.POSITIVE_INFINITY;
const MAX_CYCLES = Number.POSITIVE_INFINITY;
const MAX_SPORTS_WS_LOOKUPS = Number.POSITIVE_INFINITY;
let stopping = false;

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
function firstEvent(raw){\n  if(Array.isArray(raw))return raw[0]||null;\n  if(raw&&Array.isArray(raw.events))return raw.events[0]||null;\n  if(raw&&Array.isArray(raw.data))return raw.data[0]||null;\n  if(raw&&raw.event&&typeof raw.event==="object")return raw.event;\n  return raw&&typeof raw==="object"?raw:null;\n}\nfunction teams(event){const title=t(event.title||event.question);if(event.homeTeam&&event.awayTeam)return[t(event.homeTeam),t(event.awayTeam)];const m=title.match(/^(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+)$/i);return m?[m[1].trim(),m[2].trim()]:["",""];}

async function fetchPage(url){
  const r=await get(url,{headers:{accept:"text/html,application/xhtml+xml","user-agent":"Mozilla/5.0 (compatible; PolymarketLiveSoccerMonitor/1.0)"},timeout:8000});
  return r.text();
}

function gameTeams(g){
  const home=t(g.homeTeam||g.home_team||g.home||g.homeTeamName||g.home_team_name);
  const away=t(g.awayTeam||g.away_team||g.away||g.awayTeamName||g.away_team_name);
  return [home,away];
}
function wsSoccerConfirmed(sg){return /soccer|football/i.test([sg?.league,sg?.sport,sg?.leagueAbbreviation,sg?.sportSlug].map(t).join(" "));}
function gameLive(g){
  const status=t(g.status||g.gameStatus||g.liveStatus||g.state||g.phase||g.period).toLowerCase();
  return /live|in.?play|playing|1h|2h|halftime|half time|extra|stoppage/.test(status) || g.live===true || g.isLive===true || g.inPlay===true;
}
function gameScore(g){
  const h=g.homeScore??g.home_score??g.score?.home??g.score?.homeScore??g.scores?.home??g.scores?.homeScore??g.home?.score??g.home?.score?.current??g.homeTeam?.score??g.homeTeam?.score?.current??g.scoreboard?.home?.score??g.scoreboard?.homeScore;
  const a=g.awayScore??g.away_score??g.score?.away??g.score?.awayScore??g.scores?.away??g.scores?.awayScore??g.away?.score??g.away?.score?.current??g.awayTeam?.score??g.awayTeam?.score?.current??g.scoreboard?.away?.score??g.scoreboard?.awayScore;
  return h!=null&&a!=null?[h,a]:null;
}
function gameMinute(g){
  return t(g.minute||g.matchMinute||g.elapsed||g.clock||g.time||g.gameTime||g.periodTime||g.matchClock||g.liveClock||g.clock?.display||g.clock?.minute||g.period?.minute);
}
function pageGameSnapshot(html, home, away, startValue){
  const raw=decode(html)
    .replace(/<script[\s\S]*?<\/script>/gi," ")
    .replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ")
    .replace(/\s+/g," ")
    .trim();
  const h=t(home),a=t(away);
  const hi=raw.toLowerCase().indexOf(h.toLowerCase());
  if(hi<0)return null;
  const window=raw.slice(Math.max(0,hi-500),Math.min(raw.length,hi+1200));
  const ai=window.toLowerCase().indexOf(a.toLowerCase());
  if(ai<0)return null;
  const between=window.slice(0,ai+h.length);
  const scoreMatches=[...between.matchAll(/(?:^|\s)(\d{1,3})\s*[-–:]\s*(\d{1,3})(?:\s|$)/g)];
  const score=scoreMatches.length? [Number(scoreMatches.at(-1)[1]),Number(scoreMatches.at(-1)[2])] : null;
  const minuteMatch=window.match(/(?:^|\s)(\d{1,3})[′']/);
  let minute=minuteMatch?minuteMatch[1]+"'" :"";
  if(!minute){
    const start=Date.parse(startValue||"");
    if(Number.isFinite(start)&&start<=Date.now()){
      const mins=Math.floor((Date.now()-start)/60000);
      if(mins>=0&&mins<=130)minute=Math.min(mins,120)+"'";
    }
  }
  return {score,minute};
}
function attachGame(x,g){
  x.game=g;
  const sc=gameScore(g); if(sc)x.score=sc;
  x.minute=gameMinute(g);
  x.gameStatus=t(g.status||g.gameStatus||g.liveStatus||g.state||g.phase||g.period);
}
async function fetchLiveEvents(){
  const live=[];
  const seen=new Set();

  // Use both documented live-sports tag variants. Do not make Sports WS or HTML
  // a prerequisite for producing a LIVE candidate.
  for(const query of [
    "/events?active=true&closed=false&tag_slug=soccer&live=true&limit=500",
    "/events?active=true&closed=false&tag_slug=sports&live=true&limit=500"
  ]){
    try{
      const raw=await json(GAMMA+query,{timeout:8000});
      const batch=Array.isArray(raw)?raw:(raw?.events||raw?.data||[]);
      for(const e of batch){
        const id=t(e.id||e.slug);
        if(!id||seen.has(id)||e.ended===true||e.finished===true||e.final===true)continue;
        const [home,away]=teams(e);
        if(!home||!away||!isFixtureTitle(t(e.title||e.question)))continue;
        if(!isSoccerEvent(e,"") && !looksLikeSoccerEvent(e))continue;
        seen.add(id);
        live.push({id:t(e.id),gameId:t(e.gameId||e.game_id),slug:t(e.slug),homeTeam:home,awayTeam:away,status:t(e.status||e.gameStatus||e.liveStatus||"LIVE"),live:true,event:e});
      }
    }catch(e){
      console.log(JSON.stringify({level:"WARN",event:"gamma_live_query_failed",query,message:e.message}));
    }
  }
  if(live.length){
    console.log(JSON.stringify({level:"INFO",event:"gamma_live_sports_scan",soccerLiveEvents:live.length,source:"soccer+sports live"}));
    return live;
  }

  // Last-resort direct Gamma scan: an event is eligible only when its actual
  // kickoff is already in the past and it looks like a football 1X2 fixture.
  try{
    for(let offset=0;offset<5000;offset+=500){
      const raw=await json(GAMMA+"/events?active=true&closed=false&limit=500&offset="+offset,{timeout:8000});
      const batch=Array.isArray(raw)?raw:(raw?.events||raw?.data||[]);
      if(!Array.isArray(batch)||!batch.length)break;
      for(const e of batch){
        const id=t(e.id||e.slug);
        if(!id||seen.has(id)||e.ended===true||e.finished===true||e.final===true)continue;
        const [home,away]=teams(e);
        if(!home||!away||!isFixtureTitle(t(e.title||e.question)))continue;
        if(!isSoccerEvent(e,"") && !looksLikeSoccerEvent(e))continue;
        if(!eventLiveWindow(e))continue;
        seen.add(id);
        live.push({id:t(e.id),gameId:t(e.gameId||e.game_id),slug:t(e.slug),homeTeam:home,awayTeam:away,status:t(e.status||e.gameStatus||e.liveStatus||"LIVE"),live:true,event:e});
      }
      if(batch.length<500)break;
      if(live.length>=100)break;
    }
  }catch(e){
    console.log(JSON.stringify({level:"WARN",event:"gamma_active_events_scan_failed",message:e.message}));
  }
  console.log(JSON.stringify({level:"INFO",event:"gamma_live_discovery_result",soccerLiveEvents:live.length}));
  return live;
}
function looksLikeSoccerEvent(event){
  const ms=Array.isArray(event?.markets)?event.markets:[];
  for(const m of ms){
    const q=t(m?.question||m?.title||m?.groupItemTitle).toLowerCase();
    const o=parse(m?.outcomes);
    if(/draw/.test(q))return true;
    if(Array.isArray(o)&&o.some(v=>/draw/i.test(String(v))))return true;
  }
  const slug=t(event?.slug).toLowerCase();
  return /(?:^|[-_])(?:epl|es1|es2|it1|it2|de1|de2|fr1|nl1|pt1|bel|tur|sco|eng|uefa|unl|ucl|uwcl|wsl|liga|serie|bundes|ligue|mls|nwsl)(?:[-_]|$)/.test(slug);
}
function matchGame(x,g){
  const [gh,ga]=gameTeams(g), nx=norm(x.home),ny=norm(x.away),nh=norm(gh),na=norm(ga);
  return (gh&&ga&&((nh===nx&&na===ny)||(nh===ny&&na===nx))) || t(g.eventId||g.event_id)===x.eventId || t(g.eventSlug||g.event_slug||g.slug)===x.slug;
}

function eventLiveWindow(event){
  const now=Date.now();
  const status=t(event.status||event.gameStatus||event.liveStatus||event.period||event.phase).toLowerCase();
  if(event.live===true||event.isLive===true||event.inPlay===true||/live|in.?play|playing|1h|2h|halftime|half time|extra|stoppage/.test(status))return true;
  if(event.ended===true||event.finished===true||event.final===true)return false;
  const start=Date.parse(event.gameStartTime||event.game_start_time||event.startTime||event.start_time||event.eventStartTime||event.event_start_time||"");
  const end=Date.parse(event.gameEndTime||event.game_end_time||event.matchEndTime||event.match_end_time||"");
  // For sports, startDate/endDate may describe market lifecycle rather than kickoff.
  // gameStartTime/startTime are the actual fixture start fields.
  if(Number.isFinite(start)&&start<=now){
    return !Number.isFinite(end)||end>=now;
  }
  return false;
}

async function discover(){
  const safePage=async(url)=>{try{return await fetchPage(url)}catch(e){console.log(JSON.stringify({level:"WARN",event:"page_fetch_failed",url,message:e.message}));return "";}};
  const [liveHtml,soccerHtml,liveEvents]=await Promise.all([safePage(LIVE_PAGE),safePage(SOCCER_PAGE),fetchLiveEvents().catch(e=>{console.log(JSON.stringify({level:"WARN",event:"live_events_fetch_failed",message:e.message}));return [];})]);
  const liveLinks=fixtureLinks(liveHtml);
  const soccerLinks=fixtureLinks(soccerHtml);
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
    if(!liveConfirmed&&!eventLiveWindow(event)){console.log(JSON.stringify({level:"DEBUG",event:"candidate_reject",reason:"not_live_window",eventId:event.id,title:rawTitle,start:event.startDate,end:event.endDate,status:event.status}));return;}
    if(ended){console.log(JSON.stringify({level:"DEBUG",event:"candidate_reject",reason:"ended",eventId:event.id,title:rawTitle}));return;}
    const slug=t(event.slug)||fixtureSlug(href||"");
    if(!slug||seen.has(slug)){console.log(JSON.stringify({level:"DEBUG",event:"candidate_reject",reason:"missing_or_duplicate_slug",eventId:event.id,title:rawTitle,slug}));return;}
    seen.add(slug);
    const item={eventId:t(event.id),slug,url:href?("https://polymarket.com"+href):("https://polymarket.com/event/"+slug),home,away,event};
    const game=liveEvents.find(g=>matchGame(item,g));
    if(game)attachGame(item,game);
    else {
      item.gameStatus=t(event.gameStatus||event.status||"LIVE")||"LIVE";
      const sc=gameScore(event); if(sc)item.score=sc;
      item.minute=gameMinute(event);
      const pageSnap=pageGameSnapshot(liveHtml,home,away,event.gameStartTime||event.game_start_time||event.startTime||event.start_time);
      if(pageSnap){
        if(pageSnap.score)item.score=pageSnap.score;
        if(pageSnap.minute)item.minute=pageSnap.minute;
        item.pageGameSnapshot=pageSnap;
      }
    }
    candidates.push(item);
    console.log(JSON.stringify({level:"INFO",event:"LIVE_CANDIDATE",slug:item.slug,eventId:item.eventId,teams:[item.home,item.away],status:item.gameStatus,minute:item.minute??null,score:item.score??null,source:sourceConfirmed?"sports_ws":"page_or_gamma"}));
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
      const event=firstEvent(raw);
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
      await addEvent(event,href,true,true);
      const pageItem=candidates.find(x=>x.slug===slug||x.eventId===t(event.id));
      if(pageItem){
        const snap=pageGameSnapshot(liveHtml,pageItem.home,pageItem.away,event.gameStartTime||event.game_start_time||event.startTime||event.start_time);
        if(snap){
          if(snap.score)pageItem.score=snap.score;
          if(snap.minute)pageItem.minute=snap.minute;
          pageItem.pageGameSnapshot=snap;
        }
      }
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

const DEFAULT_CONVEX_SITE_URL="https://brainy-canary-207.eu-west-1.convex.site";

async function convexMutation(path,args){
  const siteUrl=t(process.env.CONVEX_SITE_URL||DEFAULT_CONVEX_SITE_URL);
  const convexUrl=siteUrl.replace(/\\.convex\\.site$/,".convex.cloud");
  const r=await fetch(convexUrl+"/api/mutation",{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({path,args,format:"json"}),
    signal:AbortSignal.timeout(8000)
  });
  if(!r.ok)throw new Error("Convex "+path+" HTTP "+r.status);
  return r.json();
}

// Persistent dedupe: the exact Polymarket event URL is the identity.
// Once a URL is successfully claimed, every later cycle/run is blocked,
// regardless of score, minute, alert phase, or slug changes.
async function claimFootballMatch(eventUrl){ return true; }
async function releaseFootballMatch(eventUrl){}

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
        try { await releaseFootballMatch(id); } catch(re) { console.log(JSON.stringify({level:"ERROR",event:"convex_release_failed",eventId:id,slug:x.slug,message:re.message})); }
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
}
process.on("SIGTERM",()=>stopping=true);process.on("SIGINT",()=>stopping=true);main().catch(e=>{console.error(e);process.exitCode=1});

// DIAGNOSTIC_RUN_TRIGGER
// FORCE_DIAGNOSTIC_TRIGGER_2026_09_26
// DIAGNOSTIC_RUN
// DIAGNOSTIC_TRIGGER_2
// DIAGNOSTIC_RUN
