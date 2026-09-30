const fs = require("fs");
const path = require("path");
const http = require("http");

const VERSION = "26.2.5-5M-MAX-VALUE-CLOB-BOOK";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const AGGR_URL = process.env.AGGR_URL || "http://127.0.0.1:9090/liquidations";
const STATE_FILE = process.env.STATE_FILE || "/data/aggr-liquidation-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/aggr-liquidation.jsonl";
const SYMBOLS = new Set(["BTC","ETH","SOL","XRP","DOGE","BNB","HYPE"]);
const MAX_SEEN = 10000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const LOG_KEEP_BYTES = 1 * 1024 * 1024;
const FEED_SUMMARY_LOG_MS = 60000;
const MIN_LIQS = 3;

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
function log(event,data={}){if(event==="FEED_STATUS"){const now=Date.now();if(now-lastFeedSummaryLogAt<FEED_SUMMARY_LOG_MS)return;lastFeedSummaryLogAt=now;}const row={ts:nowIso(),version:VERSION,event,...data};console.log(JSON.stringify(row));appendLogRow(row);}

function defaultState(){return{version:VERSION,strategy:"AGGR_LIQUIDATIONS",updatedAt:nowIso(),seen:[],alertedLinks:[],alertedPeriodKey:null,alertsSent:0,valueBySymbol:{},countBySymbol:{},periodKey:null,periodCountBySymbol:{},periodValueBySymbol:{},lastEventTs:null,lastEventKey:null};}
function loadState(){try{const value=JSON.parse(fs.readFileSync(STATE_FILE,"utf8"));if(value&&typeof value==="object")return value;}catch{}return defaultState();}
function saveState(){state.updatedAt=nowIso();try{ensureDir(STATE_FILE);const tmp=STATE_FILE+".tmp";fs.writeFileSync(tmp,JSON.stringify(state,null,2));fs.renameSync(tmp,STATE_FILE);}catch(e){log("STATE_WRITE_ERROR",{error:String(e.message||e)});}}

function sendTelegram(text){const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;if(!token||!chatId){log("TELEGRAM_NOT_CONFIGURED");return Promise.resolve(false);}return fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text}),signal:AbortSignal.timeout(8000)}).then(async response=>{const body=await response.text();if(!response.ok){log("TELEGRAM_ERROR",{status:response.status,body:body.slice(0,1000)});return false;}return true;}).catch(e=>{log("TELEGRAM_ERROR",{error:String(e.message||e)});return false;});}
function polymarket5mUrl(symbol,nowMs=Date.now()){const startEpoch=Math.floor(nowMs/300000)*300;return"https://polymarket.com/event/"+symbol.toLowerCase()+"-updown-5m-"+startEpoch;}

async function fetchPolymarketClobPrices(symbol,nowMs=Date.now()){
 const slug=symbol.toLowerCase()+"-updown-5m-"+(Math.floor(nowMs/300000)*300),fetchedAtStartedMs=Date.now();
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
  const [upBook,downBook]=await Promise.all([upResponse.json(),downResponse.json()]);
  const bestAsk=book=>Array.isArray(book?.asks)?book.asks.map(x=>({price:num(x?.price),size:num(x?.size)})).filter(x=>x.price!==null&&x.size!==null&&x.size>0).sort((a,b)=>a.price-b.price)[0]:null;
  const upAsk=bestAsk(upBook),downAsk=bestAsk(downBook);
  if(!upAsk||!downAsk)throw new Error("CLOB best ask missing");
  const up=upAsk.price,down=downAsk.price;
  if(up<=0||up>1||down<=0||down>1)throw new Error("CLOB best ask outside 0..1");
  const complementarySum=up+down;
  if(Math.abs(up-down)<1e-12){
   log("CLOB_EQUAL_PRICES_IGNORED",{symbol,slug,up,down,fetchedAt:new Date().toISOString()});
   return{up,down,slug,upTokenId,downTokenId,priceMethod:"CLOB_BOOK_BEST_ASK",upAskSize:upAsk.size,downAskSize:downAsk.size,complementarySum,equalPrices:true};
  }
  if(complementarySum<0.98)throw new Error("CLOB crossed/inconsistent complementary asks: "+up+"+"+down+"="+complementarySum);
  const fetchedAtFinishedMs=Date.now();
  return{up,down,slug,upTokenId,downTokenId,priceMethod:"CLOB_BOOK_BEST_ASK",upAskSize:upAsk.size,downAskSize:downAsk.size,complementarySum,fetchedAt:new Date(fetchedAtFinishedMs).toISOString(),fetchedAtMs:fetchedAtFinishedMs,fetchStartedAtMs:fetchedAtStartedMs};
 }catch(e){log("POLYMARKET_CLOB_PRICE_ERROR",{symbol,slug,error:String(e.message||e),priceMethod:"CLOB_BOOK_BEST_ASK"});return null;}
}

function eventKey(e){if(e.id!=null&&String(e.id))return"aggr:"+String(e.exchange||"")+":"+String(e.id);return[e.ts||e.timestamp||"",e.exchange||"",e.symbol||e.pair||"",e.side||"",e.price||"",e.qty||e.size||""].join("|");}
function normalizeAggrEvent(raw){const symbol=String(raw?.symbol||raw?.pair||"").toUpperCase().replace(/USDT|USDC|USD|PERP|[-_]/g,"").replace("SWAP","");if(!SYMBOLS.has(symbol))return null;const side=String(raw?.side||"").toLowerCase(),price=num(raw?.price),qty=num(raw?.size??raw?.qty??raw?.amount);if(price===null||qty===null||qty<=0)return null;const ts=num(raw?.timestamp??raw?.ts??raw?.time)??Date.now(),exchange=String(raw?.exchange||"AGGR").toUpperCase();return{id:raw?.id==null?"":String(raw.id),ts:ts<1e12?ts*1000:ts,exchange,symbol,side,price,qty,notional:price*qty};}
function periodKey(ts){return Math.floor(ts/300000)*300000;}
function resetPeriodCounters(nextPeriodKey){state.periodKey=nextPeriodKey;state.periodCountBySymbol={};state.periodValueBySymbol={};}

async function finalizePeriod(period){
 const counts=state.periodCountBySymbol||{},values=state.periodValueBySymbol||{};
 let winner=null,minValue=Infinity,winnerCount=0;
 for(const symbol of SYMBOLS){
  const count=Number(counts[symbol]||0),value=Number(values[symbol]||0);
  if(count<MIN_LIQS)continue;
  if(winner===null||value<minValue){minValue=value;winner=symbol;winnerCount=count;}
 }
 log("PERIOD_FINALIZE",{period,periodEnd:new Date(period+300000).toISOString(),counts,values,winner,minValue,winnerCount,minLiquidations:MIN_LIQS});
 if(!winner){
  log("PERIOD_NO_ALERT",{period,counts,values,reason:"NO_SYMBOL_WITH_MIN_LIQUIDATIONS",minLiquidations:MIN_LIQS});
  return true;
 }
 return await flushPeriodAlert(winner,winnerCount,minValue,period);
}

async function recordLiquidations(events){
 const seen=new Set(Array.isArray(state.seen)?state.seen:[]);
 for(const event of events){
  const key=eventKey(event);if(seen.has(key))continue;seen.add(key);state.seen.push(key);
  const eventPeriod=periodKey(event.ts);
  if(state.periodKey==null)resetPeriodCounters(eventPeriod);
  else if(eventPeriod>state.periodKey){const previousPeriod=state.periodKey;const finalized=await finalizePeriod(previousPeriod);if(!finalized){log("PERIOD_FINALIZE_RETRY_REQUIRED",{period:previousPeriod,nextPeriod:eventPeriod,reason:"ALERT_NOT_SENT"});continue;}resetPeriodCounters(eventPeriod);}
  else if(eventPeriod<state.periodKey)continue;
  state.periodCountBySymbol[event.symbol]=Number(state.periodCountBySymbol[event.symbol]||0)+1;
  state.periodValueBySymbol[event.symbol]=Number(state.periodValueBySymbol[event.symbol]||0)+event.notional;
  state.countBySymbol[event.symbol]=Number(state.countBySymbol[event.symbol]||0)+1;
  state.valueBySymbol[event.symbol]=Number(state.valueBySymbol[event.symbol]||0)+event.notional;
  acceptedSinceSummary++;
 }
 if(state.seen.length>MAX_SEEN)state.seen.splice(0,state.seen.length-MAX_SEEN);saveState();
}

async function flushPeriodAlert(symbol,count,value,period){
 const periodEndMs=period+300000,link=polymarket5mUrl(symbol,periodEndMs),dedupeKey="period:"+period;
 if(state.alertedPeriodKey===dedupeKey||alertInFlight.has(dedupeKey))return;
 alertInFlight.add(dedupeKey);
 try{
  let clob=null;const clobAttempts=5;
  for(let attempt=1;attempt<=clobAttempts;attempt++){log("CLOB_PRICE_ATTEMPT",{symbol,period,periodEnd:new Date(periodEndMs).toISOString(),attempt,attempts:clobAttempts});clob=await fetchPolymarketClobPrices(symbol,periodEndMs);if(clob)break;if(attempt<clobAttempts)await new Promise(resolve=>setTimeout(resolve,1000));}
  if(!clob){log("LIQUIDATION_ALERT_BLOCKED",{symbol,count,value,period,reason:"CLOB_PRICES_UNAVAILABLE_AFTER_RETRIES",attempts:clobAttempts});return false;}
  if(clob.equalPrices){log("LIQUIDATION_ALERT_IGNORED",{symbol,count,value,period,reason:"CLOB_UP_DOWN_PRICES_EQUAL",up:clob.up,down:clob.down});return true;}
  log("CLOB_PRICES_READY",{symbol,period,clobSlug:clob.slug,clobUp:clob.up,clobDown:clob.down,fetchedAt:clob.fetchedAt,fetchedAtMs:clob.fetchedAtMs});
  const clobLine="UP: "+clob.up.toFixed(3)+" | DOWN: "+clob.down.toFixed(3),directionArrow=clob.up<=clob.down?"⬆️":"⬇️",alertPreparedAt=new Date().toISOString();
  const text=[symbol+(directionArrow?" "+directionArrow:""),"LIQS: "+count,"VALUE: $"+value.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}),clobLine,new Intl.DateTimeFormat("en-GB",{timeZone:"Europe/Kyiv",hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false}).format(new Date(periodEndMs)),link].join("\n");
  const sendStartedAt=new Date().toISOString(),sent=await sendTelegram(text),sendFinishedAt=new Date().toISOString();
  log(sent?"LIQUIDATION_ALERT_SENT":"LIQUIDATION_ALERT_FAILED",{source:"AGGR",symbol,count,value,period,dedupeKey,clobSlug:clob?.slug||null,clobFetchedAt:clob?.fetchedAt||null,clobFetchedAtMs:clob?.fetchedAtMs||null,clobPriceMethod:clob?.priceMethod||null,clobUp:clob?.up??null,clobDown:clob?.down??null,clobComplementarySum:clob?.complementarySum??null,clobUpAskSize:clob?.upAskSize??null,clobDownAskSize:clob?.downAskSize??null,alertPreparedAt,sendStartedAt,sendFinishedAt});
  if(sent){state.alertsSent=Number(state.alertsSent||0)+1;state.alertedPeriodKey=dedupeKey;state.lastEventTs=periodEndMs;state.lastEventKey=dedupeKey;saveState();return true;}
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
function refreshAggrHealth(){const req=http.get("http://127.0.0.1:9090/health",response=>{let body="";response.setEncoding("utf8");response.on("data",chunk=>{body+=chunk;});response.on("end",()=>{if(response.statusCode!==200)return;try{const value=JSON.parse(body);aggrHealth={fetchedAt:nowIso(),exchangeCount:value.exchangeCount??null,exchanges:Array.isArray(value.exchanges)?value.exchanges:[],pairCount:value.pairCount??null,hyperliquid:value.hyperliquid===true,status:value.status&&typeof value.status==="object"?value.status:{}};}catch(e){log("AGGR_HEALTH_PARSE_ERROR",{error:String(e.message||e)});}});});req.on("error",e=>{aggrHealth={fetchedAt:nowIso(),error:String(e.message||e)};});req.setTimeout(3000,()=>req.destroy());}
function scheduleAggrHealth(){refreshAggrHealth();clearInterval(aggrHealthTimer);aggrHealthTimer=setInterval(refreshAggrHealth,60000);}
function diagnostics(){return{status:"ok",version:VERSION,buildSha:BUILD_SHA,strategy:state.strategy,source:"AGGR",aggrUrl:AGGR_URL,aggrConnected,aggrEvents,aggrLastEventAt,alertsSent:state.alertsSent,lastEventTs:state.lastEventTs,lastEventKey:state.lastEventKey,seenEvents:state.seen.length,valueBySymbol:state.valueBySymbol||{},countBySymbol:state.countBySymbol||{},alertedLinks:state.alertedLinks||[],periodKey:state.periodKey,periodCountBySymbol:state.periodCountBySymbol||{},periodValueBySymbol:state.periodValueBySymbol||{},minLiquidations:MIN_LIQS,selection:"MIN_VALUE_PREVIOUS_5M_WITH_MIN_LIQS",aggrHealth};}
function startHealth(){const port=Number(process.env.MONITOR_HEALTH_PORT||8081);const server=http.createServer((req,res)=>{const requestPath=String(req.url||"/").split("?")[0];if(requestPath==="/"||requestPath==="/health"||requestPath==="/status"||requestPath==="/stats"){res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});return res.end(JSON.stringify(diagnostics()));}if(requestPath==="/logs/stream"){let rows=[];try{rows=fs.readFileSync(LOG_FILE,"utf8").split("\n").filter(Boolean).slice(-100).map(x=>JSON.parse(x));}catch{}res.writeHead(200,{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-cache, no-store, must-revalidate","connection":"keep-alive","x-accel-buffering":"no"});for(const row of rows)res.write("data: "+JSON.stringify(row)+"\n\n");logSubscribers.add(res);const heartbeat=setInterval(()=>{try{res.write(": heartbeat\n\n");}catch{}},15000);req.on("close",()=>{clearInterval(heartbeat);logSubscribers.delete(res);});return;}if(requestPath==="/logs"){let rows=[];try{rows=fs.readFileSync(LOG_FILE,"utf8").split("\n").filter(Boolean).slice(-300).map(x=>JSON.parse(x));}catch(e){rows=[{event:"LOG_READ_ERROR",error:String(e.message||e)}];}res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});return res.end(JSON.stringify({status:"ok",events:rows}));}res.writeHead(404);res.end();});server.on("error",e=>log("HEALTH_SERVER_ERROR",{error:String(e.message||e)}));server.listen(port,"0.0.0.0",()=>log("HEALTH_LISTENING",{port,healthPath:"/health"}));}
function main(){ensureDir(STATE_FILE);ensureDir(LOG_FILE);state=loadState();if(state.strategy!=="AGGR_LIQUIDATIONS"||state.version!==VERSION){state.seen=[];state.alertedLinks=[];state.alertedPeriodKey=null;state.valueBySymbol={};state.countBySymbol={};state.periodKey=null;state.periodCountBySymbol={};state.periodValueBySymbol={};state.alertsSent=0;state.lastEventTs=null;state.lastEventKey=null;}state.version=VERSION;state.strategy="AGGR_LIQUIDATIONS";state.seen=Array.isArray(state.seen)?state.seen:[];state.alertedLinks=Array.isArray(state.alertedLinks)?state.alertedLinks:[];state.alertedPeriodKey=state.alertedPeriodKey==null?null:String(state.alertedPeriodKey);state.valueBySymbol=state.valueBySymbol&&typeof state.valueBySymbol==="object"?state.valueBySymbol:{};state.periodKey=(state.periodKey===null||state.periodKey===undefined||state.periodKey==="")?null:(Number.isFinite(Number(state.periodKey))?Number(state.periodKey):null);state.periodCountBySymbol=state.periodCountBySymbol&&typeof state.periodCountBySymbol==="object"?state.periodCountBySymbol:{};state.periodValueBySymbol=state.periodValueBySymbol&&typeof state.periodValueBySymbol==="object"?state.periodValueBySymbol:{};const hadCountState=state.countBySymbol&&typeof state.countBySymbol==="object";state.countBySymbol=hadCountState?state.countBySymbol:{};if(!hadCountState)state.valueBySymbol={};log("LIQUIDATION_MONITOR_STARTING",{buildSha:BUILD_SHA,strategy:state.strategy,source:"AGGR",aggrUrl:AGGR_URL,symbols:[...SYMBOLS],periodBased:true,alertAtPeriodBoundary:true,selection:"MAX_VALUE_PREVIOUS_5M_WITH_MIN_LIQS",minLiquidations:MIN_LIQS});startHealth();connectAggr();const scheduleBoundary=()=>{const now=Date.now(),nextBoundary=(Math.floor(now/300000)+1)*300000;groupTimer=setTimeout(async()=>{log("BOUNDARY_TICK",{boundary:new Date(nextBoundary).toISOString(),periodKey:state.periodKey});if(state.periodKey!=null&&state.periodKey<nextBoundary){const finalized=await finalizePeriod(state.periodKey);if(finalized){resetPeriodCounters(nextBoundary);saveState();}else{log("BOUNDARY_ALERT_PENDING",{period:state.periodKey,boundary:nextBoundary,reason:"ALERT_NOT_SENT_WILL_RETRY_ON_NEXT_EVENT"});}}scheduleBoundary();},Math.max(0,nextBoundary-now+25));};scheduleBoundary();setInterval(()=>{log("FEED_STATUS",{source:"AGGR",aggrConnected,aggrEvents,acceptedSinceSummary,ignoredEvents,skippedEvents,aggrLastEventAt,valueBySymbol:state.valueBySymbol||{}});acceptedSinceSummary=0;ignoredEvents=0;skippedEvents=0;},FEED_SUMMARY_LOG_MS);}
process.on("SIGTERM",()=>log("MONITOR_STOPPING"));
process.on("SIGINT",()=>log("MONITOR_STOPPING"));
main();
