const fs=require("fs");
const path=require("path");
const http=require("http");

const VERSION="26.8.20-BTC-5M-TRADE-FREQUENCY";
const BUILD_SHA=process.env.MONITOR_BUILD_SHA||"unknown";
const AGGR_URL=process.env.AGGR_URL||"http://127.0.0.1:9090/trades";
const STATE_FILE=process.env.STATE_FILE||"/data/aggr-trade-state.json";
const LOG_FILE=process.env.LOG_FILE||"/data/aggr-trade.jsonl";
const PERIOD_MS=5*60*1000;
const SYMBOL="BTC";
const MAX_SEEN=20000;
const LOG_MAX_BYTES=2*1024*1024;
const LOG_KEEP_BYTES=1*1024*1024;
const EXCLUDED_EXCHANGES=new Set(["HITBTC"]);
let state,aggrRequest=null,aggrConnected=false,aggrEvents=0,aggrLastEventAt=null,reconnectTimer=null,alertInFlight=new Set(),logSubscribers=new Set();

function nowIso(){return new Date().toISOString();}
function num(v){const n=Number(v);return Number.isFinite(n)?n:null;}
function ensureDir(file){fs.mkdirSync(path.dirname(file),{recursive:true});}
function log(event,data={}){
 const row={ts:nowIso(),version:VERSION,event,...data};
 try{ensureDir(LOG_FILE);fs.appendFileSync(LOG_FILE,JSON.stringify(row)+"\n");for(const res of logSubscribers){try{res.write("data: "+JSON.stringify(row)+"\n\n");}catch{logSubscribers.delete(res);}}const size=fs.statSync(LOG_FILE).size;if(size>LOG_MAX_BYTES){const fd=fs.openSync(LOG_FILE,"r"),buf=Buffer.alloc(LOG_KEEP_BYTES);fs.readSync(fd,buf,0,LOG_KEEP_BYTES,size-LOG_KEEP_BYTES);fs.closeSync(fd);const i=buf.indexOf(10);fs.writeFileSync(LOG_FILE,i>=0?buf.subarray(i+1):buf);}}catch{}
}
function defaultState(){return{version:VERSION,strategy:"AGGR_TRADES",periodStart:null,seen:[],alertsSent:0,lastPeriodTradesPerSec:null};}
function loadState(){try{const v=JSON.parse(fs.readFileSync(STATE_FILE,"utf8"));if(v&&typeof v==="object")return v;}catch{}return defaultState();}
function saveState(){try{ensureDir(STATE_FILE);const tmp=STATE_FILE+".tmp";fs.writeFileSync(tmp,JSON.stringify(state));fs.renameSync(tmp,STATE_FILE);}catch{}}
function resetPeriod(start){state.periodStart=start;state.total=0;state.buy=0;state.sell=0;state.volume=0;state.exchanges={};}
function normalize(raw){
 const symbol=String(raw?.symbol||raw?.pair||"").toUpperCase().replace(/USDT|USDC|USD|PERP|SWAP|[-_]/g,"");
 if(symbol!==SYMBOL)return null;
 const price=num(raw?.price),size=num(raw?.size);if(price===null||size===null||price<=0||size<=0)return null;
 const count=num(raw?.count);let timestamp=num(raw?.timestamp)??Date.now();if(timestamp<1e12)timestamp*=1000;const exchange=String(raw?.exchange||"AGGR").toUpperCase();if(EXCLUDED_EXCHANGES.has(exchange))return null;return{id:raw?.id?String(raw.id):"",timestamp,exchange,pair:String(raw?.pair||raw?.symbol||""),side:String(raw?.side||"").toLowerCase(),price,size,count:count&&count>0?count:1,amount:num(raw?.amount)};
}
function addTrade(e){
 const count=e.count||1,volume=e.amount!==null&&e.amount>0?Math.abs(e.amount):Math.abs(e.price*e.size)/count,x=state.exchanges[e.exchange]||(state.exchanges[e.exchange]={trades:0,volume:0,buy:0,sell:0});
 state.total+=count;state.volume+=volume;x.trades+=count;x.volume+=volume;
 if(e.side==="buy"){state.buy+=count;x.buy+=count;}else if(e.side==="sell"){state.sell+=count;x.sell+=count;}
}
function sendTelegram(text){const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;if(!token||!chatId)return Promise.resolve(false);return fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text}),signal:AbortSignal.timeout(8000)}).then(r=>r.ok).catch(()=>false);}
function marketUrl(period){return "https://polymarket.com/event/btc-updown-5m-"+Math.floor(period/1000);}
async function flushPeriod(period,snapshot){
 const key="period:"+period;if(alertInFlight.has(key))return;alertInFlight.add(key);
 try{
  const tradesPerSec=snapshot.total/(PERIOD_MS/1000);
  const previousTradesPerSec=state.lastPeriodTradesPerSec;
  const arrow=previousTradesPerSec===null?"":tradesPerSec>previousTradesPerSec?" ⬇️":tradesPerSec<previousTradesPerSec?" ⬆️":"";
  state.lastPeriodTradesPerSec=tradesPerSec;
  const lines=["🔥 BTC 5m","TRADES: "+snapshot.total.toLocaleString("en-US"),"TRADES/SEC: "+tradesPerSec.toFixed(2)+arrow,"BUY: "+snapshot.buy.toLocaleString("en-US")+" | SELL: "+snapshot.sell.toLocaleString("en-US"),"",marketUrl(period+PERIOD_MS)];
  const exchanges=Object.entries(snapshot.exchanges).filter(([name])=>!EXCLUDED_EXCHANGES.has(String(name).toUpperCase())).sort((a,b)=>b[1].trades-a[1].trades);
  for(const [name,data] of exchanges)lines.push((name.toUpperCase()==="BINANCE_FUTURES"?"BINANCE":name.toUpperCase())+": "+data.trades.toLocaleString("en-US"));
  const sent=await sendTelegram(lines.join("\n"));
  log(sent?"TRADE_FREQUENCY_ALERT_SENT":"TRADE_FREQUENCY_ALERT_FAILED",{source:"AGGR",period,periodEnd:new Date(period).toISOString(),trades:snapshot.total,buy:snapshot.buy,sell:snapshot.sell,volume:snapshot.volume,exchanges:Object.fromEntries(exchanges)});
  if(sent)state.alertsSent=Number(state.alertsSent||0)+1;saveState();
 }finally{alertInFlight.delete(key);}
}
function processRaw(raw){
 const e=normalize(raw);if(!e)return;
 const key=e.id?e.exchange+":"+e.id:[e.timestamp,e.exchange,e.pair,e.side,e.price,e.size,e.count].join("|");
 if(state.seen.includes(key))return;state.seen.push(key);if(state.seen.length>MAX_SEEN)state.seen.splice(0,state.seen.length-MAX_SEEN);
 const p=Math.floor(e.timestamp/PERIOD_MS)*PERIOD_MS;
 if(state.periodStart==null)resetPeriod(p);
 while(p>state.periodStart){const old=state.periodStart;const snapshot={total:state.total,buy:state.buy,sell:state.sell,volume:state.volume,exchanges:JSON.parse(JSON.stringify(state.exchanges))};resetPeriod(old+PERIOD_MS);flushPeriod(old,snapshot);}
 if(p<state.periodStart)return;addTrade(e);aggrEvents++;aggrLastEventAt=nowIso();
}
function connectAggr(){
 if(aggrRequest){try{aggrRequest.destroy();}catch{}}
 const req=http.get(AGGR_URL,res=>{
  if(res.statusCode!==200){log("AGGR_HTTP_ERROR",{status:res.statusCode});res.resume();scheduleReconnect();return;}
  aggrConnected=true;let buffer="";res.setEncoding("utf8");
  res.on("data",chunk=>{
   buffer+=chunk.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
   const frames=buffer.split("\n\n");buffer=frames.pop()||"";
   for(const frame of frames){
    const dataLines=frame.split("\n").filter(x=>x.startsWith("data:"));
    if(!dataLines.length)continue;
    const payload=dataLines.map(x=>x.slice(5).replace(/^ /,"")).join("\n");
    try{processRaw(JSON.parse(payload));}
    catch(e){log("AGGR_EVENT_PARSE_ERROR",{error:String(e.message||e),payload:payload.slice(0,500)});}
   }
  });
  res.on("end",()=>{aggrConnected=false;aggrRequest=null;scheduleReconnect();});
  res.on("error",e=>{aggrConnected=false;aggrRequest=null;log("AGGR_STREAM_ERROR",{error:String(e.message||e)});scheduleReconnect();});
 });
 aggrRequest=req;req.on("error",e=>{aggrConnected=false;aggrRequest=null;log("AGGR_CONNECTION_ERROR",{error:String(e.message||e)});scheduleReconnect();});
}
function scheduleReconnect(){if(reconnectTimer)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;connectAggr();},3000);}
function diagnostics(){return{status:"ok",version:VERSION,buildSha:BUILD_SHA,strategy:state.strategy,source:"AGGR",aggrUrl:AGGR_URL,aggrConnected,aggrEvents,aggrLastEventAt,alertsSent:state.alertsSent,periodStart:state.periodStart,trades:state.total,buy:state.buy,sell:state.sell,volume:state.volume,exchanges:state.exchanges};}
function startHealth(){const port=Number(process.env.MONITOR_HEALTH_PORT||8080);http.createServer((req,res)=>{const p=String(req.url||"/").split("?")[0];if(p==="/"||p==="/health"||p==="/status"||p==="/stats"){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify(diagnostics()));}if(p==="/logs"){let rows=[];try{rows=fs.readFileSync(LOG_FILE,"utf8").split("\n").filter(Boolean).slice(-300).map(x=>JSON.parse(x));}catch{}res.writeHead(200,{"content-type":"application/json"});return res.end(JSON.stringify({status:"ok",events:rows}));}if(p==="/logs/stream"){res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache","connection":"keep-alive"});logSubscribers.add(res);req.on("close",()=>logSubscribers.delete(res));return;}res.writeHead(404);res.end();}).listen(port,"0.0.0.0",()=>log("HEALTH_LISTENING",{port}));}
function main(){ensureDir(STATE_FILE);state=loadState();state.version=VERSION;state.strategy="AGGR_TRADES";state.seen=Array.isArray(state.seen)?state.seen:[];state.alertsSent=Number(state.alertsSent||0);state.lastPeriodTradesPerSec=num(state.lastPeriodTradesPerSec);resetPeriod(Math.floor(Date.now()/PERIOD_MS)*PERIOD_MS);startHealth();connectAggr();setInterval(()=>{const now=Math.floor(Date.now()/PERIOD_MS)*PERIOD_MS;while(state.periodStart<now){const old=state.periodStart;const snapshot={total:state.total,buy:state.buy,sell:state.sell,volume:state.volume,exchanges:JSON.parse(JSON.stringify(state.exchanges))};resetPeriod(old+PERIOD_MS);flushPeriod(old,snapshot);}},1000);log("TRADE_FREQUENCY_MONITOR_STARTING",{source:"AGGR",symbol:"BTC",period:"5m"});}
main();
