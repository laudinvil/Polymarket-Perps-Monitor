const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const VERSION = "26.8.11-BTC-5M-15M-1H-NO-COMPARE";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const AGGR_URL = process.env.AGGR_URL || "http://127.0.0.1:9090/liquidations";
const STATE_FILE = process.env.STATE_FILE || "/data/aggr-liquidation-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/aggr-liquidation.jsonl";
const SYMBOLS = new Set(["BTC"]);
const MAX_SEEN = 10000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_BYTES = 1 * 1024 * 1024;
const FEED_SUMMARY_LOG_MS = 60000;
const CLOB_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
let clobLive = {period:null,symbol:null,slug:null,upTokenId:null,downTokenId:null,up:null,down:null,upSize:null,downSize:null,updatedAtMs:null,ws:null,connecting:false};

let state, groupTimer = null, aggrConnected = false, aggrEvents = 0, aggrLastEventAt = null;
let aggrReconnectTimer = null, skippedEvents = 0, ignoredEvents = 0, acceptedSinceSummary = 0;
let aggrRequest = null, alertInFlight = new Set(), logSubscribers = new Set();
let liquidationQueue = Promise.resolve(), aggrHealth = null, aggrHealthTimer = null;

function nowIso(){return new Date().toISOString();}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function ensureDir(file){fs.mkdirSync(path.dirname(file),{recursive:true});}
function broadcastLogRow(row){const p="data: "+JSON.stringify(row)+"\n\n";for(const res of logSubscribers){try{res.write(p);}catch{logSubscribers.delete(res);}}}
function appendLogRow(row){try{ensureDir(LOG_FILE);fs.appendFileSync(LOG_FILE,JSON.stringify(row)+"\n");broadcastLogRow(row);try{const size=fs.statSync(LOG_FILE).size;if(size>LOG_MAX_BYTES){const fd=fs.openSync(LOG_FILE,"r");const buffer=Buffer.alloc(LOG_KEEP_BYTES);fs.readSync(fd,buffer,0,LOG_KEEP_BYTES,Math.max(0,size-LOG_KEEP_BYTES));fs.closeSync(fd);const start=buffer.indexOf(0x0a);fs.writeFileSync(LOG_FILE,start>=0?buffer.subarray(start+1):buffer);}}catch{}}catch{}}
let lastFeedSummaryLogAt=0;
const DEPLEXO_QUIET_EVENTS = new Set(["FEED_STATUS","CLOB_PRICE_ATTEMPT"]);
function log(event,data={}){
 if(event==="FEED_STATUS"){
  const now=Date.now();
  if(now-lastFeedSummaryLogAt<FEED_SUMMARY_LOG_MS)return;
  lastFeedSummaryLogAt=now;
 }
 const row={ts:nowIso(),version:VERSION,event,...data};
 appendLogRow(row);
 if(DEPLEXO_QUIET_EVENTS.has(event))return;
 console.log(JSON.stringify(row));
}

function defaultState(){return{version:VERSION,strategy:"AGGR_LIQUIDATIONS",updatedAt:nowIso(),seen:[],alertedLinks:[],alertedPeriodKey:null,alertsSent:0,valueBySymbol:{},countBySymbol:{},periodKey:null,periodCountBySymbol:{},periodValueBySymbol:{},lastPeriodAverageBySymbol:{},lastAlertAverage:null,lastAlertLiqs:null,lastCompletedPeriodLiqs:null,lastPeriodEvent:null,lastEventTs:null,lastEventKey:null};}
function loadState(){try{const value=JSON.parse(fs.readFileSync(STATE_FILE,"utf8"));if(value&&typeof value==="object")return value;}catch{}return defaultState();}
function saveState(){state.updatedAt=nowIso();try{ensureDir(STATE_FILE);const tmp=STATE_FILE+".tmp";fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,STATE_FILE);}catch(e){log("STATE_WRITE_ERROR",{error:String(e.message||e)});}}
function getLastAlertLiqs(symbol){try{if(!fs.existsSync(LOG_FILE))return 0;const lines=fs.readFileSync(LOG_FILE,"utf8").trim().split("\n");for(let i=lines.length-1;i>=0;i--){try{const row=JSON.parse(lines[i]);if(row.event==="LIQUIDATION_ALERT_SENT"&&row.symbol===symbol){const n=Number(row.count);if(Number.isFinite(n)&&n>0)return n;}}catch{}}}catch{}return 0;}

function sendTelegram(text){const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;if(!token||!chatId){log("TELEGRAM_NOT_CONFIGURED");return Promise.resolve(false);}return fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text}),signal:AbortSignal.timeout(8000)}).then(async response=>{const body=await response.text();if(!response.ok){log("TELEGRAM_ERROR",{status:response.status,body:body.slice(0,1000)});return false;}return true;}).catch(e=>{log("TELEGRAM_ERROR",{error:String(e.message||e)});return false;});}
function hourlyMarketSlug(symbol,nowMs=Date.now()){const parts=new Intl.DateTimeFormat("en-US",{timeZone:"America/New_York",year:"numeric",month:"long",day:"numeric",hour:"numeric",hour12:true}).formatToParts(new Date(nowMs));const p=Object.fromEntries(parts.map(x=>[x.type,x.value]));const hour=Number(p.hour);const meridiem=p.dayPeriod.toLowerCase();return "bitcoin-up-or-down-"+p.month.toLowerCase()+"-"+p.day+"-"+p.year+"-"+hour+meridiem+"-et";}
function polymarket1hUrl(symbol,nowMs=Date.now()){return "https://polymarket.com/event/"+hourlyMarketSlug(symbol,nowMs);}
function marketSlug(symbol,period,size){if(size===3600000)return hourlyMarketSlug(symbol,period);const prefix=size===300000?"5m":"15m";return "btc-updown-"+prefix+"-"+Math.floor(period/1000);}
function marketUrl(symbol,period,size){return "https://polymarket.com/event/"+marketSlug(symbol,period,size);}

async function fetchPolymarketClobPrices(symbol,nowMs=Date.now(),size=3600000){
 const slug=marketSlug(symbol,nowMs,size),fetchedAtStartedMs=Date.now();
 try{
  const gammaResponse=await fetch("https://gamma-api.polymarket.com/events?slug="+encodeURIComponent(slug),{headers:{accept:"application/json"},signal:AbortSignal.timeout(5000)});
  if(!gammaResponse.ok)throw new Error("Gamma HTTP "+gammaResponse.status);
  const gammaBody=await gammaResponse.json(),event=Array.isArray(gammaBody)?gammaBody[0]:gammaBody,markets=Array.isArray(event?.markets)?event.markets:[];
  const market=markets.find(m=>!m.closed&&m.active!==false)||markets[0];if(!market)throw new Error("market not found");
  let tokenIds=market.clobTokenIds,outcomes=market.outcomes;
  if(typeof tokenIds==="string")tokenIds=JSON.parse(tokenIds);if(typeof outcomes==="string")outcomes=JSON.parse(outcomes);
  if(!Array.isArray(tokenIds)||tokenIds.length<2)throw new Error("CLOB token IDs not found");
  if(!Array.isArray(outcomes)||outcomes.length!==tokenIds.length)throw new Error("CLOB outcomes/token IDs mismatch");
  const outcomeToToken={};for(let i=0;i<outcomes.length;i++)outcomeToToken[String(outcomes[i]).trim().toLowerCase()]=tokenIds[i];
  const upTokenId=outcomeToToken.up,downTokenId=outcomeToToken.down;if(!upTokenId||!downTokenId)throw new Error("UP/DOWN token IDs not mapped from Gamma outcomes");

  const [upResponse,downResponse]=await Promise.all([
   fetch("https://clob.polymarket.com/book?token_id="+encodeURIComponent(upTokenId),{headers:{accept:"application/json"},signal:AbortSignal.timeout(5000)}),
   fetch("https://clob.polymarket.com/book?token_id="+encodeURIComponent(downTokenId),{headers:{accept:"application/json"},signal:AbortSignal.timeout(5000)})
  ]);
  if(!upResponse.ok||!downResponse.ok)throw new Error("CLOB book HTTP "+upResponse.status+"/"+downResponse.status);
  const upBook=await upResponse.json();
  const upBookReceivedAtMs=Date.now();
  const downBook=await downResponse.json();
  const downBookReceivedAtMs=Date.now();
  const bestAsk=book=>Array.isArray(book?.asks)?book.asks.map(x=>({price:num(x?.price),size:num(x?.size)})).filter(x=>x.price!==null&&x.size!==null&&x.size>0).sort((a,b)=>a.price-b.price)[0]:null;
  const upAsk=bestAsk(upBook),downAsk=bestAsk(downBook);
  if(!upAsk||!downAsk)throw new Error("CLOB best ask missing");
  const up=upAsk.price,down=downAsk.price;
  if(up<=0||up>1||down<=0||down>1)throw new Error("CLOB best ask outside 0..1");
  const complementarySum=up+down;
  if(Math.abs(up-down)<1e-12){
   log("CLOB_EQUAL_PRICES_IGNORED",{symbol,slug,up,down,fetchedAt:new Date().toISOString(),priceMethod:"CLOB_BOOK_BEST_ASK"});
   return{up,down,slug,upTokenId,downTokenId,priceMethod:"CLOB_BOOK_BEST_ASK",upAskSize:upAsk.size,downAskSize:downAsk.size,complementarySum,equalPrices:true};
  }
  if(complementarySum<0.98)throw new Error("CLOB crossed/inconsistent complementary asks: "+up+"+"+down+"="+complementarySum);
  const fetchedAtFinishedMs=Date.now();
  return{up,down,slug,upTokenId,downTokenId,priceMethod:"CLOB_BOOK_BEST_ASK",upAskSize:upAsk.size,downAskSize:downAsk.size,upAskFetchedAt:new Date(upBookReceivedAtMs).toISOString(),downAskFetchedAt:new Date(downBookReceivedAtMs).toISOString(),upAskFetchedAtMs:upBookReceivedAtMs,downAskFetchedAtMs:downBookReceivedAtMs,complementarySum,fetchedAt:new Date(fetchedAtFinishedMs).toISOString(),fetchedAtMs:fetchedAtFinishedMs,fetchStartedAtMs:fetchedAtStartedMs};
 }catch(e){log("POLYMARKET_CLOB_PRICE_ERROR",{symbol,slug,error:String(e.message||e),priceMethod:"CLOB_BOOK_BEST_ASK"});return null;}
}
async function prepareLiveClob(symbol,period){
 const slug=marketSlug(symbol,period,arguments.length>=3?arguments[2]:3600000);
 if(clobLive.period===period&&clobLive.symbol===symbol&&clobLive.ws&&clobLive.ws.readyState===WebSocket.OPEN)return;
 if(clobLive.ws){try{clobLive.ws.close();}catch{}}
 clobLive={period,symbol,slug,upTokenId:null,downTokenId:null,up:null,down:null,upSize:null,downSize:null,updatedAtMs:null,ws:null,connecting:true};
 try{
  const response=await fetch("https://gamma-api.polymarket.com/events?slug="+encodeURIComponent(slug),{headers:{accept:"application/json"},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error("Gamma HTTP "+response.status);
  const body=await response.json(),event=Array.isArray(body)?body[0]:body,markets=Array.isArray(event?.markets)?event.markets:[];
  const market=markets.find(m=>!m.closed&&m.active!==false)||markets[0];
  if(!market)throw new Error("market not found");
  let tokenIds=market.clobTokenIds,outcomes=market.outcomes;
  if(typeof tokenIds==="string")tokenIds=JSON.parse(tokenIds);
  if(typeof outcomes==="string")outcomes=JSON.parse(outcomes);
  const map={};for(let i=0;i<outcomes.length;i++)map[String(outcomes[i]).trim().toLowerCase()]=tokenIds[i];
  const upTokenId=map.up,downTokenId=map.down;if(!upTokenId||!downTokenId)throw new Error("UP/DOWN token IDs not mapped");
  clobLive.upTokenId=upTokenId;clobLive.downTokenId=downTokenId;
  const ws=new WebSocket(CLOB_WS_URL);clobLive.ws=ws;
  ws.on("open",()=>{ws.send(JSON.stringify({assets_ids:[upTokenId,downTokenId],type:"market"}));clobLive.connecting=false;log("CLOB_WS_CONNECTED",{symbol,period,slug});});
  ws.on("message",raw=>{
   try{
    const msg=JSON.parse(String(raw));
    if(msg.event_type==="price_change"&&Array.isArray(msg.price_changes)){
     for(const change of msg.price_changes){
      const price=num(change.best_ask),size=num(change.best_ask_size??change.size);
      if(String(change.asset_id)===String(upTokenId)&&price!==null){clobLive.up=price;clobLive.upSize=size;clobLive.updatedAtMs=Date.now();}
      if(String(change.asset_id)===String(downTokenId)&&price!==null){clobLive.down=price;clobLive.downSize=size;clobLive.updatedAtMs=Date.now();}
     }
    }else if(msg.event_type==="book"){
     const asset=String(msg.asset_id),asks=Array.isArray(msg.asks)?msg.asks.map(x=>({price:num(x.price),size:num(x.size)})).filter(x=>x.price!==null&&x.size!==null&&x.size>0).sort((a,b)=>a.price-b.price):[];
     if(asks.length){
      if(asset===String(upTokenId)){clobLive.up=asks[0].price;clobLive.upSize=asks[0].size;clobLive.updatedAtMs=Date.now();}
      if(asset===String(downTokenId)){clobLive.down=asks[0].price;clobLive.downSize=asks[0].size;clobLive.updatedAtMs=Date.now();}
     }
    }
   }catch(error){log("CLOB_WS_PARSE_ERROR",{symbol,error:String(error.message||error)});}
  });
  ws.on("error",error=>log("CLOB_WS_ERROR",{symbol,period,error:String(error.message||error)}));
  ws.on("close",()=>{if(clobLive.period===period)clobLive.ws=null;log("CLOB_WS_CLOSED",{symbol,period});});
 }catch(error){clobLive.connecting=false;log("CLOB_WS_PREPARE_ERROR",{symbol,period,error:String(error.message||error)});}
}
function liveClobSnapshot(symbol,period){
 if(clobLive.symbol!==symbol||clobLive.period!==period)return null;
 if(!Number.isFinite(clobLive.up)||!Number.isFinite(clobLive.down))return null;
 if(!Number.isFinite(clobLive.updatedAtMs)||clobLive.updatedAtMs<period)return null;
 if(clobLive.up<=0||clobLive.up>1||clobLive.down<=0||clobLive.down>1)return null;
 const complementarySum=clobLive.up+clobLive.down;
 if(complementarySum<0.98)return null;
 return{up:clobLive.up,down:clobLive.down,upAskSize:clobLive.upSize,downAskSize:clobLive.downSize,complementarySum,slug:clobLive.slug,upTokenId:clobLive.upTokenId,downTokenId:clobLive.downTokenId,priceMethod:"CLOB_WS_BEST_ASK",fetchedAt:new Date(clobLive.updatedAtMs||Date.now()).toISOString(),fetchedAtMs:clobLive.updatedAtMs||Date.now(),fetchStartedAtMs:clobLive.updatedAtMs||Date.now()};
}
function eventKey(e){if(e.id!=null&&String(e.id))return"aggr:"+String(e.exchange||"")+":"+String(e.id);return[e.ts||e.timestamp||"",e.exchange||"",e.symbol||e.pair||"",e.side||"",e.price||"",e.qty||e.size||""].join("|");}
function normalizeAggrEvent(raw){const symbol=String(raw?.symbol||raw?.pair||"").toUpperCase().replace(/USDT|USDC|USD|PERP|[-_]/g,"").replace("SWAP","");if(!SYMBOLS.has(symbol))return null;const side=String(raw?.side||"").toLowerCase(),price=num(raw?.price),qty=num(raw?.size??raw?.qty??raw?.amount);if(price===null||qty===null||qty<=0)return null;const ts=num(raw?.timestamp??raw?.ts??raw?.time)??Date.now(),exchange=String(raw?.exchange||"AGGR").toUpperCase();return{id:raw?.id==null?"":String(raw.id),ts:ts<1e12?ts*1000:ts,exchange,symbol,side,price,qty,notional:price*qty};}
const PERIODS=[300000,900000,3600000];
function periodKey(ts,size){return Math.floor(ts/size)*size;}
function periodLabel(size){return size===300000?"5m":size===900000?"15m":"1h";}
function defaultPeriodState(){return{periodKey:null,countBySymbol:{},valueBySymbol:{},lastEvent:null};}
function resetPeriodCounters(size,nextKey){state.periods[String(size)]=defaultPeriodState();state.periods[String(size)].periodKey=nextKey;}

async function finalizePeriod(period,nextPeriod,size){
 const ps=state.periods[String(size)]||defaultPeriodState(),counts=ps.countBySymbol||{},values=ps.valueBySymbol||{},lastEvent=ps.lastEvent||null;
 const averages={};for(const symbol of SYMBOLS){const liqs=Number(counts[symbol]||0),value=Number(values[symbol]||0);if(liqs>0)averages[symbol]=value/liqs;}
 log("PERIOD_FINALIZE",{period,periodEnd:new Date(period+size).toISOString(),periodSize:size,periodLabel:periodLabel(size),counts,values,averages,lastLiquidation:lastEvent});
 const targetPeriod=nextPeriod==null?period+size:nextPeriod;
 const selectedSymbol=[...SYMBOLS][0];if(!selectedSymbol)return true;
 let liqs=Number(counts[selectedSymbol]||0),value=Number(values[selectedSymbol]||0),average=liqs>0?value/liqs:0;
 const minimumLiqs=size===900000?0:Infinity;
 if(size===900000?liqs!==0:liqs<minimumLiqs)return true;
 await prepareLiveClob(selectedSymbol,targetPeriod,size);
 const selectedLastEvent=lastEvent&&lastEvent.symbol===selectedSymbol?lastEvent:null;
 return await flushPeriodAlert(selectedSymbol,liqs,value,average,targetPeriod,period,selectedLastEvent,size);
}

async function recordLiquidations(events){
 const seen=new Set(Array.isArray(state.seen)?state.seen:[]);
 for(const event of events){
  const key=eventKey(event);if(seen.has(key))continue;seen.add(key);state.seen.push(key);
  for(const size of PERIODS){
   const pkey=periodKey(event.ts,size),ps=state.periods[String(size)]||defaultPeriodState();
   if(ps.periodKey==null)resetPeriodCounters(size,pkey);
   else if(pkey>ps.periodKey){
    const previous=ps.periodKey,finalized=await finalizePeriod(previous,pkey,size);
    if(!finalized){log("PERIOD_FINALIZE_RETRY_REQUIRED",{period:previous,nextPeriod:pkey,periodSize:size,periodLabel:periodLabel(size),reason:"ALERT_NOT_SENT"});continue;}
    resetPeriodCounters(size,pkey);if(size===900000)prepareLiveClob(event.symbol,pkey,size);
   }else if(pkey<ps.periodKey)continue;
   const current=state.periods[String(size)];
   current.countBySymbol[event.symbol]=Number(current.countBySymbol[event.symbol]||0)+1;
   current.valueBySymbol[event.symbol]=Number(current.valueBySymbol[event.symbol]||0)+event.notional;
   if(!current.lastEvent||event.ts>=Number(current.lastEvent.ts||0))current.lastEvent=event;
  }
  state.countBySymbol[event.symbol]=Number(state.countBySymbol[event.symbol]||0)+1;
  state.valueBySymbol[event.symbol]=Number(state.valueBySymbol[event.symbol]||0)+event.notional;
  acceptedSinceSummary++;
 }
 if(state.seen.length>MAX_SEEN)state.seen.splice(0,state.seen.length-MAX_SEEN);saveState();
}

async function flushPeriodAlert(symbol,count,value,average,period,sourcePeriod=null,lastEvent=null,size=3600000){
 const currentMarketStartMs=period,link=marketUrl(symbol,currentMarketStartMs,size),dedupeKey="period:"+size+":"+period;
 const alertedLinks=Array.isArray(state.alertedLinks)?state.alertedLinks:[];
 if(alertedLinks.includes(link)||state.alertedPeriodKey===dedupeKey||alertInFlight.has(dedupeKey))return;
 alertInFlight.add(dedupeKey);
 try{
  let clob=null;const clobAttempts=5;
  for(let attempt=1;attempt<=clobAttempts;attempt++){
   log("CLOB_PRICE_ATTEMPT",{symbol,period,attempt,attempts:clobAttempts,method:"REST_EXACT_MARKET"});
   clob=await fetchPolymarketClobPrices(symbol,period,size);
   if(clob)break;
   if(attempt<clobAttempts)await new Promise(resolve=>setTimeout(resolve,100));
  }
  if(!clob){
   for(let attempt=1;attempt<=clobAttempts;attempt++){
    log("CLOB_PRICE_ATTEMPT",{symbol,period,attempt,attempts:clobAttempts,method:"WEBSOCKET"});
    clob=liveClobSnapshot(symbol,period);
    if(clob)break;
    if(attempt<clobAttempts)await new Promise(resolve=>setTimeout(resolve,100));
   }
  }
  if(!clob){log("CLOB_PRICE_UNAVAILABLE_ALERT_CONTINUES",{symbol,count,value,period,reason:"CLOB_PRICES_UNAVAILABLE_AFTER_RETRIES",attempts:clobAttempts});}
  if(clob?.equalPrices){log("CLOB_EQUAL_PRICES_ALERT_CONTINUES",{symbol,count,value,period,up:clob.up,down:clob.down});}
  if(clob){log("CLOB_PRICES_READY",{symbol,period,clobSlug:clob.slug,clobUp:clob.up,clobDown:clob.down,clobUpAsk:clob.up,clobDownAsk:clob.down,clobUpAskSize:clob.upAskSize,clobDownAskSize:clob.downAskSize,clobUpAskFetchedAt:clob.upAskFetchedAt,clobDownAskFetchedAt:clob.downAskFetchedAt,clobUpAskFetchedAtMs:clob.upAskFetchedAtMs,clobDownAskFetchedAtMs:clob.downAskFetchedAtMs,fetchedAt:clob.fetchedAt,fetchedAtMs:clob.fetchedAtMs,fetchStartedAtMs:clob.fetchStartedAtMs,clobSnapshotTimestamp:new Date(clob.fetchedAtMs||Date.now()).toISOString(),priceMethod:clob.priceMethod});}
  const clobLine = clob ? "UP: " + clob.up.toFixed(3) + " | DOWN: " + clob.down.toFixed(3) : "UP: — | DOWN: —";
  const alertPreparedAt = new Date().toISOString();
  const header="🔥 "+symbol+" "+periodLabel(size);
  const text=[header,"LIQS: "+count,"AVG: $"+average.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}),"VALUE: $"+value.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}),clobLine,new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Kyiv",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(currentMarketStartMs)),link].join("\n");
  const sendStartedAt=new Date().toISOString(),sent=await sendTelegram(text),sendFinishedAt=new Date().toISOString();
  log(sent?"LIQUIDATION_ALERT_SENT":"LIQUIDATION_ALERT_FAILED",{source:"AGGR",symbol,count,value,average,period,sourcePeriod,lastLiquidation:lastEvent,periodSize:size,periodLabel:periodLabel(size),dedupeKey,clobSlug:clob?.slug||null,clobFetchedAt:clob?.fetchedAt||null,clobFetchedAtMs:clob?.fetchedAtMs||null,clobFetchStartedAtMs:clob?.fetchStartedAtMs||null,clobSnapshotTimestamp:clob?.fetchedAtMs?new Date(clob.fetchedAtMs).toISOString():null,clobPriceMethod:clob?.priceMethod||null,clobUp:clob?.up??null,clobDown:clob?.down??null,clobUpAsk:clob?.up??null,clobDownAsk:clob?.down??null,clobComplementarySum:clob?.complementarySum??null,clobUpAskSize:clob?.upAskSize??null,clobDownAskSize:clob?.downAskSize??null,clobUpAskFetchedAt:clob?.upAskFetchedAt??null,clobDownAskFetchedAt:clob?.downAskFetchedAt??null,clobUpAskFetchedAtMs:clob?.upAskFetchedAtMs??null,clobDownAskFetchedAtMs:clob?.downAskFetchedAtMs??null,alertPreparedAt,sendStartedAt,sendFinishedAt});
  if(sent){state.alertsSent=Number(state.alertsSent||0)+1;state.alertedPeriodKey=dedupeKey;state.lastEventTs=period;state.lastEventKey=dedupeKey;state.alertedLinks=Array.isArray(state.alertedLinks)?state.alertedLinks:[];if(!state.alertedLinks.includes(link))state.alertedLinks.push(link);if(state.alertedLinks.length>100)state.alertedLinks=state.alertedLinks.slice(-100);saveState();return true;}
  return false;
 }finally{alertInFlight.delete(dedupeKey);}
}

function connectAggr(){
 if(aggrRequest){try{aggrRequest.destroy();}catch{}aggrRequest=null;}
 log("AGGR_CONNECTING",{url:AGGR_URL});
 const req=http.get(AGGR_URL,response=>{
  if(response.statusCode!==200){log("AGGR_HTTP_ERROR",{status:response.statusCode});response.resume();aggrConnected=false;scheduleAggrReconnect();return;}
  aggrConnected=true;log("AGGR_CONNECTED",{url:AGGR_URL});let buffer="";response.setEncoding("utf8");
  response.on("data",chunk=>{buffer+=chunk;const frames=buffer.split("\n\n");buffer=frames.pop()||"";for(const frame of frames){const line=frame.split("\n").find(x=>x.startsWith("data:"));if(!line)continue;try{const raw=JSON.parse(line.slice(5).trim()),event=normalizeAggrEvent(raw);if(!event){ignoredEvents++;continue;}aggrEvents++;aggrLastEventAt=nowIso();liquidationQueue=liquidationQueue.then(()=>recordLiquidations([event])).catch(e=>log("LIQUIDATION_VALUE_ERROR",{error:String(e.stack||e)}));}catch(e){log("AGGR_EVENT_PARSE_ERROR",{error:String(e.message||e),frame:frame.slice(0,1000)});}}});
  response.on("end",()=>{aggrConnected=false;aggrRequest=null;log("AGGR_DISCONNECTED",{reason:"STREAM_END"});scheduleAggrReconnect();});
  response.on("error",e=>{aggrConnected=false;aggrRequest=null;log("AGGR_STREAM_ERROR",{error:String(e.message||e)});scheduleAggrReconnect();});
 });
 aggrRequest=req;req.on("error",e=>{aggrConnected=false;aggrRequest=null;log("AGGR_CONNECTION_ERROR",{error:String(e.message||e)});scheduleAggrReconnect();});
}
function scheduleAggrReconnect(){if(aggrReconnectTimer)return;aggrReconnectTimer=setTimeout(()=>{aggrReconnectTimer=null;connectAggr();scheduleAggrHealth();},3000);}
function refreshAggrHealth(){const req=http.get("http://127.0.0.1:9090/health",response=>{let body="";response.setEncoding("utf8");response.on("data",chunk=>{body+=chunk;});response.on("end",()=>{if(response.statusCode!==200)return;try{const value=JSON.parse(body);aggrHealth={fetchedAt:nowIso(),exchangeCount:value.exchangeCount??null,exchanges:Array.isArray(value.exchanges)?value.exchanges:[],pairCount:value.pairCount??null,hyperliquid:value.hyperliquid===true,status:value.status&&typeof value.status==="object"?value.status:{},krakenDiagnostics:value.krakenDiagnostics&&typeof value.krakenDiagnostics==="object"?value.krakenDiagnostics:{}};}catch(e){log("AGGR_HEALTH_PARSE_ERROR",{error:String(e.message||e)});}});});req.on("error",e=>{aggrHealth={fetchedAt:nowIso(),error:String(e.message||e)};});req.setTimeout(3000,()=>req.destroy());}
function scheduleAggrHealth(){refreshAggrHealth();clearInterval(aggrHealthTimer);aggrHealthTimer=setInterval(refreshAggrHealth,60000);}
function diagnostics(){return{status:"ok",version:VERSION,buildSha:BUILD_SHA,strategy:state.strategy,source:"AGGR",aggrUrl:AGGR_URL,aggrConnected,aggrEvents,aggrLastEventAt,alertsSent:state.alertsSent,lastEventTs:state.lastEventTs,lastEventKey:state.lastEventKey,seenEvents:state.seen.length,valueBySymbol:state.valueBySymbol||{},countBySymbol:state.countBySymbol||{},alertedLinks:state.alertedLinks||[],periods:state.periods||{},krakenDiagnostics:aggrHealth&&aggrHealth.krakenDiagnostics?aggrHealth.krakenDiagnostics:{},selection:"5M_15M_1H_NO_COMPARE",aggrHealth};}
function startHealth(){const port=Number(process.env.MONITOR_HEALTH_PORT||8081);const server=http.createServer((req,res)=>{const requestPath=String(req.url||"/").split("?")[0];if(requestPath==="/"||requestPath==="/health"||requestPath==="/status"||requestPath==="/stats"){res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});return res.end(JSON.stringify(diagnostics()));}if(requestPath==="/logs/stream"){let rows=[];try{rows=fs.readFileSync(LOG_FILE,"utf8").split("\n").filter(Boolean).slice(-100).map(x=>JSON.parse(x));}catch{}res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-store, must-revalidate","connection":"keep-alive","x-accel-buffering":"no"});for(const row of rows)res.write("data: "+JSON.stringify(row)+"\n\n");logSubscribers.add(res);const heartbeat=setInterval(()=>{try{res.write(": heartbeat\n\n");}catch{}},15000);req.on("close",()=>{clearInterval(heartbeat);logSubscribers.delete(res);});return;}if(requestPath==="/logs"){let rows=[];try{rows=fs.readFileSync(LOG_FILE,"utf8").split("\n").filter(Boolean).slice(-300).map(x=>JSON.parse(x));}catch(e){rows=[{event:"LOG_READ_ERROR",error:String(e.message||e)}];}res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});return res.end(JSON.stringify({status:"ok",events:rows}));}res.writeHead(404);res.end();});server.on("error",e=>log("HEALTH_SERVER_ERROR",{error:String(e.message||e)}));server.listen(port,"0.0.0.0",()=>log("HEALTH_LISTENING",{port,healthPath:"/health"}));}
function main(){ensureDir(STATE_FILE);ensureDir(LOG_FILE);state=loadState();if(state.strategy!=="AGGR_LIQUIDATIONS"){state.seen=[];state.alertedLinks=[];state.alertedPeriodKey=null;state.valueBySymbol={};state.countBySymbol={};state.periods={};state.alertsSent=0;state.lastEventTs=null;state.lastEventKey=null;}state.version=VERSION;state.strategy="AGGR_LIQUIDATIONS";state.seen=Array.isArray(state.seen)?state.seen:[];state.alertedLinks=Array.isArray(state.alertedLinks)?state.alertedLinks:[];state.alertedPeriodKey=state.alertedPeriodKey==null?null:String(state.alertedPeriodKey);state.valueBySymbol=state.valueBySymbol&&typeof state.valueBySymbol==="object"?state.valueBySymbol:{};state.countBySymbol=state.countBySymbol&&typeof state.countBySymbol==="object"?state.countBySymbol:{};state.periods=state.periods&&typeof state.periods==="object"?state.periods:{};for(const size of PERIODS){if(!state.periods[String(size)])state.periods[String(size)]=defaultPeriodState();if(state.periods[String(size)].periodKey==null)state.periods[String(size)].periodKey=periodKey(Date.now(),size);}log("LIQUIDATION_MONITOR_STARTING",{buildSha:BUILD_SHA,strategy:state.strategy,source:"AGGR",aggrUrl:AGGR_URL,symbols:[...SYMBOLS],periodBased:true,alertAtFirst60Seconds:false,selection:"5M_15M_1H_NO_COMPARE",periods:["5m","15m","1h"],minimumAlertLiqs:0});startHealth();connectAggr();prepareLiveClob([...SYMBOLS][0],state.periods["900000"].periodKey,900000);const scheduleBoundary=()=>{const now=Date.now(),nextBoundary=Math.min(...PERIODS.map(size=>(Math.floor(now/size)+1)*size));groupTimer=setTimeout(async()=>{for(const size of PERIODS){const ps=state.periods[String(size)],boundary=Math.floor(nextBoundary/size)*size;if(ps.periodKey!=null&&ps.periodKey<boundary){const finalized=await finalizePeriod(ps.periodKey,boundary,size);if(finalized)resetPeriodCounters(size,boundary);else log("BOUNDARY_ALERT_PENDING",{period:ps.periodKey,boundary,periodSize:size,periodLabel:periodLabel(size),reason:"ALERT_NOT_SENT_WILL_RETRY_ON_NEXT_EVENT"});}}saveState();scheduleBoundary();},Math.max(0,nextBoundary-now+25));};scheduleBoundary();setInterval(()=>{log("FEED_STATUS",{source:"AGGR",aggrConnected,aggrEvents,acceptedSinceSummary,ignoredEvents,skippedEvents,aggrLastEventAt,valueBySymbol:state.valueBySymbol||{}});acceptedSinceSummary=0;ignoredEvents=0;skippedEvents=0;},FEED_SUMMARY_LOG_MS);}
process.on("SIGTERM",()=>log("MONITOR_STOPPING"));
process.on("SIGINT",()=>log("MONITOR_STOPPING"));
main();
