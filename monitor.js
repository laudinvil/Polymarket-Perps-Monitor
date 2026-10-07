const fs=require("fs");
const path=require("path");
const http=require("http");

const VERSION="26.8.27-BTC-5M-15M-TRADES-LIQUIDATIONS";
const BUILD_SHA=process.env.MONITOR_BUILD_SHA||"unknown";
const AGGR_URL=process.env.AGGR_URL||"http://127.0.0.1:9090/trades";
const STATE_FILE=process.env.STATE_FILE||"/data/aggr-trade-state.json";
const LOG_FILE=process.env.LOG_FILE||"/data/aggr-trade.jsonl";
const SYMBOL="BTC";
const MAX_SEEN=20000;
const LOG_MAX_BYTES=2*1024*1024;
const LOG_KEEP_BYTES=1*1024*1024;
const PERIODS=[
 {name:"5m",ms:5*60*1000},
 {name:"15m",ms:15*60*1000}
];
let state,aggrRequest=null,aggrConnected=false,aggrEvents=0,aggrLastEventAt=null,reconnectTimer=null,alertInFlight=new Set(),logSubscribers=new Set();

function nowIso(){return new Date().toISOString();}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function ensureDir(file){fs.mkdirSync(path.dirname(file),{recursive:true});}
function log(event,data={}){
 const row={ts:nowIso(),version:VERSION,event,...data};
 try{ensureDir(LOG_FILE);fs.appendFileSync(LOG_FILE,JSON.stringify(row)+"\n");for(const res of logSubscribers){try{res.write("data: "+JSON.stringify(row)+"\n\n");}catch{logSubscribers.delete(res);}}const size=fs.statSync(LOG_FILE).size;if(size>LOG_MAX_BYTES){const fd=fs.openSync(LOG_FILE,"r"),buf=Buffer.alloc(LOG_KEEP_BYTES);fs.readSync(fd,buf,0,LOG_KEEP_BYTES,size-LOG_KEEP_BYTES);fs.closeSync(fd);const i=buf.indexOf(10);fs.writeFileSync(LOG_FILE,i>=0?buf.subarray(i+1):buf);}}catch{}
}
function defaultSnapshot(){return{periodStart:null,total:0,buy:0,sell:0,volume:0,exchanges:{},liqCount:0,liqValue:0,liqLong:0,liqShort:0,liqExchanges:{}};}
function defaultState(){return{version:VERSION,strategy:"AGGR_TRADES_LIQUIDATIONS",periods:{},tradeSeen:[],liquidationSeen:[],seen:[],alertsSent:0,lastPeriodTradesPerSec:null,liqAlertArmed:{},lastLiqAlertPeriod:{},lastZeroLiqPeriod:{}};}
function loadState(){try{const v=JSON.parse(fs.readFileSync(STATE_FILE,"utf8"));if(v&&typeof v==="object")return v;}catch{}return defaultState();}
function saveState(){try{ensureDir(STATE_FILE);const tmp=STATE_FILE+".tmp";fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,STATE_FILE);}catch{}}
function resetPeriod(period,start){state.periods[period.name]={...defaultSnapshot(),periodStart:start};}
function normalize(raw){
 const symbol=String(raw?.symbol||raw?.pair||"").toUpperCase().replace(/USDT|USDC|USD|PERP|SWAP|[-_]/g,"");
 if(symbol!==SYMBOL)return null;
 const price=num(raw?.price),size=num(raw?.size);if(price===null||size===null||price<=0||size<=0)return null;
 const count=num(raw?.count);let timestamp=num(raw?.timestamp)??Date.now();if(timestamp<1e12)timestamp*=1000;const exchange=String(raw?.exchange||"AGGR").toUpperCase();if(exchange==="HITBTC")return null;return{id:raw?.id?String(raw.id):"",timestamp,exchange,pair:String(raw?.pair||raw?.symbol||""),side:String(raw?.side||"").toLowerCase(),price,size,count:count&&count>0?count:1,amount:num(raw?.amount)};
}
function addTrade(snapshot,e){
 const count=e.count||1,volume=e.amount!==null&&e.amount>0?Math.abs(e.amount):Math.abs(e.price*e.size)/count,x=snapshot.exchanges[e.exchange]||(snapshot.exchanges[e.exchange]={trades:0,volume:0,buy:0,sell:0});
 snapshot.total+=count;snapshot.volume+=volume;x.trades+=count;x.volume+=volume;
 if(e.side==="buy"){snapshot.buy+=count;x.buy+=count;}else if(e.side==="sell"){snapshot.sell+=count;x.sell+=count;}
}
function sendTelegram(text){const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;if(!token||!chatId)return Promise.resolve(false);return fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text}),signal:AbortSignal.timeout(8000)}).then(r=>r.ok).catch(()=>false);}
function marketUrl(period,name){return "https://polymarket.com/event/btc-updown-"+name+"-"+Math.floor(period/1000);}
async function flushPeriod(config,period,snapshot){
 state.liqAlertArmed=state.liqAlertArmed&&typeof state.liqAlertArmed==="object"?state.liqAlertArmed:{};
 state.lastLiqAlertPeriod=state.lastLiqAlertPeriod&&typeof state.lastLiqAlertPeriod==="object"?state.lastLiqAlertPeriod:{};
 state.lastZeroLiqPeriod=state.lastZeroLiqPeriod&&typeof state.lastZeroLiqPeriod==="object"?state.lastZeroLiqPeriod:{};
 if(snapshot.liqCount>0){
  state.lastLiqAlertPeriod[config.name]=period;
  state.liqAlertArmed[config.name]=true;
  state.lastZeroLiqPeriod[config.name]=-1;
  saveState();
  return;
 }
 if(state.liqAlertArmed[config.name]!==true)return;
 if(Number(state.lastLiqAlertPeriod[config.name]||-1)<0)return;
 const lastZero=Number(state.lastZeroLiqPeriod[config.name]||-1);
 if(lastZero<Number(state.lastLiqAlertPeriod[config.name]||-1)){
  state.lastZeroLiqPeriod[config.name]=period;
  saveState();
  return;
 }
 if(lastZero===period)return;
 state.liqAlertArmed[config.name]=false;
 state.lastZeroLiqPeriod[config.name]=period;
 const key=config.name+":"+period;if(alertInFlight.has(key))return;alertInFlight.add(key);
 try{
  const lines=["🔥 BTC "+config.name,
    "LIQS: "+snapshot.liqCount.toLocaleString("en-US"),
    "LIQ VALUE: $"+snapshot.liqValue.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}),
    "LONG: "+snapshot.liqLong.toLocaleString("en-US")+" | SHORT: "+snapshot.liqShort.toLocaleString("en-US"),
    "",
    marketUrl(period+config.ms,config.name)];
  const liqExchanges=Object.entries(snapshot.liqExchanges).sort((a,b)=>b[1]-a[1]);
  for(const [name,count] of liqExchanges)lines.push("LIQ "+(name.toUpperCase()==="BINANCE_FUTURES"?"BINANCE":name.toUpperCase())+": "+count.toLocaleString("en-US"));
  const sent=await sendTelegram(lines.join("\n"));
  log(sent?"TRADE_LIQUIDATION_ALERT_SENT":"TRADE_LIQUIDATION_ALERT_FAILED",{source:"AGGR",periodType:config.name,period,periodEnd:new Date(period).toISOString(),liqs:snapshot.liqCount,liqValue:snapshot.liqValue,liqLong:snapshot.liqLong,liqShort:snapshot.liqShort,liqExchanges:Object.fromEntries(liqExchanges)});
  if(sent){state.alertsSent=Number(state.alertsSent||0)+1;state.liqAlertArmed[config.name]=false;state.lastLiqAlertPeriod[config.name]=period;}saveState();
 }finally{alertInFlight.delete(key);}
}
function normalizeLiquidation(raw){
 const symbol=String(raw?.symbol||raw?.pair||"").toUpperCase().replace(/USDT|USDC|USD|PERP|SWAP|[-_]/g,"");
 if(symbol!==SYMBOL)return null;
 const price=num(raw?.price),qty=num(raw?.size??raw?.qty??raw?.amount);if(price===null||qty===null||price<=0||qty<=0)return null;
 let timestamp=num(raw?.timestamp??raw?.ts??raw?.time)??Date.now();if(timestamp<1e12)timestamp*=1000;
 const exchange=String(raw?.exchange||"AGGR").toUpperCase();
 if(exchange==="HITBTC")return null;
 const token=v=>String(v??"").trim().toLowerCase().replace(/[-\s]/g,"_");
 const explicit=[raw?.positionSide,raw?.position_side,raw?.posSide,raw?.pos_side,raw?.liquidationSide,raw?.liquidation_side,raw?.closeSide,raw?.close_side,raw?.autoSize,raw?.auto_size].map(token);
 const tradeSide=token(raw?.tradeSide??raw?.trade_side);
 let side="";
 for(const v of [...explicit,tradeSide]){
  if(v.includes("long")&&!v.includes("short")){side="long";break;}
  if(v.includes("short")&&!v.includes("long")){side="short";break;}
 }
 if(!side){
  const rawSide=token(raw?.side??raw?.direction);
  if(rawSide==="sell"||rawSide==="sell_single"||rawSide==="close_long")side="long";
  else if(rawSide==="buy"||rawSide==="buy_single"||rawSide==="close_short")side="short";
  else if(rawSide==="long")side="long";
  else if(rawSide==="short")side="short";
 }
 if(!side){
  const positionIdx=raw?.positionIdx??raw?.position_idx;
  if(positionIdx===1||positionIdx==="1")side="long";
  else if(positionIdx===2||positionIdx==="2")side="short";
 }
 return{id:raw?.id?String(raw.id):"",timestamp,exchange,pair:String(raw?.pair||raw?.symbol||""),side,price,size:qty,notional:Math.abs(price*qty)};
}
function addLiquidation(snapshot,e){
 snapshot.liqCount+=1;
 snapshot.liqValue+=e.notional;
 snapshot.liqExchanges[e.exchange]=Number(snapshot.liqExchanges[e.exchange]||0)+1;
 if(e.side==="long")snapshot.liqLong+=1;
 else if(e.side==="short")snapshot.liqShort+=1;
}
function advancePeriod(config,p){
 let bucket=state.periods[config.name];
 while(p>bucket.periodStart){
  const old=bucket.periodStart;
  const snapshot={total:bucket.total,buy:bucket.buy,sell:bucket.sell,volume:bucket.volume,exchanges:JSON.parse(JSON.stringify(bucket.exchanges||{})),liqCount:bucket.liqCount||0,liqValue:bucket.liqValue||0,liqLong:bucket.liqLong||0,liqShort:bucket.liqShort||0,liqExchanges:JSON.parse(JSON.stringify(bucket.liqExchanges||{}))};
  resetPeriod(config,old+config.ms);
  flushPeriod(config,old,snapshot);
  bucket=state.periods[config.name];
 }
 return bucket;
}
function processRaw(raw){
 const e=normalize(raw);if(!e)return;
 const key=e.id?e.exchange+":"+e.id:[e.timestamp,e.exchange,e.pair,e.side,e.price,e.size,e.count].join("|");
 const seen=Array.isArray(state.tradeSeen)?state.tradeSeen:(state.tradeSeen=[]);
 if(seen.includes(key))return;seen.push(key);if(seen.length>MAX_SEEN)seen.splice(0,seen.length-MAX_SEEN);
 for(const config of PERIODS){
  const p=Math.floor(e.timestamp/config.ms)*config.ms;
  let bucket=state.periods[config.name];
  if(p<bucket.periodStart)continue;
  bucket=advancePeriod(config,p);
  addTrade(bucket,e);
 }
 aggrEvents++;aggrLastEventAt=nowIso();
}
function processLiquidation(raw){
 const e=normalizeLiquidation(raw);if(!e)return;
 const key=e.id?e.exchange+":"+e.id:[e.timestamp,e.exchange,e.pair,e.side,e.price,e.size].join("|");
 const seen=Array.isArray(state.liquidationSeen)?state.liquidationSeen:(state.liquidationSeen=[]);
 if(seen.includes(key))return;seen.push(key);if(seen.length>MAX_SEEN)seen.splice(0,seen.length-MAX_SEEN);
 for(const config of PERIODS){
  const p=Math.floor(e.timestamp/config.ms)*config.ms;
  let bucket=state.periods[config.name];
  if(p<bucket.periodStart)continue;
  bucket=advancePeriod(config,p);
  addLiquidation(bucket,e);
 }
}
function connectAggr(){
 if(aggrRequest){try{aggrRequest.destroy();}catch{}}
 const req=http.get(AGGR_URL,res=>{
  if(res.statusCode!==200){log("AGGR_HTTP_ERROR",{url:AGGR_URL,status:res.statusCode});res.resume();scheduleReconnect();return;}
  aggrConnected=true;let buffer="";res.setEncoding("utf8");
  res.on("data",chunk=>{buffer+=chunk.replace(/\r\n/g,"\n").replace(/\r/g,"\n");const frames=buffer.split("\n\n");buffer=frames.pop()||"";for(const frame of frames){const dataLines=frame.split("\n").filter(x=>x.startsWith("data:"));if(!dataLines.length)continue;const payload=dataLines.map(x=>x.slice(5).replace(/^ /,"")).join("\n");try{processRaw(JSON.parse(payload));}catch(e){log("AGGR_EVENT_PARSE_ERROR",{error:String(e.message||e),payload:payload.slice(0,500)});}}});
  res.on("end",()=>{aggrConnected=false;aggrRequest=null;scheduleReconnect();});
  res.on("error",e=>{aggrConnected=false;aggrRequest=null;log("AGGR_STREAM_ERROR",{error:String(e.message||e)});scheduleReconnect();});
 });
 aggrRequest=req;req.on("error",e=>{aggrConnected=false;aggrRequest=null;log("AGGR_CONNECTION_ERROR",{url:AGGR_URL,error:String(e.message||e)});scheduleReconnect();});
}
function connectLiquidations(){
 const url=(process.env.AGGR_LIQUIDATIONS_URL||"http://127.0.0.1:9090/liquidations");
 const req=http.get(url,res=>{
  if(res.statusCode!==200){log("AGGR_LIQUIDATIONS_HTTP_ERROR",{url,status:res.statusCode});res.resume();scheduleLiquidationReconnect();return;}
  let buffer="";res.setEncoding("utf8");
  res.on("data",chunk=>{buffer+=chunk.replace(/\r\n/g,"\n").replace(/\r/g,"\n");const frames=buffer.split("\n\n");buffer=frames.pop()||"";for(const frame of frames){const dataLines=frame.split("\n").filter(x=>x.startsWith("data:"));if(!dataLines.length)continue;const payload=dataLines.map(x=>x.slice(5).replace(/^ /,"")).join("\n");try{processLiquidation(JSON.parse(payload));}catch(e){log("AGGR_LIQUIDATION_EVENT_PARSE_ERROR",{error:String(e.message||e),payload:payload.slice(0,500)});}}});
  res.on("end",()=>scheduleLiquidationReconnect());
  res.on("error",e=>{log("AGGR_LIQUIDATION_STREAM_ERROR",{error:String(e.message||e)});scheduleLiquidationReconnect();});
 });
 req.on("error",e=>{log("AGGR_LIQUIDATION_CONNECTION_ERROR",{url,error:String(e.message||e)});scheduleLiquidationReconnect();});
}
function scheduleReconnect(){if(reconnectTimer)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;connectAggr();},3000);}
let liquidationReconnectTimer=null;
function scheduleLiquidationReconnect(){if(liquidationReconnectTimer)return;liquidationReconnectTimer=setTimeout(()=>{liquidationReconnectTimer=null;connectLiquidations();},3000);}
function diagnostics(){
 const periods={};for(const config of PERIODS){const p=state.periods[config.name]||defaultSnapshot();periods[config.name]={periodStart:p.periodStart,trades:p.total,buy:p.buy,sell:p.sell,volume:p.volume,exchanges:p.exchanges,liqs:p.liqCount||0,liqValue:p.liqValue||0,liqLong:p.liqLong||0,liqShort:p.liqShort||0,liqExchanges:p.liqExchanges||{}};}
 return{status:"ok",version:VERSION,buildSha:BUILD_SHA,strategy:state.strategy,source:"AGGR",aggrUrl:AGGR_URL,aggrConnected,aggrEvents,aggrLastEventAt,alertsSent:state.alertsSent,periods};
}
function startHealth(){
 const port=Number(process.env.MONITOR_HEALTH_PORT||8080);http.createServer((req,res)=>{
  const p=String(req.url||"/").split("?")[0];
  if(p==="/"||p==="/health"||p==="/status"||p==="/stats"){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify(diagnostics()));}
  if(p==="/logs"){let rows=[];try{rows=fs.readFileSync(LOG_FILE,"utf8").split("\n").filter(Boolean).slice(-300).map(x=>JSON.parse(x));}catch{}res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({status:"ok",events:rows}));}
  if(p==="/logs/stream"){res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache","connection":"keep-alive"});logSubscribers.add(res);req.on("close",()=>logSubscribers.delete(res));return;}
  res.writeHead(404);res.end();
 }).listen(port,"0.0.0.0",()=>log("HEALTH_LISTENING",{port}));
}
function main(){
 ensureDir(STATE_FILE);state=loadState();state.version=VERSION;state.strategy="AGGR_TRADES_LIQUIDATIONS";
 state.tradeSeen=Array.isArray(state.tradeSeen)?state.tradeSeen:(Array.isArray(state.seen)?state.seen:[]);
 state.liquidationSeen=Array.isArray(state.liquidationSeen)?state.liquidationSeen:[];
 state.seen=state.tradeSeen;state.alertsSent=Number(state.alertsSent||0);state.periods=state.periods&&typeof state.periods==="object"?state.periods:{};
 const now=Date.now();
 for(const config of PERIODS){
  const p=Math.floor(now/config.ms)*config.ms;
  if(!state.periods[config.name]||state.periods[config.name].periodStart==null)resetPeriod(config,p);
  else if(state.periods[config.name].periodStart!==p)resetPeriod(config,p);
  else{
   const bucket=state.periods[config.name];
   bucket.exchanges=bucket.exchanges&&typeof bucket.exchanges==="object"?bucket.exchanges:{};
   bucket.liqCount=Number(bucket.liqCount||0);bucket.liqValue=Number(bucket.liqValue||0);bucket.liqLong=Number(bucket.liqLong||0);bucket.liqShort=Number(bucket.liqShort||0);
   bucket.liqExchanges=bucket.liqExchanges&&typeof bucket.liqExchanges==="object"?bucket.liqExchanges:{};
  }
}
 startHealth();connectAggr();connectLiquidations();
 setInterval(()=>{
  const now=Date.now();
  for(const config of PERIODS){
   let bucket=state.periods[config.name],current=Math.floor(now/config.ms)*config.ms;
   while(bucket.periodStart<current){
    const old=bucket.periodStart;
    const snapshot={total:bucket.total,buy:bucket.buy,sell:bucket.sell,volume:bucket.volume,exchanges:JSON.parse(JSON.stringify(bucket.exchanges||{})),liqCount:bucket.liqCount||0,liqValue:bucket.liqValue||0,liqLong:bucket.liqLong||0,liqShort:bucket.liqShort||0,liqExchanges:JSON.parse(JSON.stringify(bucket.liqExchanges||{}))};
    resetPeriod(config,old+config.ms);flushPeriod(config,old,snapshot);bucket=state.periods[config.name];
   }
  }
 },1000);
 log("TRADE_LIQUIDATION_MONITOR_STARTING",{source:"AGGR",tradeUrl:AGGR_URL,liquidationUrl:process.env.AGGR_LIQUIDATIONS_URL||"http://127.0.0.1:9090/liquidations",symbol:"BTC",periods:PERIODS.map(x=>x.name),filters:[],thresholds:[]});
}
main();
