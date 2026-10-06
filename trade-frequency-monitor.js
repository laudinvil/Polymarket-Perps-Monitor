const WebSocket = require("ws");
const zlib = require("zlib");

const VERSION = "1.0.1-BTC-5M-TRADE-FREQUENCY-ALERTS";
const PERIOD_MS = 5 * 60 * 1000;
const SYMBOL = "BTCUSDT";

const EXCHANGES = [
  {name:"Binance", url:"wss://fstream.binance.com/public/ws/btcusdt@aggTrade", type:"binance"},
  {name:"Bybit", url:"wss://stream.bybit.com/v5/public/linear", type:"bybit"},
  {name:"OKX", url:"wss://ws.okx.com/ws/v5/public", type:"okx"},
  {name:"Bitget", url:"wss://ws.bitget.com/v2/ws/public", type:"bitget"},
  {name:"Gate.io", url:"wss://fx-ws.gateio.ws/v4/ws/usdt", type:"gate"},
  {name:"Huobi", url:"wss://api.hbdm.com/linear-swap-ws", type:"huobi"}
];

const state = {
  periodStart: Math.floor(Date.now()/PERIOD_MS)*PERIOD_MS,
  total: 0,
  buy: 0,
  sell: 0,
  volume: 0,
  exchanges: Object.fromEntries(EXCHANGES.map(x => [x.name,{trades:0,volume:0,buy:0,sell:0}])),
};

function resetPeriod(start) {
  state.periodStart=start;
  state.total=0; state.buy=0; state.sell=0; state.volume=0;
  for(const x of Object.values(state.exchanges)) {
    x.trades=0; x.volume=0; x.buy=0; x.sell=0;
  }
}

function addTrade(exchange, side, size, price) {
  if(!Number.isFinite(size)||!Number.isFinite(price)) return;
  const x=state.exchanges[exchange];
  if(!x)return;
  const notional=Math.abs(size*price);
  state.total++; state.volume+=notional;
  x.trades++; x.volume+=notional;
  const s=String(side||"").toUpperCase();
  if(s==="BUY"){state.buy++;x.buy++;}
  else if(s==="SELL"){state.sell++;x.sell++;}
}

function sendTelegram(text){
  const token=process.env.TELEGRAM_BOT_TOKEN,chatId=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chatId){console.log(JSON.stringify({ts:new Date().toISOString(),version:VERSION,event:"TRADE_FREQUENCY_TELEGRAM_NOT_CONFIGURED"}));return Promise.resolve(false);}
  return fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text}),signal:AbortSignal.timeout(8000)})
    .then(async response=>{const body=await response.text();if(!response.ok){console.log(JSON.stringify({ts:new Date().toISOString(),version:VERSION,event:"TRADE_FREQUENCY_TELEGRAM_ERROR",status:response.status,body:body.slice(0,500)}));return false;}return true;})
    .catch(error=>{console.log(JSON.stringify({ts:new Date().toISOString(),version:VERSION,event:"TRADE_FREQUENCY_TELEGRAM_ERROR",error:String(error.message||error)}));return false;});
}

function outputPeriod(end) {
  const sec=PERIOD_MS/1000;
  const lines=[
    "🔥 BTC 5m",
    "TRADES: "+state.total.toLocaleString("en-US"),
    "TRADES/SEC: "+(state.total/sec).toFixed(2),
    "BUY: "+state.buy.toLocaleString("en-US")+" | SELL: "+state.sell.toLocaleString("en-US"),
    "VOLUME: $"+state.volume.toLocaleString("en-US",{maximumFractionDigits:0}),
    "",
    "https://polymarket.com/event/btc-updown-5m-"+Math.floor(end/1000)
  ];
  for(const e of EXCHANGES) {
    const x=state.exchanges[e.name];
    lines.push(e.name+": "+x.trades.toLocaleString("en-US"));
  }
  console.log(JSON.stringify({
    ts:new Date(end).toISOString(),
    version:VERSION,
    event:"TRADE_FREQUENCY_PERIOD",
    symbol:SYMBOL,
    periodStart:new Date(state.periodStart).toISOString(),
    periodEnd:new Date(end).toISOString(),
    trades:state.total,
    tradesPerSecond:Number((state.total/sec).toFixed(4)),
    buy:state.buy,
    sell:state.sell,
    volume:Number(state.volume.toFixed(2)),
    exchanges:state.exchanges
  }));
  const message=lines.join("\n");
  console.log(message);
  sendTelegram(message).then(sent=>{
    if(sent) console.log(JSON.stringify({ts:new Date().toISOString(),version:VERSION,event:"TRADE_FREQUENCY_ALERT_SENT",periodEnd:new Date(end).toISOString()}));
  });
}

function connect(cfg) {
  const ws=new WebSocket(cfg.url);
  let ready=false;
  ws.on("open",()=>{
    ready=true;
    if(cfg.type==="bybit") ws.send(JSON.stringify({op:"subscribe",args:["publicTrade."+SYMBOL]}));
    if(cfg.type==="okx") ws.send(JSON.stringify({id:"btc-trades",op:"subscribe",args:[{channel:"trades",instId:"BTC-USDT-SWAP"}]}));
    if(cfg.type==="bitget") ws.send(JSON.stringify({op:"subscribe",args:[{instType:"USDT-FUTURES",channel:"trade",instId:"BTCUSDT"}]}));
    if(cfg.type==="gate") ws.send(JSON.stringify({time:Math.floor(Date.now()/1000),channel:"futures.trades",event:"subscribe",payload:["BTC_USDT"]}));
    if(cfg.type==="huobi") ws.send(JSON.stringify({sub:"market.BTC-USDT.trade.detail",id:String(Date.now())}));
    if(cfg.type==="bitget") ws._heartbeat=setInterval(()=>{if(ws.readyState===1) ws.send("ping");},25000);
  });
  ws.on("message",raw=>{
    let m;
    try{
      let payload=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
      if(cfg.type==="huobi"){
        try{payload=zlib.gunzipSync(payload);}catch{}
      }
      m=JSON.parse(payload.toString());
    }catch{return;}
    if(cfg.type==="huobi" && m.ping){ws.send(JSON.stringify({pong:m.ping}));return;}
    if(cfg.type==="bybit" && m.op==="ping"){ws.send(JSON.stringify({op:"pong"}));return;}
    if(m.event==="error" || m.code && m.msg && (cfg.type==="okx" || cfg.type==="bitget")) { console.log(JSON.stringify({ts:new Date().toISOString(),version:VERSION,event:"TRADE_FREQUENCY_WS_ERROR",exchange:cfg.name,code:m.code,msg:m.msg})); return; }
    if(m.event==="subscribe" || m.event==="login" || m.op==="pong" || m==="pong") return;
    if(cfg.type==="binance"){
      const d=m;
      addTrade("Binance",d.m?"SELL":"BUY",Number(d.q),Number(d.p));
    } else if(cfg.type==="bybit"){
      for(const d of Array.isArray(m.data)?m.data:[]) addTrade("Bybit",d.S,d.v,d.p);
    } else if(cfg.type==="okx"){
      for(const d of Array.isArray(m.data)?m.data:[]) addTrade("OKX",d.side,d.sz,d.px);
    } else if(cfg.type==="bitget"){
      for(const d of Array.isArray(m.data)?m.data:[]) addTrade("Bitget",d.side,d.size,d.price);
    } else if(cfg.type==="gate"){
      for(const d of Array.isArray(m.result)?m.result:[]) addTrade("Gate.io",d.size>0?"BUY":"SELL",Math.abs(Number(d.size)),Number(d.price));
    } else if(cfg.type==="huobi"){
      const data=m.tick?.data||[];
      for(const d of data) addTrade("Huobi",d.direction,d.amount,d.price);
    }
  });
  ws.on("close",()=>{if(ws._heartbeat) clearInterval(ws._heartbeat);setTimeout(()=>connect(cfg),2000).unref();});
  ws.on("error",()=>{try{ws.close();}catch{}});
  return ws;
}

for(const cfg of EXCHANGES) connect(cfg);

setInterval(()=>{
  const now=Date.now();
  while(now>=state.periodStart+PERIOD_MS){
    const end=state.periodStart+PERIOD_MS;
    outputPeriod(end);
    resetPeriod(end);
  }
},1000);

console.log(JSON.stringify({
  ts:new Date().toISOString(),
  version:VERSION,
  event:"TRADE_FREQUENCY_MONITOR_STARTING",
  symbol:SYMBOL,
  period:"5m",
  exchanges:EXCHANGES.map(x=>x.name)
}));
