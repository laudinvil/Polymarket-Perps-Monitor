const GAMMA = "https://gamma-api.polymarket.com";
const LIVE_PAGE = "https://polymarket.com/ru/sports/live";
const SOCCER_PAGE = "https://polymarket.com/ru/sports/soccer/games";
const POLL_MS = 5000;
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

function eventStarted(event){
  const status=t(event.status||event.gameStatus||event.liveStatus||event.period||event.phase).toLowerCase();
  if(/live|in.?play|playing|1h|2h|halftime|half time|extra|stoppage/.test(status))return true;
  const d=Date.parse(event.startDate||event.start_date||event.startTime||"");
  return Number.isFinite(d)&&d<=Date.now();
}

async function discover(){
  const [liveHtml,soccerHtml]=await Promise.all([fetchPage(LIVE_PAGE),fetchPage(SOCCER_PAGE)]);
  const liveLinks=fixtureLinks(liveHtml);
  const soccerLinks=fixtureLinks(soccerHtml);
  const soccerHrefs=new Set(soccerLinks);
  const soccerSlugs=new Set(soccerLinks.map(fixtureSlug).filter(Boolean));
  const candidates=[],seen=new Set();

  async function addEvent(event,href){
    if(!event||!event.id)return;
    const [home,away]=teams(event);
    const now=Date.now();
    const end=Date.parse(event.endDate||event.end_date||"");
    if(!home||!away||!isFixtureTitle(event.title||event.question)||!eventStarted(event))return;
    if(Number.isFinite(end)&&end<now)return;
    const slug=t(event.slug)||fixtureSlug(href||"");
    if(!slug||seen.has(slug))return;
    seen.add(slug);
    candidates.push({eventId:t(event.id),slug,url:href?("https://polymarket.com"+href):("https://polymarket.com/event/"+slug),home,away,event});
  }

  // Primary gate: matches visible on Polymarket's live page and confirmed on soccer page.
  for(const href of liveLinks){
    const slug=fixtureSlug(href);
    if(!slug||(!soccerHrefs.has(href)&&!soccerSlugs.has(slug)))continue;
    try{
      const raw=await json(GAMMA+"/events?slug="+encodeURIComponent(slug),{timeout:5000});
      await addEvent(Array.isArray(raw)?raw[0]:raw,href);
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

  console.log(JSON.stringify({level:"INFO",event:"discovery",liveLinks:liveLinks.length,soccerLinks:soccerLinks.length,soccerIntersection:candidates.length,matches:candidates.map(x=>({slug:x.slug,home:x.home,away:x.away}))}));
  return candidates;
}
function marketRows(event){
  return (Array.isArray(event.markets)?event.markets:[]).filter(m=>m&&m.active!==false&&m.closed!==true).map(m=>{
    const outcomes=parse(m.outcomes),prices=parse(m.outcomePrices||m.outcome_prices);
    if(!Array.isArray(outcomes)||!Array.isArray(prices)||outcomes.length!==prices.length)return null;
    return{question:t(m.question||m.title),outcomes:outcomes.map(t),prices:prices.map(Number)};
  }).filter(Boolean);
}
function pct(v){const n=Number(v);return Number.isFinite(n)?Math.round(n*100)+"%":"—";}
function findMarket(rows,re){return rows.find(r=>re.test(r.question))||null;}
function find1x2(rows){
  return rows.find(r=>r.outcomes.length===3&&r.outcomes.every(o=>/^(1|x|2|draw|home|away|win|tie)$/i.test(t(o))))||
         rows.find(r=>/1x2|match result|match winner|who will win|winner|moneyline|result/i.test(r.question))||null;
}
function findTotal(rows){return rows.find(r=>/total|over.?under|goals/i.test(r.question)&&r.outcomes.some(o=>/over/i.test(o))&&r.outcomes.some(o=>/under/i.test(o)))||null;}
function findHandicap(rows){return rows.find(r=>/spread|handicap|asian/i.test(r.question))||rows.find(r=>r.outcomes.some(o=>/[+-]\d/.test(o)))||null;}
function line(row){return row?row.outcomes.map((o,i)=>t(o)+": "+pct(row.prices[i])).join(" · "):"—";}
function money(v){const n=Number(v);return Number.isFinite(n)?"$"+n.toLocaleString("en-US",{maximumFractionDigits:0}):"—";}
function buildAlert(x){
  const e=x.event,rows=marketRows(e);
  const one=find1x2(rows);
  const total=findTotal(rows);
  const spread=findHandicap(rows);
  const sh=e.homeScore??e.home_score??e.score?.home??null,sa=e.awayScore??e.away_score??e.score?.away??null;
  const status=t(e.status||e.gameStatus||e.liveStatus||"LIVE");
  const start=t(e.startDate||e.start_date||e.startTime);
  const vol=e.volumeNum??e.volume??e.volume24hr??null,liq=e.liquidityNum??e.liquidity??null;
  return ["⚽ LIVE FOUND","",x.home+" vs "+x.away,status?"STATUS: "+status:"STATUS: LIVE",sh!=null&&sa!=null?"SCORE: "+sh+"–"+sa:"SCORE: —","",
    "1X2: "+line(one),"TOTAL: "+line(total),"HANDICAP: "+line(spread),"",
    "VOLUME: "+money(vol),"LIQUIDITY: "+money(liq),start?"START: "+start:"START: —","",
    "➡️ OPEN MATCH",x.url].join("\n");
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
  if(!Array.isArray(x.event?.markets)||x.event.markets.length===0){
    try{
      const ms=await json(GAMMA+"/markets?event_id="+encodeURIComponent(x.eventId)+"&active=true&closed=false&limit=100",{timeout:5000});
      if(Array.isArray(ms)&&ms.length)x.event.markets=ms;
    }catch{}
  }
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
      await sendTelegram(buildAlert(x));alerted.add(id);
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
