const GAMMA = "https://gamma-api.polymarket.com";
const LIVE_PAGE = "https://polymarket.com/ru/sports/live";
const SOCCER_PAGE = "https://polymarket.com/ru/sports/soccer/games";
const GAMES = GAMMA + "/games";
const POLL_MS = 5000;
const TELEGRAM_MAX = 3900;
const RUN_MS = 4 * 60 * 60 * 1000;
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
function fixtureLinks(html){return hrefs(html).filter(h=>/^\/sports\/[^/]+\/[^/]+$/i.test(h));}
function isFixtureTitle(x){return /\s(?:vs\.?|v\.?|versus)\s/i.test(t(x))&&!/\s-\s(?:more markets|player props?|total|first team|last team|exact score|half|second half|match result|winner|moneyline)/i.test(t(x));}
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
function gameLive(g){
  const status=t(g.status||g.gameStatus||g.liveStatus||g.state||g.phase||g.period).toLowerCase();
  return /live|in.?play|playing|1h|2h|halftime|half time|extra|stoppage/.test(status) || g.live===true || g.isLive===true || g.inPlay===true;
}
function gameScore(g){
  const h=g.homeScore??g.home_score??g.score?.home??g.home?.score??g.homeTeam?.score;
  const a=g.awayScore??g.away_score??g.score?.away??g.away?.score??g.awayTeam?.score;
  return h!=null&&a!=null?[h,a]:null;
}
function gameMinute(g){
  return t(g.minute||g.matchMinute||g.elapsed||g.clock||g.time||g.gameTime||g.periodTime);
}
function attachGame(x,g){
  x.game=g;
  const sc=gameScore(g); if(sc)x.score=sc;
  x.minute=gameMinute(g);
  x.gameStatus=t(g.status||g.gameStatus||g.liveStatus||g.state||g.phase||g.period);
}
async function fetchLiveGames(){
  const urls=[GAMES+"?live=true",GAMES+"?status=live",GAMES+"?active=true&sport=soccer"];
  const all=[];
  for(const u of urls){try{const raw=await json(u,{timeout:5000});const a=Array.isArray(raw)?raw:(raw?.games||raw?.data||[]);if(Array.isArray(a))all.push(...a);}catch(e){console.log(JSON.stringify({level:"WARN",event:"games_load_failed",message:e.message}));}}
  const seen=new Set(); return all.filter(g=>{const id=t(g.id||g.gameId||g.game_id||g.slug);if(!id||seen.has(id))return false;seen.add(id);return gameLive(g);});
}
function matchGame(x,g){
  const [gh,ga]=gameTeams(g), nx=norm(x.home),ny=norm(x.away),nh=norm(gh),na=norm(ga);
  return (gh&&ga&&((nh===nx&&na===ny)||(nh===ny&&na===nx))) || t(g.eventId||g.event_id)===x.eventId || t(g.eventSlug||g.event_slug||g.slug)===x.slug;
}

function eventLiveWindow(event){
  const now=Date.now();
  const status=t(event.status||event.gameStatus||event.liveStatus||event.period||event.phase).toLowerCase();
  if(event.live===true||event.isLive===true||event.inPlay===true||/live|in.?play|playing|1h|2h|halftime|half time|extra|stoppage/.test(status))return true;
  const start=Date.parse(event.startDate||event.start_date||event.startTime||event.gameStartTime||"");
  const end=Date.parse(event.endDate||event.end_date||event.endTime||"");
  return Number.isFinite(start)&&start<=now&&Number.isFinite(end)&&end>=now;
}

async function discover(){
  const [liveHtml,soccerHtml,games]=await Promise.all([fetchPage(LIVE_PAGE),fetchPage(SOCCER_PAGE),fetchLiveGames()]);
  const liveLinks=fixtureLinks(liveHtml);
  const soccerLinks=fixtureLinks(soccerHtml);
  const soccerHrefs=new Set(soccerLinks);
  const soccerSlugs=new Set(soccerLinks.map(fixtureSlug).filter(Boolean));
  const candidates=[],seen=new Set();

  async function addEvent(event,href,liveConfirmed=false){
    if(!event||!event.id)return;
    const [home,away]=teams(event);
    const end=Date.parse(event.endDate||event.end_date||event.endTime||"");
    if(!home||!away||!isFixtureTitle(event.title||event.question))return;
    if(!liveConfirmed&&!eventLiveWindow(event))return;
    if(Number.isFinite(end)&&end<Date.now())return;
    const slug=t(event.slug)||fixtureSlug(href||"");
    if(!slug||seen.has(slug))return;
    seen.add(slug);
    const item={eventId:t(event.id),slug,url:href?("https://polymarket.com"+href):("https://polymarket.com/event/"+slug),home,away,event};
    const game=games.find(g=>matchGame(item,g));
    if(game)attachGame(item,game);
    else {
      item.gameStatus=t(event.gameStatus||event.status||"LIVE")||"LIVE";
      const sc=gameScore(event); if(sc)item.score=sc;
      item.minute=gameMinute(event);
    }
    candidates.push(item);
  }

  // Primary gate: matches visible on Polymarket's live page and confirmed on soccer page.
  for(const href of liveLinks){
    const slug=fixtureSlug(href);
    if(!slug||(!soccerHrefs.has(href)&&!soccerSlugs.has(slug)))continue;
    try{
      const raw=await json(GAMMA+"/events?slug="+encodeURIComponent(slug),{timeout:5000});
      await addEvent(Array.isArray(raw)?raw[0]:raw,href,true);
    }catch(e){console.log(JSON.stringify({level:"WARN",event:"event_load_failed",slug,message:e.message}));}
  }

  // Fallback for Polymarket's client-rendered pages: discover current soccer events from Gamma
  // when raw HTML contains no usable fixture links.
  if(candidates.length===0){
    try{
      const raw=await json(GAMMA+"/events?active=true&closed=false&tag_slug=soccer&limit=500&order=startDate&ascending=false",{timeout:8000});
      const events=Array.isArray(raw)?raw:[];
      for(const event of events)await addEvent(event,null);
      console.log(JSON.stringify({level:"INFO",event:"gamma_soccer_fallback",events:events.length,added:candidates.length}));
    }catch(e){console.log(JSON.stringify({level:"WARN",event:"gamma_soccer_fallback_failed",message:e.message}));}
  }

  console.log(JSON.stringify({level:"INFO",event:"discovery",liveLinks:liveLinks.length,soccerLinks:soccerLinks.length,soccerIntersection:candidates.length,matches:candidates.map(x=>({slug:x.slug,home:x.home,away:x.away,minute:x.minute,score:x.score}))}));
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

async function claimFootballMatch(slug){
  const siteUrl=t(process.env.CONVEX_SITE_URL||"");
  const deployKey=t(process.env.CONVEX_DEPLOY_KEY||"");
  if(!siteUrl||!deployKey)throw new Error("Convex configuration is missing");
  const convexUrl=siteUrl.replace(/\\.convex\\.site$/,".convex.cloud");
  const r=await fetch(convexUrl+"/api/mutation",{
    method:"POST",
    headers:{"content-type":"application/json","Authorization":"Convex "+deployKey},
    body:JSON.stringify({path:"btc5mState:claimFootballMatch",args:{marketSlug:slug},format:"json"}),
    signal:AbortSignal.timeout(8000)
  });
  if(!r.ok)throw new Error("Convex claim HTTP "+r.status);
  const b=await r.json();
  return b && b.value && b.value.allowed===true;
}

async function releaseFootballMatch(slug){
  const siteUrl=t(process.env.CONVEX_SITE_URL||"");
  const deployKey=t(process.env.CONVEX_DEPLOY_KEY||"");
  if(!siteUrl||!deployKey)return;
  const convexUrl=siteUrl.replace(/\.convex\.site$/,".convex.cloud");
  const r=await fetch(convexUrl+"/api/mutation",{method:"POST",headers:{"content-type":"application/json","Authorization":"Convex "+deployKey},body:JSON.stringify({path:"btc5mState:releaseFootballMatch",args:{marketSlug:slug},format:"json"}),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error("Convex release HTTP "+r.status);
}

async function sendTelegram(message){
  const token=process.env.TELEGRAM_BOT_TOKEN||"",chat=process.env.TELEGRAM_CHAT_ID||"";
  if(!token||!chat)throw new Error("Telegram credentials are missing");
  const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text:message,disable_web_page_preview:false}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error("Telegram HTTP "+r.status);const b=await r.json();if(!b.ok)throw new Error("Telegram rejected message");
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
  for(const x of candidates){
    if(stopping)break;
    const id=x.slug||x.eventId;if(alerted.has(id)||alerting.has(id))continue;
    alerting.add(id);
    try{
      await refreshEvent(x);
      if(!(await claimFootballMatch(id))){ console.log(JSON.stringify({level:"INFO",event:"duplicate_suppressed",eventId:id,slug:x.slug})); continue; }
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
      console.log(JSON.stringify({level:"INFO",event:"alert_sent",eventId:id,slug:x.slug,teams:[x.home,x.away]}));
    }catch(e){console.log(JSON.stringify({level:"ERROR",event:"alert_failed",eventId:id,slug:x.slug,message:e.message}));}
    finally{alerting.delete(id);}
  }
}
async function main(){
  console.log(JSON.stringify({event:"monitor_start",sourceLive:LIVE_PAGE,sourceSoccer:SOCCER_PAGE,pollMs:POLL_MS}));
  const deadline=Date.now()+RUN_MS;
  while(!stopping&&Date.now()<deadline){const started=Date.now();try{await cycle()}catch(e){console.log(JSON.stringify({level:"ERROR",event:"cycle_failed",message:e.message}))}await new Promise(r=>setTimeout(r,Math.max(250,Math.min(POLL_MS,deadline-Date.now()))));console.log(JSON.stringify({event:"cycle_complete",elapsedMs:Date.now()-started}));}
  console.log(JSON.stringify({event:"monitor_exit"}));
}
process.on("SIGTERM",()=>stopping=true);process.on("SIGINT",()=>stopping=true);main().catch(e=>{console.error(e);process.exitCode=1});
