const GAMMA = "https://gamma-api.polymarket.com";
const LIVE_URL = "https://polymarket.com/sports/live";
const POLL_MS = 15_000;
const RUN_MS = 5 * 60 * 60 * 1000 + 50 * 60 * 1000;
const CONVEX = (process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site").replace(/\/$/, "");
let stopped = false;
const lastScores = new Map();

function t(v){return typeof v === "string" ? v.trim() : "";}
function norm(v){return t(v).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/&/g,"and").replace(/\b(fc|cf|sc|afc|ac|cd|club|football club)\b/g," ").replace(/[^a-z0-9]+/g," ").trim();}
async function json(url, timeout=5000){const r=await fetch(url,{headers:{accept:"application/json","user-agent":"PolymarketLiveOnly/1.0"},signal:AbortSignal.timeout(timeout)});if(!r.ok)throw new Error(`HTTP ${r.status} ${url}`);return r.json();}
async function livePage(){const r=await fetch(LIVE_URL,{headers:{accept:"text/html,application/xhtml+xml","user-agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150 Safari/537.36"},signal:AbortSignal.timeout(8000)});if(!r.ok)throw new Error(`HTTP ${r.status} ${LIVE_URL}`);return await r.text();}
function cleanHtml(h){return t(h.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g," "));}
function links(html){const out=[];const re=/href=["'](\/sports\/([^"']+))["']/gi;let m;while((m=re.exec(html)))out.push({href:m[1],path:m[2]});return [...new Map(out.map(x=>[x.href,x])).values()].filter(x=>x.path!=="live");}
function isSoccerHref(href){const league=(href.split("/").filter(Boolean)[1]||"").toLowerCase();return !/^(cfb|nfl|mlb|nba|nhl|wnba|atp|wta|ufc|mma|boxing|cricket|rugby|golf|darts|volleyball|handball|table-tennis|motorsports|formula-1|nascar|esports|chess|poker)$/.test(league);}
function teamsFromEvent(e){const title=t(e?.title||e?.question);const h=t(e?.homeTeam||e?.home_team),a=t(e?.awayTeam||e?.away_team);if(h&&a)return [h,a];const m=title.match(/^(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+?)(?:\s+-\s+.*)?$/i);return m?[m[1],m[2]]:["",""];}
function eventIsFixture(e){const [h,a]=teamsFromEvent(e);return !!h&&!!a&&/\s(?:vs\.?|v\.?|versus)\s/i.test(t(e?.title||e?.question));}
function cardAround(page,home,away){const p=norm(page),h=norm(home),a=norm(away);if(!p||!h||!a)return null;const aliases=x=>[x,x.replace(/^cd\s+/,"")].filter(Boolean);for(const hh of aliases(h)){const hi=p.indexOf(hh);if(hi<0)continue;for(const aa of aliases(a)){const ai=p.indexOf(aa,hi+hh.length);if(ai<0||ai-hi>1000)continue;const card=p.slice(Math.max(0,hi-350),Math.min(p.length,ai+aa.length+450));if(/\b(?:1h|2h|ht|et|aet|live|playing|in progress|penalties|pen)\b/.test(card))return card;}}return null;}
function scoreFromCard(card){if(!card)return {home:0,away:0};const m=card.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/);if(!m)return {home:0,away:0};const h=Number(m[1]),a=Number(m[2]);return h>=0&&a>=0&&h<=20&&a<=20?{home:h,away:a}:{home:0,away:0};}
function oneXTwo(e,home,away){const markets=Array.isArray(e?.markets)?e.markets:[];for(const m of markets){if(m?.active===false||m?.closed===true)continue;const os=Array.isArray(m.outcomes)?m.outcomes:[];const ps=Array.isArray(m.outcomePrices)?m.outcomePrices.map(Number):[];if(os.length<3||ps.length!==os.length||ps.some(x=>!Number.isFinite(x)))continue;const q=norm(m.question);if(!/(1x2|match result|winner|moneyline|result)/.test(q)&&!q.includes(norm(home))&&!q.includes(norm(away)))continue;let hi=-1,di=-1,ai=-1;os.forEach((x,i)=>{const o=norm(x);if(["draw","tie","x"].includes(o))di=i;else if(o==="1"||o==="home"||o===norm(home)||o.includes(norm(home)))hi=i;else if(o==="2"||o==="away"||o===norm(away)||o.includes(norm(away)))ai=i;});if(hi>=0&&di>=0&&ai>=0)return `1: ${Math.round(ps[hi]*100)}% · X: ${Math.round(ps[di]*100)}% · 2: ${Math.round(ps[ai]*100)}%`;}return "1X2: —";}
async function claim(key){const r=await fetch(CONVEX+"/football/claim",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({monitor:"polymarket-football",marketSlug:key}),signal:AbortSignal.timeout(2000)});if(r.status===200)return await r.json();return {claimed:false};}
async function release(key){try{await fetch(CONVEX+"/football/release",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({monitor:"polymarket-football",marketSlug:key}),signal:AbortSignal.timeout(2000)});}catch{}}
async function telegram(message,replyTo=null){const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;if(!token||!chat)throw new Error("Telegram credentials missing");const body={chat_id:chat,text:message,disable_web_page_preview:false};if(Number.isInteger(replyTo))body.reply_parameters={message_id:replyTo,allow_sending_without_reply:true};const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(`Telegram HTTP ${r.status}`);const j=await r.json();if(!j.ok)throw new Error("Telegram rejected message");return j.result;}
async function saveId(key,id){await fetch(CONVEX+"/football/telegram-message",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({monitor:"polymarket-football",marketSlug:key,messageId:id}),signal:AbortSignal.timeout(2000)});}
async function scan(){
  const html=await livePage(),page=cleanHtml(html),hrefs=links(html).filter(x=>isSoccerHref(x.href)).slice(0,50);
  console.log(JSON.stringify({event:"live_page_snapshot",hrefCount:hrefs.length,source:LIVE_URL,rule:"LIVE page is admission source; Gamma only enriches event/1X2"}));
  for(const item of hrefs){
    const slug=item.path.split("/").filter(Boolean).pop();let e;
    try{e=await json(GAMMA+"/events/slug/"+encodeURIComponent(slug),3500);}catch(err){console.log(JSON.stringify({event:"gamma_event_failed",slug,message:err.message}));continue;}
    if(!e||e.active===false||e.closed===true||!eventIsFixture(e))continue;
    const [home,away]=teamsFromEvent(e),card=cardAround(page,home,away);if(!card)continue;
    const score=scoreFromCard(card),key=t(e.id||e.eventId||e.slug);if(!key)continue;
    const url="https://polymarket.com"+item.href,odds=oneXTwo(e,home,away),scoreKey=`${score.home}-${score.away}`,previous=lastScores.get(key);lastScores.set(key,scoreKey);
    console.log(JSON.stringify({event:"live_match",key,teams:[home,away],score,odds}));
    const isFirst=!previous,changed=previous&&previous!==scoreKey;if(!isFirst&&!changed)continue;
    const type=isFirst?"LIVE":"SELL",alertKey=`${key}:${type}${isFirst?"":"::"+scoreKey}`,c=await claim(alertKey);if(!c.claimed)continue;
    const message=[`⚽ ${type}`,"",`${home} vs ${away}`,`SCORE: ${score.home}–${score.away}`,"",odds,"","➡️ OPEN MATCH",url].join("\n");
    try{const sent=await telegram(message,c.replyToMessageId??null);await saveId(alertKey,sent.message_id);console.log(JSON.stringify({event:"telegram_alert_sent",type,key,score,messageId:sent.message_id}));}catch(err){await release(alertKey);console.log(JSON.stringify({event:"telegram_alert_failed",type,key,message:err.message}));}
  }
}
async function main(){const end=Date.now()+RUN_MS;while(!stopped&&Date.now()<end){try{await scan();}catch(err){console.log(JSON.stringify({event:"scan_failed",message:err.message}));}if(Date.now()+POLL_MS>=end)break;await new Promise(r=>setTimeout(r,POLL_MS));}}
main().catch(err=>{console.error(err);process.exitCode=1;});
