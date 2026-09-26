const GAMMA = "https://gamma-api.polymarket.com";
const SOCCER_GAMES_URL = "https://polymarket.com/sports/soccer/games";
const POLL_MS = 15_000;
const RUN_MS = 5 * 60 * 60 * 1000 + 50 * 60 * 1000;
const SOON_MS = 6 * 60 * 60 * 1000;
const CONVEX = (process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site").replace(/\/$/, "");

let stopped = false;
const tracked = new Map();

function t(v){return typeof v === "string" ? v.trim() : "";}
function norm(v){
  return t(v).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
    .replace(/&/g,"and").replace(/\b(fc|cf|sc|afc|ac|cd|club|football club)\b/g," ")
    .replace(/[^a-z0-9]+/g," ").trim();
}
function arr(v){
  if(Array.isArray(v))return v;
  if(typeof v==="string"){try{const x=JSON.parse(v);return Array.isArray(x)?x:[];}catch{return [];}}
  return [];
}
async function json(url, timeout=5000){
  const r=await fetch(url,{headers:{accept:"application/json","user-agent":"PolymarketFootballMonitor/2.0"},signal:AbortSignal.timeout(timeout)});
  if(!r.ok)throw new Error("HTTP "+r.status+" "+url);
  return r.json();
}
async function soccerGamesPage(){
  const r=await fetch(SOCCER_GAMES_URL,{headers:{accept:"text/html,application/xhtml+xml","user-agent":"Mozilla/5.0"},signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error("HTTP "+r.status+" "+SOCCER_GAMES_URL);
  return await r.text();
}
function cleanHtml(h){
  return t(h.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ")
    .replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'").replace(/\s+/g," "));
}
function links(html){
  const out=[];const re=/href=["'](\/sports\/([^"']+))["']/gi;let m;
  while((m=re.exec(html)))out.push({href:m[1],path:m[2]});
  return [...new Map(out.map(x=>[x.href,x])).values()]
    .filter(x=>x.path!=="live" && x.path.startsWith("soccer/") && /-\d{4}-\d{2}-\d{2}$/.test(x.path));
}
function teamsFromEvent(e){
  const title=t(e?.title||e?.question),h=t(e?.homeTeam||e?.home_team),a=t(e?.awayTeam||e?.away_team);
  if(h&&a)return [h,a];
  const m=title.match(/^(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+?)(?:\s+-\s+.*)?$/i);
  return m?[m[1],m[2]]:["",""];
}
function eventIsFixture(e){const [h,a]=teamsFromEvent(e);return !!h&&!!a;}
function startMs(e){
  const candidates=[e?.startDate,e?.start_date,e?.gameStartTime,e?.game_start_time,e?.startTime,e?.start_time,e?.eventStartTime,e?.event_start_time];
  for(const v of candidates){
    if(typeof v==="number" && Number.isFinite(v))return v<1e12?v*1000:v;
    if(typeof v==="string"){const ms=Date.parse(v);if(Number.isFinite(ms))return ms;}
  }
  return NaN;
}
function eventScore(e){
  const direct=[
    [e?.homeScore,e?.awayScore],[e?.home_score,e?.away_score],
    [e?.score?.home,e?.score?.away],[e?.score?.homeScore,e?.score?.awayScore],
    [e?.liveScore?.home,e?.liveScore?.away],[e?.live_score?.home,e?.live_score?.away]
  ];
  for(const pair of direct){
    const hn=Number(pair[0]),an=Number(pair[1]);
    if(Number.isFinite(hn)&&Number.isFinite(an)&&hn>=0&&an>=0&&hn<=20&&an<=20)return {home:hn,away:an};
  }
  return null;
}
function cardAround(page,home,away){
  const p=norm(page),h=norm(home),a=norm(away);if(!p||!h||!a)return null;
  const aliases=x=>[x,x.replace(/^cd\s+/,"")].filter(Boolean);
  for(const hh of aliases(h)){
    const hi=p.indexOf(hh);if(hi<0)continue;
    for(const aa of aliases(a)){
      const ai=p.indexOf(aa,hi+hh.length);if(ai<0||ai-hi>1400)continue;
      return p.slice(Math.max(0,hi-500),Math.min(p.length,ai+aa.length+700));
    }
  }
  return null;
}
function scoreFromCard(card){
  const m=card?.match(/\b(\d{1,2})\s*[-–:]\s*(\d{1,2})\b/);
  if(!m)return null;
  const h=Number(m[1]),a=Number(m[2]);
  return h<=20&&a<=20?{home:h,away:a}:null;
}
function oneXTwo(e,home,away){
  const markets=arr(e?.markets);
  for(const m of markets){
    if(m?.active===false||m?.closed===true)continue;
    const os=arr(m?.outcomes),ps=arr(m?.outcomePrices??m?.outcome_prices).map(Number);
    if(os.length<3||ps.length!==os.length||ps.some(x=>!Number.isFinite(x)))continue;
    const q=norm(m.question||m.groupItemTitle||m.title);
    if(!/(1x2|match result|winner|moneyline|result)/.test(q)&&!q.includes(norm(home))&&!q.includes(norm(away)))continue;
    let hi=-1,di=-1,ai=-1;
    os.forEach((x,i)=>{
      const o=norm(x);
      if(["draw","tie","x"].includes(o))di=i;
      else if(o==="1"||o==="home"||o===norm(home)||o.includes(norm(home)))hi=i;
      else if(o==="2"||o==="away"||o===norm(away)||o.includes(norm(away)))ai=i;
    });
    if(hi>=0&&di>=0&&ai>=0&&ps[hi]>0&&ps[di]>0&&ps[ai]>0)
      return "1: "+Math.round(ps[hi]*100)+"% · X: "+Math.round(ps[di]*100)+"% · 2: "+Math.round(ps[ai]*100)+"%";
  }
  return null;
}
async function claim(key){
  const r=await fetch(CONVEX+"/football/claim",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({monitor:"polymarket-football",marketSlug:key}),signal:AbortSignal.timeout(2000)});
  return r.status===200?await r.json():{claimed:false};
}
async function release(key){
  try{await fetch(CONVEX+"/football/release",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({monitor:"polymarket-football",marketSlug:key}),signal:AbortSignal.timeout(2000)});}catch{}
}
async function telegram(message,replyTo=null){
  const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chat)throw new Error("Telegram credentials missing");
  const body={chat_id:chat,text:message,disable_web_page_preview:false};
  if(Number.isInteger(replyTo))body.reply_parameters={message_id:replyTo,allow_sending_without_reply:true};
  const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",
    headers:{"content-type":"application/json"},body:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error("Telegram HTTP "+r.status);
  const j=await r.json();if(!j.ok)throw new Error("Telegram rejected message");return j.result;
}
async function saveId(key,id){
  try{await fetch(CONVEX+"/football/telegram-message",{method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({monitor:"polymarket-football",marketSlug:key,messageId:id}),signal:AbortSignal.timeout(2000)});}catch{}
}
async function discoverUpcoming(page){
  const now=Date.now(),items=links(page),found=[];
  for(const item of items.slice(0,120)){
    const slug=item.path.split("/").filter(Boolean).pop();if(!slug)continue;
    let e;
    try{e=await json(GAMMA+"/events/slug/"+encodeURIComponent(slug),3500);}
    catch(err){console.log(JSON.stringify({event:"gamma_event_failed",slug,message:err.message}));continue;}
    if(!e||e.active===false||e.closed===true||!eventIsFixture(e))continue;
    const start=startMs(e);
    if(!Number.isFinite(start)||start<=now||start>now+SOON_MS)continue;
    const teams=teamsFromEvent(e),home=teams[0],away=teams[1],key=t(e.id||e.eventId||e.slug);
    const odds=oneXTwo(e,home,away);
    if(!key||!odds){
      console.log(JSON.stringify({event:"starting_soon_waiting_1x2",key,teams:[home,away],startMs:start,odds:odds||"MISSING"}));
      continue;
    }
    const row={key,slug,href:item.href,home,away,startMs:start,odds};
    found.push(row);tracked.set(key,row);
  }
  return found;
}
async function sendLive(row,score){
  const alertKey=row.key+":LIVE",c=await claim(alertKey);
  if(!c.claimed)return false;
  const message=["⚽ LIVE","",row.home+" vs "+row.away,"",row.odds,"","➡️ OPEN MATCH","https://polymarket.com"+row.href].join("\n");
  try{
    const sent=await telegram(message,c.replyToMessageId??null);await saveId(alertKey,sent.message_id);
    console.log(JSON.stringify({event:"telegram_alert_sent",type:"LIVE",key:row.key,score,messageId:sent.message_id}));
    return true;
  }catch(err){
    await release(alertKey);console.log(JSON.stringify({event:"telegram_alert_failed",type:"LIVE",key:row.key,message:err.message}));return false;
  }
}
async function sendSell(row,score){
  const alertKey=row.key+":SELL::"+score.home+"-"+score.away,c=await claim(alertKey);
  if(!c.claimed)return false;
  const message=["⚽ SELL","",row.home+" vs "+row.away,"SCORE: "+score.home+"–"+score.away,"",row.odds,"","➡️ OPEN MATCH","https://polymarket.com"+row.href].join("\n");
  try{
    const sent=await telegram(message,c.replyToMessageId??null);await saveId(alertKey,sent.message_id);
    console.log(JSON.stringify({event:"telegram_alert_sent",type:"SELL",key:row.key,score,messageId:sent.message_id}));
    return true;
  }catch(err){
    await release(alertKey);console.log(JSON.stringify({event:"telegram_alert_failed",type:"SELL",key:row.key,message:err.message}));return false;
  }
}
async function scan(){
  const page=await soccerGamesPage(),clean=cleanHtml(page);
  const discovered=await discoverUpcoming(page);
  console.log(JSON.stringify({event:"soccer_starting_soon_snapshot",discovered:discovered.length,tracked:tracked.size}));
  for(const [key,row] of [...tracked]){
    let e;
    try{e=await json(GAMMA+"/events/slug/"+encodeURIComponent(row.slug),3500);}
    catch(err){console.log(JSON.stringify({event:"tracked_event_failed",key,message:err.message}));continue;}
    const score=eventScore(e)||scoreFromCard(cardAround(clean,row.home,row.away))||{home:0,away:0};
    const odds=oneXTwo(e,row.home,row.away);if(odds)row.odds=odds;
    if(!row.liveSent){
      const sent=await sendLive(row,score);
      if(sent)row.liveSent=true;
      row.lastScore=score.home+"-"+score.away;
      continue;
    }
    const scoreKey=score.home+"-"+score.away;
    if(scoreKey!==row.lastScore){
      const sent=await sendSell(row,score);
      if(sent)row.lastScore=scoreKey;
    }
  }
}
async function main(){
  const end=Date.now()+RUN_MS;
  while(!stopped&&Date.now()<end){
    try{await scan();}catch(err){console.log(JSON.stringify({event:"scan_failed",message:err.message}));}
    if(Date.now()+POLL_MS>=end)break;
    await new Promise(r=>setTimeout(r,POLL_MS));
  }
}
main().catch(err=>{console.error(err);process.exitCode=1;});