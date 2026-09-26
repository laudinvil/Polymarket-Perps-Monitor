const GAMMA = "https://gamma-api.polymarket.com";
const SOFASCORE_LIVE_URL = "https://www.sofascore.com/api/v1/sport/football/events/live";
const POLY_SEARCH_URL = "https://gamma-api.polymarket.com/search";
const APPROX_MAX_DIFF = 0.10;
const POLL_MS = 15_000; // continuous football discovery
const RUN_MS = 5 * 60 * 60 * 1000 + 50 * 60 * 1000;
const SOON_MS = 6 * 60 * 60 * 1000;
const CONVEX = (process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site").replace(/\/$/, "");

let stopped = false;
const tracked = new Map();
const telemetry = [];
let telemetryFlushPromise = null;

function log(value){
  const line = typeof value === "string" ? value : JSON.stringify(value);
  console.log(line);
  try{
    const parsed = JSON.parse(line);
    if(parsed && parsed.event){
      telemetry.push({
        level: String(parsed.event).includes("failed") || String(parsed.event).includes("error") ? "ERROR" : "INFO",
        event: String(parsed.event),
        message: String(parsed.message || parsed.event),
        data: JSON.stringify(parsed),
        createdAt: Date.now()
      });
    }
  }catch{}
}

async function flushConvexLogs(tickCount=0){
  if(telemetryFlushPromise)return telemetryFlushPromise;
  if(!telemetry.length && !tickCount)return;
  const batch = telemetry.splice(0, 100);
  telemetryFlushPromise = (async()=>{
    try{
      const r=await fetch(CONVEX+"/football/logs",{
        method:"POST",
        headers:{"content-type":"application/json"},
        body:JSON.stringify({logs:batch,tickCount}),
        signal:AbortSignal.timeout(3000)
      });
      if(!r.ok)throw new Error("Convex logs HTTP "+r.status);
    }catch(err){
      telemetry.unshift(...batch);
      console.error(JSON.stringify({event:"convex_logs_flush_failed",message:err.message}));
    }finally{
      telemetryFlushPromise=null;
    }
  })();
  return telemetryFlushPromise;
}

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
async function sofascoreLive(){ return json(SOFASCORE_LIVE_URL,5000); }
async function polymarketSearch(home,away){
  return arr((await json(POLY_SEARCH_URL+"?q="+encodeURIComponent(home+" "+away)+"&limit_per_type=20&keep_closed_markets=0",5000))?.events);
}
function sofascoreMinute(e){
  const ts=Number(e?.time?.currentPeriodStartTimestamp||e?.time?.period1StartTimestamp||0);
  if(ts>0)return Math.floor(Math.max(0,Date.now()/1000-ts)/60);
  const m=t(e?.status?.description).match(/(\d{1,3})/); return m?Number(m[1]):0;
}
function scoreZeroZero(e){return Number(e?.homeScore?.current??0)===0&&Number(e?.awayScore?.current??0)===0;}
function teamMatch(a,b){const x=norm(a),y=norm(b);return x===y||x.includes(y)||y.includes(x);}
function sameMatch(e,home,away){const [h,a]=teamsFromEvent(e);return teamMatch(h,home)&&teamMatch(a,away);}
async function sofascoreOdds(id){
  const data=await json("https://www.sofascore.com/api/v1/event/"+id+"/odds/1/all",5000),markets=arr(data?.markets);
  let one=null,exact=null;
  for(const m of markets){
    const name=t(m?.name||m?.group).toLowerCase(),choices=arr(m?.choices);
    if(!one&&/(1x2|full time|match result)/.test(name)){
      const p={}; for(const x of choices){const n=t(x?.name).toUpperCase(),d=Number(x?.decimalValue);if(d>1&&(n==="1"||n==="HOME"))p.h=1/d;if(d>1&&(n==="X"||n==="DRAW"))p.d=1/d;if(d>1&&(n==="2"||n==="AWAY"))p.a=1/d;}
      if(p.h&&p.d&&p.a){const s=p.h+p.d+p.a;one={home:p.h/s,draw:p.d/s,away:p.a/s};}
    }
    if(/correct score|exact score/.test(name))for(const x of choices){if(/^1[:\-]1$/.test(t(x?.name))){const d=Number(x?.decimalValue);if(d>1)exact=1/d;}}
  }
  return {one,exact};
}
function parsePolyOneXTwo(e,home,away){
  const out={home:null,draw:null,away:null},h=norm(home),a=norm(away);
  for(const m of arr(e?.markets)){
    if(m?.active===false||m?.closed===true)continue;
    const os=arr(m?.outcomes),ps=arr(m?.outcomePrices??m?.outcome_prices).map(Number);
    const i=os.findIndex(x=>norm(x)==="yes"),yes=ps[i]; if(i<0||!(yes>0&&yes<=1))continue;
    const q=norm(m?.question||m?.title||m?.groupItemTitle||m?.slug);
    if(q.includes("draw")||q.includes("tie"))out.draw=yes;
    else if(q.includes(h))out.home=yes;
    else if(q.includes(a))out.away=yes;
  }
  return out.home>0&&out.draw>0&&out.away>0?out:null;
}
function formatOne(p){return "1: "+pct(p.home)+" · X: "+pct(p.draw)+" · 2: "+pct(p.away);}
function approxPass(sofa,poly){
  if(!sofa?.one||!poly?.one||sofa.exact==null||poly.exact==null)return false;
  return Math.max(Math.abs(sofa.one.home-poly.one.home),Math.abs(sofa.one.draw-poly.one.draw),Math.abs(sofa.one.away-poly.one.away),Math.abs(sofa.exact-poly.exact))<=APPROX_MAX_DIFF;
}
function polyEventUrl(e){return t(e?.slug)?"/event/"+e.slug:"";}
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
function exactScore11Yes(e){
  const markets=arr(e?.markets);
  for(const m of markets){
    if(m?.active===false||m?.closed===true)continue;
    // IMPORTANT: norm() removes '-' and ':'; score matching must use raw market text.
    const rawGroup=t(m.groupItemTitle||m.group_item_title||m.marketGroup||m.market_group||m.category||m.section).toLowerCase();
    const rawQuestion=t(m.question||m.title||m.slug).toLowerCase();
    const combinedRaw=rawGroup+" "+rawQuestion;
    const group=norm(rawGroup),question=norm(rawQuestion);
    const exactSection=/(exact score|correct score|точн[а-я]*\s*сч[её]т)/i.test(combinedRaw);
    const is11=/(^|[^0-9])1\s*[-:–]\s*1([^0-9]|$)/.test(combinedRaw);
    const os=arr(m.outcomes),ps=arr(m.outcomePrices??m.outcome_prices).map(Number);
    if(os.length!==ps.length||!ps.length)continue;
    for(let i=0;i<os.length;i++){
      const o=norm(os[i]);
      const rawO=t(os[i]).toLowerCase();
      if((is11||exactSection)&&o==="yes"&&ps[i]>=0&&ps[i]<=1){
        if(is11)return ps[i];
      }
      if(/^1\s*[-:–]\s*1$/.test(rawO)&&ps[i]>=0&&ps[i]<=1)return ps[i];
    }
  }
  return null;
}
async function exactScore11(e){
  const direct=exactScore11Yes(e);
  if(direct!==null){
    log(JSON.stringify({event:"exact_score_11_source",source:"event.markets",price:pct(direct)}));
    return direct;
  }
  const id=t(e?.id||e?.eventId);
  if(!id)return null;
  try{
    const data=await json(GAMMA+"/markets?event_id="+encodeURIComponent(id)+"&limit=500",3500);
    const markets=Array.isArray(data)?data:arr(data?.markets);
    const value=exactScore11Yes({markets});
    if(value!==null)log(JSON.stringify({event:"exact_score_11_source",source:"Gamma /markets",eventId:id,price:pct(value),markets:markets.length}));
    return value;
  }catch(err){
    log(JSON.stringify({event:"exact_11_market_fetch_failed",eventId:id,message:err.message}));
    return null;
  }
}
function pct(v){return Math.round(v*100)+"%";}
function exactDelta(first,current){
  const d=current-first;
  const arrow=d>0?"↑":d<0?"↓":"→";
  return pct(first)+" "+arrow+" "+pct(current)+" ("+(d>0?"+":"")+Math.round(d*100)+" п.п.)";
}
function eventFinished(e){
  if(e?.closed===true||e?.resolved===true||e?.ended===true)return true;
  const status=t(e?.status||e?.gameStatus||e?.game_status||e?.state).toLowerCase();
  if(/^(final|finished|ended|resolved|complete|completed)$/.test(status))return true;
  const end=startMs({startDate:e?.endDate,endTime:e?.endTime});
  return Number.isFinite(end)&&end<=Date.now();
}
function oneXTwo(e,home,away){const p=parsePolyOneXTwo(e,home,away);return p?formatOne(p):null;}
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
async function discoverLiveZeroZero(){
  const live=await sofascoreLive(),found=[];
  for(const s of arr(live?.events)){
    if(!s?.id||s?.status?.type!=="inprogress"||!scoreZeroZero(s)||sofascoreMinute(s)<1)continue;
    const home=t(s?.homeTeam?.name),away=t(s?.awayTeam?.name); if(!home||!away)continue;
    try{
      const candidates=await polymarketSearch(home,away),pm=candidates.find(e=>e?.active!==false&&e?.closed!==true&&sameMatch(e,home,away));
      if(!pm){log(JSON.stringify({event:"sofascore_00_no_polymarket",teams:[home,away],minute:sofascoreMinute(s)}));continue;}
      const sofa=await sofascoreOdds(s.id),polyOne=parsePolyOneXTwo(pm,home,away),polyExact=exactScore11Yes(pm);
      if(!sofa.one||sofa.exact==null||!polyOne||polyExact==null){log(JSON.stringify({event:"sofascore_poly_market_data_missing",teams:[home,away],minute:sofascoreMinute(s),sofa,polyOne,polyExact}));continue;}
      const pass=approxPass(sofa,{one:polyOne,exact:polyExact}),maxDiff=Math.max(Math.abs(sofa.one.home-polyOne.home),Math.abs(sofa.one.draw-polyOne.draw),Math.abs(sofa.one.away-polyOne.away),Math.abs(sofa.exact-polyExact));
      log(JSON.stringify({event:"sofascore_match_check",teams:[home,away],minute:sofascoreMinute(s),sofa,poly:{one:polyOne,exact:polyExact},maxDiff,pass}));
      if(!pass)continue;
      const key=t(pm.id||pm.eventId||pm.slug),tt=teamsFromEvent(pm);
      const row={key,slug:t(pm.slug),href:polyEventUrl(pm),home:tt[0]||home,away:tt[1]||away,startMs:Date.now(),odds:formatOne(polyOne),exact11First:polyExact,exact11Current:polyExact,nextSent:false};
      tracked.set(key,row);found.push(row);
      log(JSON.stringify({event:"sofascore_filter_passed",key,teams:[home,away],minute:sofascoreMinute(s),sofa,polyOne,polyExact}));
    }catch(err){log(JSON.stringify({event:"sofascore_candidate_failed",teams:[home,away],message:err.message}));}
  }
  return found;
}
async function sendNext(row,score){
  const alertKey=row.key+":NEXT",c=await claim(alertKey);
  if(!c.claimed)return false;
  const message=["⚽ NEXT","",row.home+" vs "+row.away,"1:1 YES: "+pct(row.exact11First),"",row.odds,"","➡️ OPEN MATCH","https://polymarket.com"+row.href].join("\n");
  try{
    const sent=await telegram(message,c.replyToMessageId??null);await saveId(alertKey,sent.message_id);row.nextMessageId=sent.message_id;
    log(JSON.stringify({event:"telegram_alert_sent",type:"NEXT",key:row.key,score,messageId:sent.message_id}));
    return true;
  }catch(err){
    await release(alertKey);log(JSON.stringify({event:"telegram_alert_failed",type:"NEXT",key:row.key,message:err.message}));return false;
  }
}
async function sendLoss(row,score){
  const alertKey=row.key+":LOSS",c=await claim(alertKey);
  if(!c.claimed)return false;
  const message=["⚽ LOSS","",row.home+" vs "+row.away,"SCORE: 0–0","",row.odds,"","➡️ OPEN MATCH","https://polymarket.com"+row.href].join("\n");
  try{
    const sent=await telegram(message,c.replyToMessageId??null);await saveId(alertKey,sent.message_id);
    log(JSON.stringify({event:"telegram_alert_sent",type:"LOSS",key:row.key,score,messageId:sent.message_id}));
    return true;
  }catch(err){
    await release(alertKey);log(JSON.stringify({event:"telegram_alert_failed",type:"LOSS",key:row.key,message:err.message}));return false;
  }
}
async function sendLive(row,score){
  const alertKey=row.key+":LIVE",c=await claim(alertKey);
  if(!c.claimed)return false;
  const message=["⚽ LIVE","",row.home+" vs "+row.away,"",row.odds,"","➡️ OPEN MATCH","https://polymarket.com"+row.href].join("\n");
  try{
    const sent=await telegram(message,c.replyToMessageId??null);await saveId(alertKey,sent.message_id);
    log(JSON.stringify({event:"telegram_alert_sent",type:"LIVE",key:row.key,score,messageId:sent.message_id}));
    return true;
  }catch(err){
    await release(alertKey);log(JSON.stringify({event:"telegram_alert_failed",type:"LIVE",key:row.key,message:err.message}));return false;
  }
}
async function sendSell(row,score){
  const alertKey=row.key+":SELL::"+score.home+"-"+score.away,c=await claim(alertKey);
  if(!c.claimed)return false;
  const current=row.exact11Current??row.exact11First;
  const message=["⚽ SELL","",row.home+" vs "+row.away,"SCORE: "+score.home+"–"+score.away,"1:1 YES: "+exactDelta(row.exact11First,current),"",row.odds,"","➡️ OPEN MATCH","https://polymarket.com"+row.href].join("\n");
  try{
    const sent=await telegram(message,c.replyToMessageId??null);await saveId(alertKey,sent.message_id);
    log(JSON.stringify({event:"telegram_alert_sent",type:"SELL",key:row.key,score,messageId:sent.message_id}));
    return true;
  }catch(err){
    await release(alertKey);log(JSON.stringify({event:"telegram_alert_failed",type:"SELL",key:row.key,message:err.message}));return false;
  }
}
async function scan(){
  const discovered=await discoverLiveZeroZero();
  log(JSON.stringify({event:"sofascore_live_00_snapshot",discovered:discovered.length,tracked:tracked.size}));
  for(const [key,row] of [...tracked])if(!row.nextSent){const sent=await sendNext(row,{home:0,away:0});if(sent)row.nextSent=true;}
}
async function main(){
  const end=Date.now()+RUN_MS;
  while(!stopped&&Date.now()<end){
    try{await scan();}catch(err){log(JSON.stringify({event:"scan_failed",message:err.message}));}
    await flushConvexLogs(1);
    if(Date.now()+POLL_MS>=end)break;
    await new Promise(r=>setTimeout(r,POLL_MS));
  }
  await flushConvexLogs(0);
}
main().catch(err=>{console.error(err);process.exitCode=1;});