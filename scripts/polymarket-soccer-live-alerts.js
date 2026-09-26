const GAMMA = "https://gamma-api.polymarket.com";
const LIVE_PAGE = "https://polymarket.com/ru/sports/live";
const SOCCER_PAGE = "https://polymarket.com/ru/sports/soccer/games";
const POLL_MS = 5000;
const RUN_MS = 4 * 60 * 60 * 60 * 1000;
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

async function discover(){
  const [liveHtml,soccerHtml]=await Promise.all([fetchPage(LIVE_PAGE),fetchPage(SOCCER_PAGE)]);
  const liveLinks=fixtureLinks(liveHtml);
  const soccerLinks=fixtureLinks(soccerHtml);
  const soccerHrefs=new Set(soccerLinks);
  const soccerSlugs=new Set(soccerLinks.map(fixtureSlug).filter(Boolean));
  const candidates=[],seen=new Set();
  for(const href of liveLinks){
    const slug=fixtureSlug(href);
    if(!slug||(!soccerHrefs.has(href)&&!soccerSlugs.has(slug))||seen.has(slug))continue;
    seen.add(slug);
    try{
      const event=await json(GAMMA+"/events/slug/"+encodeURIComponent(slug),{timeout:5000});
      const [home,away]=teams(event);
      if(!home||!away||!isFixtureTitle(event.title||event.question))continue;
      candidates.push({eventId:t(event.id),slug,url:"https://polymarket.com"+href,home,away,event});
    }catch(e){console.log(JSON.stringify({level:"WARN",event:"event_load_failed",slug,message:e.message}));}
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
function findMarket(rows,re){return rows.find(r=>re.test(r.question));}
function line(row){return row?row.outcomes.map((o,i)=>t(o)+": "+pct(row.prices[i])).join(" · "):"—";}
function money(v){const n=Number(v);return Number.isFinite(n)?"$"+n.toLocaleString("en-US",{maximumFractionDigits:0}):"—";}
function buildAlert(x){
  const e=x.event,rows=marketRows(e);
  const one=findMarket(rows,/1x2|match result|winner|moneyline|result/i);
  const total=findMarket(rows,/total (goals|corners|cards|shots)|over.?under/i);
  const spread=findMarket(rows,/spread|handicap/i);
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
async function cycle(){
  const candidates=await discover();
  for(const x of candidates){
    if(stopping)break;
    const id=x.eventId||x.slug;if(alerted.has(id))continue;
    try{
      const fresh=await json(GAMMA+"/events/"+encodeURIComponent(id),{timeout:5000});x.event=fresh?.event||fresh;
      await sendTelegram(buildAlert(x));alerted.add(id);
      console.log(JSON.stringify({level:"INFO",event:"alert_sent",eventId:id,slug:x.slug,teams:[x.home,x.away]}));
    }catch(e){console.log(JSON.stringify({level:"ERROR",event:"alert_failed",eventId:id,slug:x.slug,message:e.message}));}
  }
}
async function main(){
  console.log(JSON.stringify({event:"monitor_start",sourceLive:LIVE_PAGE,sourceSoccer:SOCCER_PAGE,pollMs:POLL_MS}));
  const deadline=Date.now()+RUN_MS;
  while(!stopping&&Date.now()<deadline){const started=Date.now();try{await cycle()}catch(e){console.log(JSON.stringify({level:"ERROR",event:"cycle_failed",message:e.message}))}await new Promise(r=>setTimeout(r,Math.max(250,Math.min(POLL_MS,deadline-Date.now()))));console.log(JSON.stringify({event:"cycle_complete",elapsedMs:Date.now()-started}));}
  console.log(JSON.stringify({event:"monitor_exit"}));
}
process.on("SIGTERM",()=>stopping=true);process.on("SIGINT",()=>stopping=true);main().catch(e=>{console.error(e);process.exitCode=1});
