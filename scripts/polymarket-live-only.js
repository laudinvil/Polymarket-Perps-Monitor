const GAMMA = "https://gamma-api.polymarket.com";
const SOFASCORE_LIVE_URL = "https://api.sofascore.com/api/v1/sport/football/events/live";
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
      void flushConvexLogs(0);
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
  const isSofa=/^https:\/\/api\.sofascore\.com\//.test(url);
  const headers=isSofa ? {
    accept:"application/json, text/plain, */*",
    "accept-language":"en-US,en;q=0.9",
    "user-agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    origin:"https://www.sofascore.com",
    referer:"https://www.sofascore.com/"
  } : {
    accept:"application/json",
    "user-agent":"Mozilla/5.0"
  };
  let last;
  for(let attempt=0;attempt<2;attempt++){
    try{
      const r=await fetch(url,{headers,signal:AbortSignal.timeout(timeout)});
      if(!r.ok){
        last=new Error("HTTP "+r.status+" "+url);
        if((r.status===403||r.status===429)&&attempt===0){await new Promise(x=>setTimeout(x,250));continue;}
        throw last;
      }
      return r.json();
    }catch(err){
      last=err;
      if(attempt===0)await new Promise(x=>setTimeout(x,250));
    }
  }
  throw last||new Error("HTTP request failed "+url);
}
async function sofascoreLive(){
  const urls=[SOFASCORE_LIVE_URL];
  let last;
  for(const url of urls){
    try{
      const x=await json(url,7000);
      if(Array.isArray(x?.events))return x;
    }catch(err){last=err;}
  }
  throw last||new Error("Sofascore live events unavailable");
}
async function polymarketSearch(home,away){
  return arr((await json(POLY_SEARCH_URL+"?q="+encodeURIComponent(home+" "+away)+"&limit_per_type=20&keep_closed_markets=0",5000))?.events);
}
function sofascoreMinute(e){
  const ts=Number(e?.time?.currentPeriodStartTimestamp||e?.time?.period1StartTimestamp||0);
  if(ts>0)return Math.floor(Math.max(0,Date.now()/1000-ts)/60);
  const m=t(e?.status?.description).match(/(\d{1,3})/); return m?Number(m[1]):0;
}
function scoreZeroZero(e){const h=Number(e?.homeScore?.current),a=Number(e?.awayScore?.current);return Number.isFinite(h)&&Number.isFinite(a)&&h===0&&a===0;}
function teamMatch(a,b){const x=norm(a),y=norm(b);return x===y||x.includes(y)||y.includes(x);}
function sameMatch(e,home,away){const [h,a]=teamsFromEvent(e);return (teamMatch(h,home)&&teamMatch(a,away))||(teamMatch(h,away)&&teamMatch(a,home));}
function oddsDecimal(x){
  const d=Number(x?.decimalValue);
  if(Number.isFinite(d)&&d>1)return d;
  const f=t(x?.fractionalValue||x?.initialFractionalValue);
  const m=f.match(/^(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
  if(m){
    const a=Number(m[1]),b=Number(m[2]);
    if(Number.isFinite(a)&&Number.isFinite(b)&&b>0)return 1+a/b;
  }
  return NaN;
}
async function sofascoreOdds(id,homeTeam="",awayTeam=""){
  let markets=[];
  const urls=[
    "https://api.sofascore.com/api/v1/event/"+id+"/odds/1/all",
    "https://api.sofascore.com/api/v1/event/"+id+"/odds/1"
  ];
  for(const url of urls){
    try{
      const data=await json(url,5000);
      const got=arr(data?.markets);
      if(got.length){markets=got;break;}
    }catch(err){
      log(JSON.stringify({event:"sofascore_odds_endpoint_failed",sofaId:String(id),url,message:err.message}));
    }
  }
  const hn=norm(homeTeam),an=norm(awayTeam);
  let one=null,exact=null,oneMarket=null,exactMarket=null;
  for(const m of markets){
    const name=t(m?.marketName||m?.name||m?.groupItemTitle||m?.group).toLowerCase(),choices=arr(m?.choices);
    if(!one&&/(1x2|match result|match winner|full time|winner)/.test(name)){
      const p={};
      for(const x of choices){
        const raw=t(x?.name),n=raw.toUpperCase(),nx=norm(raw),d=oddsDecimal(x);
        if(!(d>1))continue;
        if(n==="1"||n==="HOME"||nx===hn||teamMatch(nx,hn))p.h=1/d;
        else if(n==="X"||n==="DRAW"||n==="TIE"||nx==="draw"||nx==="tie")p.d=1/d;
        else if(n==="2"||n==="AWAY"||nx===an||teamMatch(nx,an))p.a=1/d;
      }
      if(p.h&&p.d&&p.a){const s=p.h+p.d+p.a;one={home:p.h/s,draw:p.d/s,away:p.a/s};oneMarket=name;}
    }
    if(/correct score|exact score|correct result/.test(name)){
      for(const x of choices){
        const raw=t(x?.name),d=oddsDecimal(x);
        if(/^1[:\-–]1$/.test(raw)&&d>1){exact=1/d;exactMarket=name;}
      }
    }
  }
  log(JSON.stringify({event:"sofascore_odds_parsed",sofaId:String(id),marketCount:markets.length,oneFound:!!one,exact11Found:exact!=null,oneMarket,exactMarket,markets:markets.slice(0,12).map(m=>({name:m?.marketName||m?.name||m?.groupItemTitle||m?.group,choices:arr(m?.choices).slice(0,8).map(x=>({name:x?.name,decimal:x?.decimalValue,fractional:x?.fractionalValue}))}))}));
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
  try{
    const r=await fetch(CONVEX+"/football/claim",{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({monitor:"polymarket-football",marketSlug:key}),signal:AbortSignal.timeout(2000)});
    if(r.status===200)return await r.json();
    log(JSON.stringify({event:"claim_non_200",key,status:r.status}));
    return {claimed:true,replyToMessageId:null};
  }catch(err){
    log(JSON.stringify({event:"claim_failed_fail_open",key,message:err.message}));
    return {claimed:true,replyToMessageId:null};
  }
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
  const live=await sofascoreLive(),events=arr(live?.events);
  const inprogress=events.filter(e=>e?.status?.type==="inprogress");
  log(JSON.stringify({event:"sofascore_live_snapshot",total:events.length,inprogress:inprogress.length}));
  const found=[];
  for(const s of inprogress){
    const home=t(s?.homeTeam?.name),away=t(s?.awayTeam?.name);
    if(!s?.id||!home||!away)continue;
    try{
      const minute=sofascoreMinute(s),score={home:Number(s?.homeScore?.current),away:Number(s?.awayScore?.current)};
      const sofa=await sofascoreOdds(s.id,home,away);
      log(JSON.stringify({event:"sofascore_live_candidate",teams:[home,away],id:s.id,minute,score,sofa}));
      const candidates=await polymarketSearch(home,away);
      const pm=candidates.find(e=>e?.active!==false&&e?.closed!==true&&sameMatch(e,home,away));
      log(JSON.stringify({event:"polymarket_search_result",teams:[home,away],minute,results:candidates.length,matched:!!pm,matchedEventId:pm?.id||pm?.eventId||null}));
      if(!pm){
        log(JSON.stringify({event:"sofascore_live_no_polymarket",teams:[home,away],minute,searchResults:candidates.slice(0,5).map(e=>({id:e?.id,slug:e?.slug,title:e?.title,homeTeam:e?.homeTeam,awayTeam:e?.awayTeam}))}));
        continue;
      }
      await sendLiveFound(home,away,minute,score,sofa,pm);
      if(!sofa.one||sofa.exact==null){
        log(JSON.stringify({event:"sofascore_required_odds_missing",teams:[home,away],minute,has1x2:!!sofa.one,hasExact11:sofa.exact!=null,sofa}));
        if(sofa.one&&sofa.exact==null)await sendDataCheck(home,away,minute,sofa,pm);
        continue;
      }
      const polyId=t(pm.id||pm.eventId),polySlug=t(pm.slug);
      const diff=Math.abs(sofa.one.home-sofa.one.away);
      const pass=diff<=APPROX_MAX_DIFF;
      log(JSON.stringify({event:"live_filter_check",teams:[home,away],minute,score,sofa,homePrice:sofa.one.home,awayPrice:sofa.one.away,diff,threshold:APPROX_MAX_DIFF,pass,polymarketEventId:polyId,polymarketSlug:polySlug}));
      if(!pass)continue;
      const key=polyId||polySlug,tt=teamsFromEvent(pm);
      const existing=tracked.get(key);
      if(existing){
        existing.sofaId=String(s.id);
        existing.slug=polySlug||existing.slug;
        existing.href=polyEventUrl(pm)||existing.href;
        existing.home=tt[0]||home;
        existing.away=tt[1]||away;
        existing.odds=formatOne(sofa.one);
        if(existing.exact11First==null&&sofa.exact!=null)existing.exact11First=sofa.exact;
        if(sofa.exact!=null)existing.exact11Current=sofa.exact;
        existing.priceDiff=diff;
        found.push(existing);
      }else{
        const row={
          key,sofaId:String(s.id),slug:polySlug,href:polyEventUrl(pm),
          home:tt[0]||home,away:tt[1]||away,startMs:Date.now(),
          odds:formatOne(sofa.one),exact11First:sofa.exact,exact11Current:sofa.exact,priceDiff:diff,
          lastScore:score,lastMinute:minute,lastStatus:t(s?.status?.type),nextSent:false,liveSent:false
        };
        tracked.set(key,row);
        found.push(row);
      }
      log(JSON.stringify({event:"live_filter_passed",key,teams:[home,away],minute,score,source:"sofascore_only"}));
    }catch(err){
      log(JSON.stringify({event:"sofascore_live_candidate_failed",teams:[home,away],message:err.message}));
    }
  }
  return found;
}

async function sendLiveFound(home,away,minute,score,sofa,pm){
  const polyId=t(pm?.id||pm?.eventId),key="LIVE_FOUND:"+polyId;
  const c=await claim(key);
  if(!c.claimed){
    log(JSON.stringify({event:"live_found_claim_blocked",type:"LIVE_FOUND",key,teams:[home,away],polyId,reason:"convex_dedupe"}));
    return false;
  }
  log(JSON.stringify({event:"live_found_claimed",type:"LIVE_FOUND",key,teams:[home,away],polyId}));
  const href=polyEventUrl(pm);
  const one=sofa.one?formatOne(sofa.one):"—";
  const exact=sofa.exact!=null?pct(sofa.exact):"—";
  const message=["🔎 LIVE FOUND","",home+" vs "+away,"LIVE · "+minute+"′","SCORE: "+score.home+"–"+score.away,"1X2: "+one,"1:1 YES: "+exact,"➡️ OPEN MATCH","https://polymarket.com"+href].join("\n");
  try{
    const sent=await telegram(message,c.replyToMessageId??null);
    await saveId(key,sent.message_id);
    log(JSON.stringify({event:"telegram_alert_sent",type:"LIVE_FOUND",key,teams:[home,away],messageId:sent.message_id}));
    return true;
  }catch(err){
    await release(key);
    log(JSON.stringify({event:"telegram_alert_failed",type:"LIVE_FOUND",key,message:err.message}));
    return false;
  }
}
async function sendDataCheck(home,away,minute,sofa,pm){
  const polyId=t(pm?.id||pm?.eventId),key="DATA_CHECK:"+polyId;
  const c=await claim(key);
  if(!c.claimed)return false;
  const href=polyEventUrl(pm);
  const message=["⚠️ DATA CHECK","",home+" vs "+away,"LIVE · "+minute+"′","1X2: "+(sofa.one?formatOne(sofa.one):"—"),"1:1 YES: —","Причина: Sofascore не отдал live 1:1","➡️ OPEN MATCH","https://polymarket.com"+href].join("\n");
  try{
    const sent=await telegram(message,c.replyToMessageId??null);
    await saveId(key,sent.message_id);
    log(JSON.stringify({event:"telegram_alert_sent",type:"DATA_CHECK",key,teams:[home,away],messageId:sent.message_id}));
    return true;
  }catch(err){
    await release(key);
    log(JSON.stringify({event:"telegram_alert_failed",type:"DATA_CHECK",key,message:err.message}));
    return false;
  }
}
async function sendNext(row,score){
  const alertKey=row.key+":NEXT",c=await claim(alertKey);
  if(!c.claimed)return false;
  const message=["⚽ BUY","",row.home+" vs "+row.away,"1:1 YES: "+pct(row.exact11First),"",row.odds,"","➡️ OPEN MATCH","https://polymarket.com"+row.href].join("\n");
  try{
    const sent=await telegram(message,c.replyToMessageId??null);await saveId(alertKey,sent.message_id);row.nextMessageId=sent.message_id;
    log(JSON.stringify({event:"telegram_alert_sent",type:"BUY",key:row.key,score,messageId:sent.message_id}));
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
  const current=row.exact11Current;
  if(row.exact11First==null||current==null){
    log(JSON.stringify({event:"sell_skipped_exact11_missing",key:row.key,first:row.exact11First,current}));
    await release(alertKey);
    return false;
  }
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

  for(const [key,row] of [...tracked]){
    try{
      const ev=(arr((await sofascoreLive())?.events)).find(e=>String(e?.id)===String(row.sofaId));
      if(!ev){
        log(JSON.stringify({event:"tracked_match_not_in_live_snapshot",key,sofaId:row.sofaId,teams:[row.home,row.away]}));
        continue;
      }
      const score={home:Number(ev?.homeScore?.current),away:Number(ev?.awayScore?.current)};
      const status=t(ev?.status?.type);
      const minute=sofascoreMinute(ev);
      const scoreChanged=!row.lastScore||score.home!==row.lastScore.home||score.away!==row.lastScore.away;

      try{
        const sofa=await sofascoreOdds(row.sofaId,row.home,row.away);
        if(sofa.one){
          row.odds=formatOne(sofa.one);
          row.priceDiff=Math.abs(sofa.one.home-sofa.one.away);
        }
        if(sofa.exact!=null)row.exact11Current=sofa.exact;
      }catch(err){
        log(JSON.stringify({event:"tracked_sofascore_odds_failed",key,sofaId:row.sofaId,message:err.message}));
      }

      log(JSON.stringify({event:"tracked_match_update",key,sofaId:row.sofaId,teams:[row.home,row.away],minute,score,status,scoreChanged}));

      if(scoreChanged && row.nextSent){
        await sendSell(row,score);
      }

      if(status!=="inprogress" && row.nextSent && !row.lossSent && score.home===0 && score.away===0){
        const sent=await sendLoss(row,score);
        if(sent)row.lossSent=true;
      }

      row.lastScore=score;
      row.lastMinute=minute;
      row.lastStatus=status;
    }catch(err){
      log(JSON.stringify({event:"tracked_match_update_failed",key,sofaId:row.sofaId,message:err.message}));
    }
  }

  for(const [key,row] of [...tracked]){
    if(!row.nextSent){
      const sent=await sendNext(row,row.lastScore||{home:0,away:0});
      if(sent)row.nextSent=true;
    }
  }
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