// DIAGNOSTIC_RUN: verify live-source-to-Telegram chain after Sports WS fix
const GAMMA = "https://gamma-api.polymarket.com";
const LIVE_PAGE = "https://polymarket.com/ru/sports/live";
const SOCCER_PAGE = "https://polymarket.com/ru/sports/soccer/games";
const POLL_MS = 5000;
const TELEGRAM_MAX = 3900;
const DIAGNOSTIC_MODE = process.env.MONITOR_MODE === "diagnostic";
const RUN_MS = DIAGNOSTIC_MODE ? 90 * 1000 : 4 * 60 * 60 * 1000;
const MAX_CYCLES = DIAGNOSTIC_MODE ? 2 : Number.POSITIVE_INFINITY;
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
function fixtureLinks(html){return hrefs(html).filter(h=>/^\/(?:ru\/)?sports\/[^?#]+$/i.test(h));}
function isFixtureTitle(x){return /\s(?:vs\.?|v\.?|versus)\s/i.test(t(x))&&!/\s-\s(?:more markets|player props?|total|first team|last team|exact score|half|second half|match result|winner|moneyline)/i.test(t(x));}
function isSoccerEvent(event,href=""){
  const h=t(href).toLowerCase();
  if(/\/sports\/soccer\//i.test(h))return true;
  const values=[];
  for(const k of ["sport","sports","category","subcategory","league","sportSlug","sport_slug","tagSlug","tag_slug","seriesSlug","series_slug","eventType","event_type","gameType","game_type"])values.push(event?.[k]);
  const tags=Array.isArray(event?.tags)?event.tags:parse(event?.tags);
  if(Array.isArray(tags))for(const z of tags)values.push(typeof z==="string"?z:(z?.slug||z?.label||z?.name));
  if(values.filter(Boolean).some(v=>/soccer|football/i.test(String(v))))return true;
  const slug=t(event?.slug||event?.eventSlug||event?.event_slug).toLowerCase();
  if(/(^|[-_])(soccer|football)([-_]|$)/.test(slug))return true;
  const title=t(event?.title||event?.question);
  if(!/\s(?:vs\.?|v\.?|versus)\s/i.test(title))return false;
  const markets=Array.isArray(event?.markets)?event.markets:[];
  const text=markets.map(m=>t(m?.question||m?.title||m?.groupItemTitle)).join(" ").toLowerCase();
  return /\b1x2\b|\bdraw\b|both teams to score|\bbtts\b|total corners|correct score|win to nil|double chance/.test(text);
}
function teams(event){const title=t(event.title||event.question);if(event.homeTeam&&event.awayTeam)return[t(event.homeTeam),t(event.awayTeam)];const m=title.match(/^(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+)$/i);return m?[m[1].trim(),m[2].trim()]:["",""];}

async function fetchPage(url){
  const r=await get(url,{headers:{accept:"text/html,application/xhtml+xml","user-agent":"Mozilla/5.0 (compatible; PolymarketLiveSoccerMonitor/1.0)"},timeout:8000});
  return r.text();
}

function gameTeams(g){
  const home=t(g.homeTeam||g.home_team||g.home||g.homeTeamName||g.home_team_name);
  const away=t(g.awayTeam||g.away_team||g.away||g.awayTeamName||g.away_team_name);
  return [home,away];
}
function wsSoccerConfirmed(sg){return /soccer|football/i.test(t(sg?.league)||t(sg?.sport)||t(sg?.leagueAbbreviation)||t(sg?.sportSlug)) || !!sg?.gameId;}
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
function attachGame(x,g){
  x.game=g;
  const sc=gameScore(g); if(sc)x.score=sc;
  x.minute=gameMinute(g);
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
      timer=setTimeout(()=>{try{ws.close()}catch{};resolve(live)},25000);
      ws.onopen=()=>console.log(JSON.stringify({level:"INFO",event:"sports_ws_open"}));
      ws.onerror=(e)=>console.log(JSON.stringify({level:"WARN",event:"sports_ws_error",message:String(e?.message||"websocket error")}));
      ws.onclose=(e)=>{console.log(JSON.stringify({level:"INFO",event:"sports_ws_close",code:e?.code??null}));clearTimeout(timer);resolve(live)};
      ws.onmessage=(ev)=>{
        const raw=typeof ev.data==="string"?ev.data:"";
        if(raw==="ping"){try{ws.send("pong")}catch{};return;}
        let m; try{m=JSON.parse(raw)}catch{return;}
        const type=t(m?.type||m?.event_type);
        const p=m?.payload&&typeof m.payload==="object"?m.payload:m;
        const league=t(p?.leagueAbbreviation||p?.league||p?.sport||p?.sportSlug).toLowerCase();
        const status=t(p?.status||p?.gameStatus||p?.state).toLowerCase();
        const liveFlag=p?.live===true||p?.isLive===true||/inprogress|in.?play|playing|break|halftime|penaltyshootout/.test(status);
        if(type&&type!=="sport_result"&&!liveFlag)return;
        if(!/soccer|football/.test(league)&&!String(p?.slug||"").match(/^(?:soccer|football)-/i))return;
        if(p?.ended===true||/final|finished|cancel|postponed|awarded/.test(status))return;
        if(!liveFlag)return;
        const gameId=t(p?.gameId||p?.id);
        const slug=t(p?.slug);
        const home=t(p?.homeTeam||p?.home_team||p?.home);
        const away=t(p?.awayTeam||p?.away_team||p?.away);
        if(!gameId&&!slug||!home||!away)return;
        const key=gameId||slug;
        if(seen.has(key))return;
        seen.add(key);
        let score=null;
        const s=p?.score;
        if(typeof s==="string"){
          const mm=s.match(/^(\d+)\s*[-–:]\s*(\d+)/); if(mm)score=[Number(mm[1]),Number(mm[2])];
        } else if(s&&typeof s==="object"){
          const h=s.home??s.homeScore??s.home_score, a=s.away??s.awayScore??s.away_score;
          if(h!=null&&a!=null)score=[h,a];
        }
        live.push({gameId,slug,home,away,status:p?.status||"InProgress",period:t(p?.period),elapsed:t(p?.elapsed),score});
      };
    }catch(e){
      clearTimeout(timer); console.log(JSON.stringify({level:"WARN",event:"sports_ws_init_failed",message:e.message}));resolve(live);
    }
  });
}

async function fetchLiveEvents(){
  const all=[];
  for(let offset=0;offset<2000;offset+=500){
    try{
      const raw=await json(GAMMA+"/events?active=true&closed=false&limit=500&offset="+offset,{timeout:8000});
      const batch=Array.isArray(raw)?raw:(raw?.events||raw?.data||[]);
      if(!Array.isArray(batch)||batch.length===0)break;
      all.push(...batch);
      if(batch.length<500)break;
    }catch(e){
      console.log(JSON.stringify({level:"WARN",event:"events_load_failed",offset,message:e.message}));
      break;
    }
  }
  const seen=new Set();
  const live=[];
  for(const e of all){
    const id=t(e.id||e.slug);
    if(!id||seen.has(id)||!isSoccerEvent(e,""))continue;
    seen.add(id);
    if(!eventLiveWindow(e))continue;
    const [home,away]=teams(e);
    if(!home||!away)continue;
    live.push({
      id:t(e.id),gameId:t(e.gameId||e.game_id),slug:t(e.slug),
      homeTeam:home,awayTeam:away,
      status:t(e.status||e.gameStatus||e.liveStatus||"LIVE"),
      live:true,event:e
    });
  }
  console.log(JSON.stringify({level:"INFO",event:"gamma_active_events_scan",activeEvents:all.length,soccerLiveEvents:live.length}));
  return live;
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
  const [liveHtml,soccerHtml,liveEvents]=await Promise.all([fetchPage(LIVE_PAGE),fetchPage(SOCCER_PAGE),fetchLiveEvents()]);
  const liveLinks=fixtureLinks(liveHtml);
  const soccerLinks=fixtureLinks(soccerHtml);
  const sportsLive=await fetchLiveSports();
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
    }
    candidates.push(item);
    console.log(JSON.stringify({level:"INFO",event:"LIVE_CANDIDATE",slug:item.slug,eventId:item.eventId,teams:[item.home,item.away],status:item.gameStatus,minute:item.minute??null,score:item.score??null,source:sourceConfirmed?"sports_ws":"page_or_gamma"}));
  }

  // Primary live source: Polymarket Sports WebSocket. It provides actual kickoff/status/score.
  for(const sg of sportsLive){
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
        await addEvent(event,null,true,true);
        const item=candidates.find(x=>x.eventId===t(event.id)||x.slug===t(event.slug));
        if(item){
          item.gameStatus=sg.status||"InProgress";
          item.minute=sg.elapsed||sg.period||item.minute;
          if(sg.score)item.score=sg.score;
          item.sportsGame=sg;
        }
      } else if(sg.gameId){
        try{
          const ms=await json(GAMMA+"/markets?game_id="+encodeURIComponent(sg.gameId)+"&active=true&closed=false&limit=100",{timeout:5000});
          const markets=Array.isArray(ms)?ms:(ms?.data||[]);
          const eventId=t(markets[0]?.eventId||markets[0]?.event_id);
          if(eventId){
            const er=await json(GAMMA+"/events/"+encodeURIComponent(eventId),{timeout:5000});
            const event2=er?.event||er;
            if(event2){
              console.log(JSON.stringify({level:"INFO",event:"GAMMA_MATCH_FOUND_BY_GAME_ID",gameId:sg.gameId,eventId:eventId,title:event2?.title||event2?.question,markets:markets.length}));
              await addEvent(event2,null,true,true);
              const item=candidates.find(x=>x.eventId===eventId||x.slug===t(event2.slug));
              if(item){item.gameStatus=sg.status||"InProgress";item.minute=sg.elapsed||sg.period||item.minute;if(sg.score)item.score=sg.score;item.sportsGame=sg;}
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

  // Secondary authoritative source: active Gamma /events. It is accepted only after
  // local soccer classification and the actual fixture LIVE-window check.
  for(const g of liveEvents){
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

  // Do NOT treat raw HTML from the live page as proof that a match has started.
  // The page is retained for diagnostics/linking only; actual LIVE status must come
  // from Sports WS or an explicit live=true/status=live game record.
  console.log(JSON.stringify({level:"INFO",event:"live_page_not_used_as_live_gate",links:liveLinks.length}));

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
  const vals=r.outcomes.map((o,i)=>{
    const p=Number.isFinite(r.prices[i])?pct(r.prices[i]):"—";
    return o+": "+p;
  }).join(" · ");
  const meta=["VOL "+money(r.volume),"LIQ "+money(r.liquidity)].join(" · ");
  return "• "+(r.question||r.group||"Market")+"\\n  "+vals+"\\n  "+meta;
}
function splitPages(header,rows,maxLen=TELEGRAM_MAX){
  const pages=[];let current=header;
  for(const row of rows){
    const block=marketText(row);
    if(current.length+2+block.length>maxLen&&current!==header){pages.push(current);current=header+"\\n\\n"+block;}
    else current+="\\n\\n"+block;
  }
  if(current!==header||pages.length===0)pages.push(current);
  return pages;
}
function buildAlertPages(x){
  const e=x.event,rows=marketRows(e);
  const sh=x.score?.[0]??e.homeScore??e.home_score??e.score?.home??null;
  const sa=x.score?.[1]??e.awayScore??e.away_score??e.score?.away??null;
  const status=x.gameStatus||t(e.status||e.gameStatus||e.liveStatus||"LIVE");
  const start=t(e.startDate||e.start_date||e.startTime);
  const eventVolume=Number(e.volumeNum??e.volume??e.volume24hr??0);
  const eventLiquidity=Number(e.liquidityNum??e.liquidity??0);
  const totalVolume=rows.reduce((a,r)=>a+r.volume,0);
  const totalLiquidity=rows.reduce((a,r)=>a+r.liquidity,0);
  const header=["⚽ LIVE FOUND","",x.home+" vs "+x.away,status?"STATUS: "+status:"STATUS: LIVE",
    x.minute?"MINUTE: "+x.minute:"MINUTE: —",
    sh!=null&&sa!=null?"SCORE: "+sh+"–"+sa:"SCORE: —",
    start?"START: "+start:"START: —",
    "EVENT VOLUME: "+money(eventVolume||totalVolume),
    "EVENT LIQUIDITY: "+money(eventLiquidity||totalLiquidity),
    "",
    "ALL ACTIVE MARKETS ("+rows.length+")"].join("\n");
  return splitPages(header,rows);
}
async function sendTelegram(message,replyMarkup){
  const token=process.env.TELEGRAM_BOT_TOKEN||"",chat=process.env.TELEGRAM_CHAT_ID||"";
  if(!token||!chat)throw new Error("Telegram credentials are missing");
  const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:chat,text:message,disable_web_page_preview:false,reply_markup:replyMarkup}),
    signal:AbortSignal.timeout(10000)
  });
  if(!r.ok)throw new Error("Telegram HTTP "+r.status);
  const b=await r.json();if(!b.ok)throw new Error("Telegram rejected message");
  return b;
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

async function claimFootballMatch(slug){
  const b=await convexMutation("btc5mState:claimFootballMatch",{marketSlug:slug});
  return b && b.value && b.value.allowed===true;
}

async function releaseFootballMatch(slug){
  await convexMutation("btc5mState:releaseFootballMatch",{marketSlug:slug});
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
    const byId=await json(GAMMA+"/events/"+encodeURIComponent(x.eventId),{timeout:5000});
    fresh=byId?.event||byId;
  }
  if(fresh)x.event=fresh;
  try{
    const all=[];
    for(let offset=0;offset<1000;offset+=100){
      const ms=await json(GAMMA+"/markets?event_id="+encodeURIComponent(x.eventId)+"&active=true&closed=false&limit=100&offset="+offset,{timeout:7000});
      const batch=Array.isArray(ms)?ms:(ms?.data||[]);
      if(!Array.isArray(batch)||batch.length===0)break;
      all.push(...batch);
      if(batch.length<100)break;
    }
    if(all.length)x.event.markets=all;
  }catch(e){console.log(JSON.stringify({level:"WARN",event:"markets_load_failed",eventId:x.eventId,slug:x.slug,message:e.message}));}
  return x.event;
}
async function cycle(){
  const candidates=await discover();
  console.log(JSON.stringify({level:"INFO",event:"CYCLE_CANDIDATES",count:candidates.length}));
  for(const x of candidates){
    if(stopping)break;
    const id=x.slug||x.eventId;if(alerted.has(id)||alerting.has(id))continue;
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
          const label="📄 "+(i+1)+"/"+pages.length;
          const replyMarkup={inline_keyboard:[
            [{text:"➡️ OPEN MATCH",url:x.url}],
            [{text:"🌐 POLYMARKET LIVE",url:LIVE_PAGE}]
          ]};
          await sendTelegram(label+"\\n\\n"+pages[i],replyMarkup);
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
// DIAGNOSTIC_RUN
