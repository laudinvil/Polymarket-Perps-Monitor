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
const polymarketSportsLiveState = new Map();
let sportsWs = null;
let sportsWsReconnectTimer = null;

function parseSportsWsMessage(raw){
  if(typeof raw !== "string")return;
  if(raw === "ping"){ try{sportsWs?.send("pong");}catch{} return; }
  let msg;
  try{msg=JSON.parse(raw);}catch{return;}

  const type=t(msg?.type||msg?.event_type||msg?.eventType);
  if(type && type!=="sport_result" && type!=="sportResult")return;

  const candidates=[];
  const add=(v)=>{
    if(!v || typeof v!=="object" || Array.isArray(v))return;
    if(!candidates.includes(v))candidates.push(v);
  };
  add(msg?.payload);
  add(msg?.data);
  add(msg?.result);
  add(msg);
  for(const root of [...candidates]){
    add(root?.data);
    add(root?.event);
    add(root?.sport_result);
    add(root?.sportResult);
    add(root?.payload);
  }

  const pick=(keys)=>{
    for(const obj of candidates){
      for(const key of keys){
        const v=obj?.[key];
        if(v!==undefined&&v!==null&&v!=="")return v;
      }
    }
    return null;
  };
  const slug=t(pick(["slug","eventSlug","event_slug"]));
  const id=t(pick(["id","eventId","event_id","sportEventId","sport_event_id"]));
  if(!slug && !id){
    log(JSON.stringify({event:"polymarket_sports_ws_unparsed",type,keys:Object.keys(msg||{}),preview:JSON.stringify(msg).slice(0,1200)}));
    return;
  }

  const normalized={
    ...Object.assign({}, ...candidates),
    slug:slug||undefined,
    id:id||undefined,
    live:pick(["live","isLive","is_live","inPlay","inplay"]),
    ended:pick(["ended","isEnded","is_ended","finished"]),
    status:pick(["status","gameStatus","game_status","state"]),
    score:pick(["score","liveScore","live_score","result"]),
    homeScore:pick(["homeScore","home_score","homeGoals","home_goals"]),
    awayScore:pick(["awayScore","away_score","awayGoals","away_goals"]),
    minute:pick(["minute","minutes","matchMinute","match_minute","elapsed"]),
    elapsed:pick(["elapsed","minute","minutes","matchMinute","match_minute"]),
    period:pick(["period","currentPeriod","current_period","phase"]),
    leagueAbbreviation:pick(["leagueAbbreviation","league_abbreviation","league","competition","sport"])
  };

  // Index by slug and id. Keep the raw message for diagnostics and robust
  // score/minute extraction even when Polymarket changes nesting.
  const keys=[slug,id].filter(Boolean);
  for(const key of keys)polymarketSportsLiveState.set(key,normalized);

  log(JSON.stringify({
    event:"polymarket_sports_ws_update",
    slug:slug||null,
    id:id||null,
    league:t(normalized.leagueAbbreviation).toLowerCase(),
    status:normalized.status,
    live:normalized.live,
    ended:normalized.ended,
    score:normalized.score,
    homeScore:normalized.homeScore,
    awayScore:normalized.awayScore,
    period:normalized.period,
    elapsed:normalized.elapsed
  }));
}

function startPolymarketSportsWs(){
  if(typeof WebSocket!=="function"){
    log(JSON.stringify({event:"polymarket_sports_ws_unavailable",reason:"global WebSocket is unavailable"}));
    return;
  }
  const connect=()=>{
    if(stopped)return;
    try{
      const ws=new WebSocket("wss://sports-api.polymarket.com/ws");
      sportsWs=ws;
      ws.onopen=()=>log(JSON.stringify({event:"polymarket_sports_ws_connected"}));
      ws.onmessage=ev=>{
        const raw=String(ev.data||"");
        if(raw!=="ping")log(JSON.stringify({event:"polymarket_sports_ws_message",bytes:raw.length,preview:raw.slice(0,500)}));
        parseSportsWsMessage(raw);
      };
      ws.onerror=()=>log(JSON.stringify({event:"polymarket_sports_ws_error"}));
      ws.onclose=()=>{
        if(sportsWs===ws)sportsWs=null;
        if(stopped)return;
        log(JSON.stringify({event:"polymarket_sports_ws_closed"}));
        clearTimeout(sportsWsReconnectTimer);
        sportsWsReconnectTimer=setTimeout(connect,3000);
      };
    }catch(err){
      log(JSON.stringify({event:"polymarket_sports_ws_connect_failed",message:err.message}));
      clearTimeout(sportsWsReconnectTimer);
      sportsWsReconnectTimer=setTimeout(connect,3000);
    }
  };
  connect();
}
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
  const direct=arr((await json(POLY_SEARCH_URL+"?q="+encodeURIComponent(home+" "+away)+"&limit_per_type=50&keep_closed_markets=0",5000))?.events);
  if(direct.some(e=>e?.active!==false&&e?.closed!==true&&sameMatch(e,home,away)))return direct;
  const variants=[home+" "+away,home,away];
  const merged=[...direct];
  for(const q of variants.slice(1)){
    try{
      const extra=arr((await json(POLY_SEARCH_URL+"?q="+encodeURIComponent(q)+"&limit_per_type=50&keep_closed_markets=0",5000))?.events);
      for(const e of extra){
        const id=t(e?.id||e?.eventId||e?.slug);
        if(id&&!merged.some(x=>t(x?.id||x?.eventId||x?.slug)===id))merged.push(e);
      }
    }catch(err){
      log(JSON.stringify({event:"polymarket_search_variant_failed",teams:[home,away],query:q,message:err.message}));
    }
  }
  if(merged.some(e=>e?.active!==false&&e?.closed!==true&&sameMatch(e,home,away)))return merged;
  // Last-resort active-event scan: the search endpoint can omit live sports events.
  for(let offset=0;offset<1000;offset+=200){
    try{
      const page=await json(GAMMA+"/events?active=true&closed=false&limit=200&offset="+offset,5000);
      const events=arr(page?.events||page);
      if(!events.length)break;
      for(const e of events){
        const id=t(e?.id||e?.eventId||e?.slug);
        if(id&&!merged.some(x=>t(x?.id||x?.eventId||x?.slug)===id))merged.push(e);
      }
      if(events.length<200)break;
    }catch(err){
      log(JSON.stringify({event:"polymarket_active_events_scan_failed",teams:[home,away],offset,message:err.message}));
      break;
    }
  }
  return merged;
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
    if(!os.length||os.length!==ps.length)continue;
    const q=t(m?.question||m?.title||m?.groupItemTitle||m?.slug).toLowerCase();
    const qn=norm(q);
    const isOne=/1x2|match result|full time result|match winner|winner|moneyline/.test(qn)
      || qn.includes(h) || qn.includes(a) || qn.includes("draw") || qn.includes("tie");
    if(!isOne)continue;
    for(let i=0;i<os.length;i++){
      const raw=t(os[i]),n=norm(raw),price=ps[i];
      if(!(price>0&&price<=1))continue;
      if(n==="yes"||n==="no")continue;
      if(n==="draw"||n==="tie"||raw.toUpperCase()==="X"||qn.includes("draw")&&n==="yes")out.draw=price;
      else if(n==="1"||n==="home"||n===h||teamMatch(n,h))out.home=price;
      else if(n==="2"||n==="away"||n===a||teamMatch(n,a))out.away=price;
    }
    // Some Polymarket markets expose YES/NO as separate child markets,
    // where the team name is in the question and YES is the price.
    const yi=os.findIndex(x=>norm(x)==="yes");
    if(yi>=0&&ps[yi]>0&&ps[yi]<=1){
      const yes=ps[yi];
      if(qn.includes("draw")||qn.includes("tie"))out.draw=yes;
      else if(qn.includes(h))out.home=yes;
      else if(qn.includes(a))out.away=yes;
    }
  }
  return out.home>0&&out.draw>0&&out.away>0?out:null;
}

async function loadPolyMarkets(...events){
  const merged=new Map();
  const slugs=new Set();
  for(const e of events){
    const slug=t(e?.slug);
    if(slug)slugs.add(slug);
    for(const m of arr(e?.markets)){
      const mid=t(m?.id||m?.marketId||m?.conditionId||m?.slug);
      if(mid)merged.set(mid,m);
    }
  }
  const bases=[...slugs];
  for(const slug of bases){
    const base=slug.replace(/-(?:player-props|player-props-live|exact-score|match-result|moneyline|1x2|game-lines|game-line)$/i,"");
    for(const candidate of [slug,base,base+"-exact-score",base+"-match-result",base+"-moneyline",base+"-1x2"]){
      try{
        const data=await json(GAMMA+"/events?slug="+encodeURIComponent(candidate),4500);
        const evs=arr(data?.events||data);
        for(const ev of evs){
          for(const m of arr(ev?.markets)){
            const mid=t(m?.id||m?.marketId||m?.conditionId||m?.slug);
            if(mid)merged.set(mid,m);
          }
        }
      }catch(err){
        log(JSON.stringify({event:"polymarket_event_markets_fetch_failed",slug:candidate,message:err.message}));
      }
    }
  }
  const markets=[...merged.values()];
  log(JSON.stringify({
    event:"polymarket_markets_loaded",
    slugs:bases,
    count:markets.length,
    markets:markets.slice(0,40).map(m=>({
      id:m?.id,
      question:m?.question||m?.title||m?.groupItemTitle||m?.slug,
      outcomes:m?.outcomes,
      outcomePrices:m?.outcomePrices??m?.outcome_prices,
      active:m?.active,
      closed:m?.closed
    }))
  }));
  return markets;
}

function exactScore11FromMarkets(markets){
  return exactScore11Yes({markets});
}
function formatOne(p){return "1: "+pct(p.home)+" · X: "+pct(p.draw)+" · 2: "+pct(p.away);}
function approxPass(sofa,poly){
  if(!sofa?.one||!poly?.one||sofa.exact==null||poly.exact==null)return false;
  return Math.max(Math.abs(sofa.one.home-poly.one.home),Math.abs(sofa.one.draw-poly.one.draw),Math.abs(sofa.one.away-poly.one.away),Math.abs(sofa.exact-poly.exact))<=APPROX_MAX_DIFF;
}
function polyEventUrl(e){return t(e?.slug)?"/event/"+e.slug:"";}
async function fixtureParentEvent(e){
  const slug=t(e?.slug);
  if(!slug)return e;
  // Sports live-state can point at a child event such as
  // "-player-props" or "-exact-score".  That child is NOT the canonical
  // match page and normally has no live score/minute. Resolve all known
  // football submarket suffixes back to the parent fixture.
  const base=slug
    .replace(/-(?:player-props|player-props-live|exact-score|match-result|moneyline|1x2|game-lines|game-line)$/i,"");
  if(base===slug)return e;
  try{
    const page=await json(GAMMA+"/events?slug="+encodeURIComponent(base),3500);
    const events=arr(page?.events||page);
    const hit=events.find(x=>t(x?.slug)===base);
    if(hit){
      log(JSON.stringify({event:"fixture_parent_resolved",sourceSlug:slug,parentSlug:hit.slug,parentId:hit.id}));
      return hit;
    }
    log(JSON.stringify({event:"fixture_parent_not_found",sourceSlug:slug,base}));
    return e;
  }catch(err){
    log(JSON.stringify({event:"fixture_parent_fetch_failed",slug,base,message:err.message}));
    return e;
  }
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
function sportsWsScore(ws){
  if(!ws)return null;
  const pairs=[
    [ws.homeScore,ws.awayScore],
    [ws.home_score,ws.away_score],
    [ws.score?.home,ws.score?.away],
    [ws.score?.homeScore,ws.score?.awayScore],
    [ws.score?.home_score,ws.score?.away_score],
    [ws.liveScore?.home,ws.liveScore?.away],
    [ws.live_score?.home,ws.live_score?.away]
  ];
  for(const pair of pairs){
    const home=Number(pair[0]),away=Number(pair[1]);
    if(Number.isFinite(home)&&Number.isFinite(away)&&home>=0&&away>=0&&home<=20&&away<=20)
      return {home,away};
  }
  for(const rawValue of [ws.score,ws.result,ws.liveScore,ws.live_score]){
    const raw=typeof rawValue==="string"?rawValue:JSON.stringify(rawValue||"");
    const m=raw.match(/(^|[^0-9])(\d{1,2})\s*[-–:]\s*(\d{1,2})(?=$|[^0-9])/);
    if(m){
      const home=Number(m[2]),away=Number(m[3]);
      if(home<=20&&away<=20)return {home,away};
    }
  }
  return null;
}
function sportsWsMinute(ws){
  if(!ws)return null;
  for(const v of [ws.minute,ws.elapsed,ws.matchMinute,ws.match_minute]){
    if(typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=150)return Math.floor(v);
    const raw=t(v);
    const m=raw.match(/(\d{1,3})/);
    if(m){
      const n=Number(m[1]);
      if(n>=0&&n<=150)return n;
    }
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
  const markets=await loadPolyMarkets(e);
  const value=exactScore11FromMarkets(markets);
  if(value!==null)log(JSON.stringify({event:"exact_score_11_source",source:"event_slug_markets",price:pct(value)}));
  return value;
}
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
async function polymarketSportsLive(){
  const sports=arr(await json(GAMMA+"/sports",5000));
  const soccerSports=sports.filter(s=>{
    const name=t(s?.sport||s?.name||s?.slug).toLowerCase();
    return /soccer|football/.test(name);
  });

  // Build the candidate set only from soccer/football sport definitions.
  // Do not use a generic hard-coded tag and do not use related tags.
  const tagIds=new Set();
  const seriesIds=new Set();
  const SOCCER_TAG_ID="100350";
  for(const s of soccerSports){
    const series=t(s?.series);
    if(series)seriesIds.add(series);
    const values=[];
    for(const key of ["tags","tagIds","tag_ids","tagId","tag_id","primaryTagId","primary_tag_id"]){
      const v=s?.[key];
      if(Array.isArray(v))values.push(...v);
      else if(typeof v==="string")values.push(...v.split(/[,\\s]+/));
    }
    for(const v of values){
      const id=typeof v==="object" ? t(v?.id||v?.tagId||v?.tag_id) : t(v);
      if(id && id!=="1" && id!=="100639")tagIds.add(id);
    }
  }
  if(soccerSports.length)tagIds.add(SOCCER_TAG_ID);

  const merged=new Map();
  const ingest=page=>{
    for(const e of arr(page?.events||page)){
      const id=t(e?.id||e?.eventId||e?.slug);
      if(id)merged.set(id,e);
    }
  };
  // Direct soccer slug query is the most reliable discovery path; the
  // sports metadata/tag-id relationship can vary by league.
  try{
    const page=await json(GAMMA+"/events?tag_slug=soccer&active=true&closed=false&limit=500&order=startDate&ascending=false",5000);
    ingest(page);
  }catch(err){
    log(JSON.stringify({event:"polymarket_soccer_slug_events_failed",message:err.message}));
  }

  for(const tagId of tagIds){
    try{
      const page=await json(GAMMA+"/events?tag_id="+encodeURIComponent(tagId)+"&related_tags=false&closed=false&limit=100&order=volume24hr&ascending=false",5000);
      ingest(page);
    }catch(err){
      log(JSON.stringify({event:"polymarket_sports_events_failed",tagId,message:err.message}));
    }
  }
  for(const seriesId of seriesIds){
    try{
      const page=await json(GAMMA+"/events?series_id="+encodeURIComponent(seriesId)+"&closed=false&limit=100&order=volume24hr&ascending=false",5000);
      ingest(page);
    }catch(err){
      log(JSON.stringify({event:"polymarket_sports_series_events_failed",seriesId,message:err.message}));
    }
  }
  const all=[...merged.values()];
  const liveStatuses=new Set(["live","inprogress","in progress","halftime","break","paused","suspended","interrupted"]);

  // Gamma provides the football event/market universe; the dedicated
  // Polymarket Sports WebSocket provides the authoritative live state.
  // Do not infer LIVE merely because an event's scheduled start time passed.
  const live=[];
  for(const e of all){
    const slug=t(e?.slug);
    const eid=t(e?.id||e?.eventId);
    const ws= (slug&&polymarketSportsLiveState.get(slug))
      || (eid&&polymarketSportsLiveState.get(eid))
      || null;
    const status=t(ws?.status||e?.gameStatus||e?.game_status||e?.status||e?.state).toLowerCase();
    const started=startMs(e);
    const startedNow=!Number.isFinite(started)||started<=Date.now();
    const wsLive=(ws?.live===true||ws?.live==="true"||ws?.live===1||ws?.live==="1"||
      /live|in.?progress|halftime|break|paused|suspended|interrupted/i.test(t(ws?.status))) &&
      ws?.ended!==true && ws?.ended!=="true";
    const gammaLive=e?.live===true||e?.isLive===true||liveStatuses.has(status);
    if(startedNow && (wsLive||gammaLive)){
      live.push(ws ? {...e,__sportsWs:ws} : e);
    }
  }

  // If the WS announced a live fixture that Gamma's soccer event list did not
  // include, recover it by matching the announced slug/id against active
  // Gamma events. This prevents the WS state from being discarded merely
  // because the two feeds expose different event universes.
  for(const [wsKey,ws] of polymarketSportsLiveState){
    const wsLive=(ws?.live===true||ws?.live==="true"||ws?.live===1||ws?.live==="1"||
      /live|in.?progress|halftime|break|paused|suspended|interrupted/i.test(t(ws?.status))) &&
      ws?.ended!==true && ws?.ended!=="true";
    if(!wsLive)continue;
    const hit=all.find(e=>t(e?.slug)===t(ws?.slug)||t(e?.id||e?.eventId)===t(ws?.id));
    if(hit){
      if(!live.some(e=>t(e?.id||e?.eventId||e?.slug)===t(hit?.id||hit?.eventId||hit?.slug)))
        live.push({...hit,__sportsWs:ws});
    }
  }

  log(JSON.stringify({
    event:"polymarket_live_snapshot",
    sports:soccerSports.map(s=>({sport:s?.sport,name:s?.name,slug:s?.slug,tags:s?.tags,tagIds:s?.tagIds||s?.tag_ids})),
    tagIds:[...tagIds],
    total:all.length,
    live:live.length,
    liveMatches:live.slice(0,20).map(e=>{
      const tt=teamsFromEvent(e);
      return {id:e?.id,slug:e?.slug,teams:tt,gameStatus:e?.gameStatus,live:e?.live,score:eventScore(e)};
    })
  }));
  return live;
}

async function discoverLiveZeroZero(){
  // PRIMARY: Polymarket's own sports/live state. Sofascore is enrichment, not the gate.
  const polyLive=await polymarketSportsLive();
  const sofaPayload=await sofascoreLive().catch(err=>{
    log(JSON.stringify({event:"sofascore_live_optional_failed",message:err.message}));
    return {events:[]};
  });
  const sofaEvents=arr(sofaPayload?.events);
  const liveTypes=new Set(["live","inprogress","halftime","break","paused","suspended","interrupted"]);
  const sofaLive=sofaEvents.filter(e=>liveTypes.has(t(e?.status?.type).toLowerCase()));
  log(JSON.stringify({
    event:"sofascore_live_snapshot",
    total:sofaEvents.length,
    inprogress:sofaLive.length,
    liveTypes:[...new Set(sofaEvents.map(e=>t(e?.status?.type).toLowerCase()).filter(Boolean))]
  }));

  const found=[];
  for(const pm of polyLive){
    const fixture=await fixtureParentEvent(pm);
    const [phome,paway]=teamsFromEvent(fixture);
    if(!phome||!paway)continue;

    // LIVE_FOUND is a real alert, not a discovery ping. Require the
    // canonical fixture and both requested Polymarket market values.
    // Polymarket often keeps the actual 1X2 / correct-score contracts
    // in child markets rather than on the canonical fixture object.
    // Load markets for BOTH the live child and canonical fixture.
    const polyMarkets=await loadPolyMarkets(fixture,pm);
    const polyMarketEvent={markets:polyMarkets};
    const polyOne=parsePolyOneXTwo(polyMarketEvent,phome,paway);
    const polyExact=exactScore11FromMarkets(polyMarkets);
    // The live-state source is the tagged Polymarket child event (pm).
    // fixtureParentEvent() is used only to recover the canonical fixture and
    // its URL/markets. The parent often has no live/status flags of its own,
    // so requiring fixture.live here can reject every real live match.
    const fixtureStarted=startMs(fixture);
    const sourceStarted=startMs(pm);
    const effectiveStartMs=Number.isFinite(fixtureStarted)?fixtureStarted:sourceStarted;
    const fixtureStatus=t(fixture?.gameStatus||fixture?.game_status||fixture?.status||fixture?.state).toLowerCase();
    const sourceStatus=t(pm?.gameStatus||pm?.game_status||pm?.status||pm?.state).toLowerCase();
    const ws=pm?.__sportsWs||null;\n    const wsStatus=t(ws?.status).toLowerCase();\n    const sourceLive=pm?.live===true||pm?.isLive===true||liveTypes.has(sourceStatus)||\n      ws?.live===true||ws?.live==="true"||ws?.live===1||ws?.live==="1"||liveTypes.has(wsStatus);
    const canonicalLive=fixture?.live===true||fixture?.isLive===true||liveTypes.has(fixtureStatus);
    const fixtureLive=Number.isFinite(effectiveStartMs)&&effectiveStartMs<=Date.now()&&(sourceLive||canonicalLive);
    if(!fixtureLive){
      log(JSON.stringify({
        event:"live_candidate_rejected_not_started",
        sourceSlug:pm?.slug,
        fixtureSlug:fixture?.slug,
        startMs:effectiveStartMs,
        fixtureStatus,
        sourceStatus,
        sourceLive:!!sourceLive,
        canonicalLive:!!canonicalLive
      }));
      continue;
    }
    // Missing 1X2 / 1:1 data must NOT suppress the first LIVE alert.
    // These values are enrichment for the alert, not the live-match gate.
    if(!polyOne||polyExact==null){
      log(JSON.stringify({
        event:"live_market_data_incomplete",
        teams:[phome,paway],
        sourceSlug:pm?.slug,
        fixtureSlug:fixture?.slug,
        has1X2:!!polyOne,
        hasExact11:polyExact!=null
      }));
    }

    try{
      // The canonical fixture id is the dedupe identity. Exact-score child
      // markets must never create a second alert for the same match.
      const canonicalId=t(fixture?.id||fixture?.eventId||fixture?.slug);
      if(!canonicalId){
        log(JSON.stringify({event:"live_candidate_rejected_no_canonical_id",sourceSlug:pm?.slug,teams:[phome,paway]}));
        continue;
      }
      fixture.id=fixture.id||canonicalId;

      const sofaEvent=sofaLive.find(s=>{
        const home=t(s?.homeTeam?.name),away=t(s?.awayTeam?.name);
        return sameMatch({homeTeam:home,awayTeam:away},phome,paway);
      });
      const polyScore=eventScore(pm);
      const wsScore=sportsWsScore(pm?.__sportsWs);
      const sofaScore=sofaEvent ? {
        home:Number(sofaEvent?.homeScore?.current),
        away:Number(sofaEvent?.awayScore?.current)
      } : null;
      const score=wsScore || polyScore || (
        sofaScore && Number.isFinite(sofaScore.home) && Number.isFinite(sofaScore.away) &&
        sofaScore.home>=0 && sofaScore.away>=0 ? sofaScore : null
      );
      const minute=sportsWsMinute(pm?.__sportsWs) ?? (sofaEvent?sofascoreMinute(sofaEvent):null);
      if(!score || minute==null){
        log(JSON.stringify({
          event:"live_alert_blocked_missing_live_state",
          teams:[phome,paway],
          sourceSlug:pm?.slug,
          fixtureSlug:fixture?.slug,
          sofascoreMatched:!!sofaEvent,
          polyScore,
          wsScore,
          sofaScore,
          minute,
          reason:"no_verified_score_or_minute"
        }));
        continue;
      }
      let sofa={one:null,exact:null};
      if(sofaEvent){
        sofa=await sofascoreOdds(sofaEvent.id,phome,paway);
      }
      log(JSON.stringify({
        event:"polymarket_live_candidate",
        teams:[phome,paway],
        polyId:pm?.id||pm?.eventId,
        slug:pm?.slug,
        gameStatus:pm?.gameStatus,
        live:pm?.live,
        score,
        minute,
        sofascoreMatched:!!sofaEvent,
        sofaId:sofaEvent?.id||null,
        sofa
      }));

      // Market prices are Polymarket-only. Missing contracts must not
      // suppress the first LIVE alert; show an em dash until the contract
      // becomes available, while keeping the candidate fully diagnosed.
      const alertPrices={
        one:polyOne||null,
        exact:polyExact!=null?polyExact:null
      };
      await sendLiveFound(phome,paway,minute,score,alertPrices,fixture);

      if(!sofaEvent)continue;
      if(!sofa.one||sofa.exact==null){
        log(JSON.stringify({
          event:"sofascore_required_odds_missing",
          teams:[phome,paway],
          minute,
          has1x2:!!sofa.one,
          hasExact11:sofa.exact!=null,
          sofa
        }));
        if(sofa.one&&sofa.exact==null)await sendDataCheck(phome,paway,minute,sofa,pm);
        continue;
      }

      const polyId=t(pm.id||pm.eventId),polySlug=t(pm.slug);
      const diff=Math.abs(sofa.one.home-sofa.one.away);
      const pass=diff<=APPROX_MAX_DIFF;
      log(JSON.stringify({
        event:"live_filter_check",
        teams:[phome,paway],
        minute,
        score,
        sofa,
        homePrice:sofa.one.home,
        awayPrice:sofa.one.away,
        diff,
        threshold:APPROX_MAX_DIFF,
        pass,
        polymarketEventId:polyId,
        polymarketSlug:polySlug
      }));
      if(!pass)continue;

      const key=polyId||polySlug;
      const existing=tracked.get(key);
      if(existing){
        existing.sofaId=String(sofaEvent.id);
        existing.slug=polySlug||existing.slug;
        existing.href=polyEventUrl(pm)||existing.href;
        existing.home=phome;
        existing.away=paway;
        existing.odds=formatOne(sofa.one);
        if(existing.exact11First==null&&sofa.exact!=null)existing.exact11First=sofa.exact;
        if(sofa.exact!=null)existing.exact11Current=sofa.exact;
        existing.priceDiff=diff;
        found.push(existing);
      }else{
        const row={
          key,
          sofaId:String(sofaEvent.id),
          slug:polySlug,
          href:polyEventUrl(pm),
          home:phome,
          away:paway,
          startMs:Date.now(),
          odds:formatOne(sofa.one),
          exact11First:sofa.exact,
          exact11Current:sofa.exact,
          priceDiff:diff,
          lastScore:score,
          lastMinute:minute,
          lastStatus:t(sofaEvent?.status?.type),
          nextSent:false,
          liveSent:false
        };
        tracked.set(key,row);
        found.push(row);
      }
      log(JSON.stringify({event:"live_filter_passed",key,teams:[phome,paway],minute,score,source:"polymarket_live+sofascore"}));
    }catch(err){
      log(JSON.stringify({event:"polymarket_live_candidate_failed",teams:[phome,paway],message:err.message}));
    }
  }
  return found;
}

async function sendLiveFound(home,away,minute,score,sofa,pm){
  // pm is the canonical fixture passed by discoverLiveZeroZero().
  // Use the fixture identity for dedupe so exact-score/live child events
  // cannot poison or duplicate the same fixture's LIVE alert.
  const polyId=t(pm?.id||pm?.eventId||pm?.slug),key="LIVE_FOUND:"+polyId;
  if(!polyId)return false;

  // One LIVE_FOUND per canonical fixture. Never send a new Telegram message
  // merely because the poll cycle saw the same match again.
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
  // Diagnostic only. Missing market data must never create a second Telegram
  // message or turn a single fixture into alert spam.
  log(JSON.stringify({
    event:"data_check",
    type:"DATA_CHECK",
    teams:[home,away],
    minute,
    polyId:t(pm?.id||pm?.eventId),
    has1X2:!!sofa?.one,
    hasExact11:sofa?.exact!=null,
    reason:"required_live_market_data_missing"
  }));
  return false;
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
  startPolymarketSportsWs();
  // Give the public Sports WebSocket a moment to deliver its initial
  // active-event snapshot before the first discovery pass.
  await new Promise(r=>setTimeout(r,1500));
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