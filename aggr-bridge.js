const http = require("http");
const fs = require("fs");
const WebSocket = require("ws");
const path = require("path");
const PORT = Number(process.env.AGGR_BRIDGE_PORT || 9090);
const SYMBOLS = new Set(["BTC","ETH","SOL","XRP","DOGE","BNB","HYPE"]);
const LIQUIDATION_EXCHANGES = new Set([
  "BINANCE_FUTURES",
  "BYBIT",
  "OKEX",
  "BITGET",
  "GATEIO",
  "HUOBI"
]);
const CLIENTS = new Set();
const FEED_LOG_MS = 60000;
const KRAKEN_POLL_MS = Number(process.env.KRAKEN_POLL_MS || 2000);
const KRAKEN_SYMBOLS = [
  ["BTC", ["PI_XBTUSD", "PF_XBTUSD"]],
  ["ETH", ["PI_ETHUSD", "PF_ETHUSD"]],
  ["SOL", ["PI_SOLUSD", "PF_SOLUSD"]],
  ["XRP", ["PI_XRPUSD", "PF_XRPUSD"]],
  ["DOGE", ["PI_DOGEUSD", "PF_DOGEUSD"]],
  ["BNB", ["PI_BNBUSD", "PF_BNBUSD"]],
  ["HYPE", ["PI_HYPEUSD", "PF_HYPEUSD"]]
];
const KRAKEN_SEEN = new Set();
const KRAKEN_ERROR_LOGGED = new Set();
const KRAKEN_LAST_ERRORS = {};
const feedStats = { events: 0, byExchange: {}, bySymbol: {} };
const exchangeStatus = {};
const WINDOW_MS = 60 * 60 * 1000;
function ensureExchangeStats(id) {
  if (!exchangeStatus[id]) {
    exchangeStatus[id] = { connectedPairs: 0, selectedPairs: 0, lastEventAt: null, errors: 0, events: [], bySymbol: {} };
  }
  return exchangeStatus[id];
}
function recordExchangeEvent(id, symbol, timestamp) {
  const status = ensureExchangeStats(id);
  const ts = Number(timestamp) || Date.now();
  status.lastEventAt = new Date(ts).toISOString();
  status.events.push(ts);
  status.bySymbol[symbol] = Array.isArray(status.bySymbol[symbol]) ? status.bySymbol[symbol] : [];
  status.bySymbol[symbol].push(ts);
  pruneExchangeStats(status);
}
function pruneExchangeStats(status) {
  const cutoff = Date.now() - WINDOW_MS;
  while (status.events.length && status.events[0] < cutoff) status.events.shift();
  for (const symbol of Object.keys(status.bySymbol)) {
    const list = status.bySymbol[symbol];
    while (list.length && list[0] < cutoff) list.shift();
    if (!list.length) delete status.bySymbol[symbol];
  }
}
function exchangeDiagnostics() {
  const cutoff = Date.now() - WINDOW_MS;
  return Object.fromEntries(Object.entries(exchangeStatus).map(([id, value]) => {
    pruneExchangeStats(value);
    return [id, {
      selectedPairs: value.selectedPairs || 0,
      connectedPairs: value.connectedPairs || 0,
      lastEventAt: value.lastEventAt,
      ageSec: value.lastEventAt ? Math.max(0, Math.floor((Date.now() - Date.parse(value.lastEventAt)) / 1000)) : null,
      errors: value.errors || 0,
      eventsLast60m: value.events.length,
      bySymbolLast60m: Object.fromEntries(Object.entries(value.bySymbol).map(([symbol, list]) => [symbol, list.filter(ts => ts >= cutoff).length]))
    }];
  }));
}
let feedLogTimer = null;
function log(event, data = {}) { console.log(JSON.stringify({ ts: new Date().toISOString(), component: "AGGR_BRIDGE", event, ...data })); }
function scheduleFeedSummary() {
  if (feedLogTimer) return;
  feedLogTimer = setTimeout(() => {
    feedLogTimer = null;
    if (!feedStats.events) return;
    log("FEED_SUMMARY", { events: feedStats.events, byExchange: feedStats.byExchange, bySymbol: feedStats.bySymbol });
    feedStats.events = 0; feedStats.byExchange = {}; feedStats.bySymbol = {};
  }, FEED_LOG_MS);
}
function symbolFromPair(pair) {
  const raw = String(pair || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const compact = raw.replace(/[-_]/g, "");
  const bitfinexCompact = compact.startsWith("T") ? compact.slice(1) : compact;
  for (const symbol of SYMBOLS) {
    const bases = symbol === "BTC" ? ["BTC", "XBT"] : [symbol];
    for (const base of bases) {
      if (bitfinexCompact === base + "USDT" || bitfinexCompact === base + "USDC" || bitfinexCompact === base + "USD" || compact === base + "USDT" + "PERP" || compact === base + "USDC" + "PERP" || compact === base + "USD" + "PERP" || compact === base + "USDT" + "SWAP" || compact === base + "USDC" + "SWAP" || compact === base + "USD" + "SWAP") return symbol;
    }
    if (symbol === "BTC" && (compact === "PIXBTUSD" || compact === "PFXBTUSD")) return symbol;
  }
  return null;
}
function normalize(event) {
  if (!event || event.liquidation !== true) return null;
  const explicitSymbol = String(event.symbol || "").toUpperCase();
  const symbol = SYMBOLS.has(explicitSymbol) ? explicitSymbol : symbolFromPair(event.pair || event.symbol);
  if (!symbol) return null;
  const price = Number(event.price), size = Number(event.size);
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) return null;
  return { id:event.id || "", timestamp:Number(event.timestamp)||Date.now(), exchange:String(event.exchange||"AGGR").toUpperCase(), pair:String(event.pair||event.symbol||""), symbol, side:String(event.side||"").toLowerCase(), price, size };
}
function publish(event) { const data=JSON.stringify(event); for (const res of CLIENTS) { try { res.write("data: "+data+"\n\n"); } catch { CLIENTS.delete(res); } } }
function adapterNames() { const dir=path.dirname(require.resolve("aggr-server/src/exchanges/binance_futures")); return fs.readdirSync(dir).filter(name=>name.endsWith(".js")).map(name=>name.slice(0,-3)).filter(name=>name!=="index"); }
function isPerpetualLiquidationPair(exchange,pair) {
  const raw=String(pair||"").toUpperCase(), symbol=symbolFromPair(raw), id=String(exchange.id||"").toUpperCase();
  if (!symbol) return false;
  if (/(?:^|[-_])\\d{6,8}$/.test(raw)) return false;
  switch(id) {
    case "BINANCE_FUTURES": return /(?:USDT|USDC|USD)(?:[-_]PERP)?$/.test(raw);
    case "BYBIT": return /(?:USDT|USDC|USD)(?:-PERP|-SWAP)?$/.test(raw)&&!raw.endsWith("-SPOT");
    case "OKEX": return /-SWAP$/.test(raw);
    case "DYDX": return /-USD$/.test(raw);
    case "KRAKEN": return /^(?:PI|PF)_/.test(raw);
    case "GATEIO": return /_(?:USDT|USDC|USD)$/.test(raw);
    case "HUOBI": return /-(?:USDT|USD)$/.test(raw)&&!raw.includes("_");
    case "BITMEX": return /^(?:XBT|BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)(?:USD|USDT|USDC)$/.test(raw);
    case "BITFINEX": return /^(?:BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)(?:USD|USDT|USDC)$/.test(raw);
    case "BITGET": return /(?:USDT|USDC|USD)(?:-PERP|-SWAP)?$/.test(raw)&&!raw.endsWith("-SPOT");
    case "BITMART": return /(?:USDT|USDC|USD)(?:-PERP|-SWAP)?$/.test(raw)&&!raw.endsWith("-SPOT");
    default: return false;
  }
}
function publishDirectLiquidation(event) {
  const normalized=normalize(event); if (!normalized) return;
  publish(normalized); recordExchangeEvent(normalized.exchange,normalized.symbol,normalized.timestamp);
  feedStats.events++; feedStats.byExchange[normalized.exchange]=(feedStats.byExchange[normalized.exchange]||0)+1; feedStats.bySymbol[normalized.symbol]=(feedStats.bySymbol[normalized.symbol]||0)+1; scheduleFeedSummary();
}
function emitDirect(exchange,symbol,pair,side,price,size,timestamp,id) {
  if (!Number.isFinite(Number(price))||!Number.isFinite(Number(size))||Number(price)<=0||Number(size)<=0) return;
  publishDirectLiquidation({id:id||"",timestamp:Number(timestamp)||Date.now(),exchange,pair,symbol,side,price:Number(price),size:Number(size),liquidation:true});
}
function startBitfinexDirect() {
  const status=ensureExchangeStats("BITFINEX"); let rawLogged=0; status.selectedPairs=SYMBOLS.size;
  const ws=new WebSocket("wss://api-pub.bitfinex.com/ws/2");
  ws.on("open",()=>{ ws.send(JSON.stringify({event:"subscribe",channel:"status",key:"liq:global"})); log("DIRECT_CONNECTED",{exchange:"BITFINEX",source:"BITFINEX_LIQ_GLOBAL"}); });
  ws.on("message",raw=>{ try { const rawText=String(raw),msg=JSON.parse(rawText); if(rawLogged<5&&!(msg&&msg[1]==="hb")){rawLogged++;log("DIRECT_RAW",{exchange:"BITFINEX",message:rawText});} if(!Array.isArray(msg)||msg.length<2||!Array.isArray(msg[1]))return; for(const liq of msg[1]){if(!Array.isArray(liq)||liq[0]!=="pos")continue; const pair=String(liq[4]||""),symbol=symbolFromPair(pair); if(!symbol)continue; const amount=Number(liq[5]),basePrice=Number(liq[6]),liquidationPrice=Number(liq[11]),price=Number.isFinite(liquidationPrice)&&liquidationPrice>0?liquidationPrice:basePrice,size=Math.abs(amount),side=amount<0?"buy":"sell",timestamp=Number(liq[2])||Date.now(); emitDirect("BITFINEX",symbol,pair,side,price,size,timestamp,"bitfinex:"+liq[1]+":"+timestamp);}} catch(error){status.errors++;log("DIRECT_PARSE_ERROR",{exchange:"BITFINEX",error:String(error.message||error)});} });
  ws.on("error",error=>{status.errors++;log("DIRECT_ERROR",{exchange:"BITFINEX",error:String(error.message||error)});});
  ws.on("close",()=>{status.connectedPairs=0;log("DIRECT_CLOSED",{exchange:"BITFINEX"});setTimeout(startBitfinexDirect,3000);}); status.connectedPairs=1;
}
async function pollKrakenSymbol(symbol,pair){ const url="https://futures.kraken.com/derivatives/api/v3/history?symbol="+encodeURIComponent(pair),response=await fetch(url); if(!response.ok)throw new Error("HTTP "+response.status); const body=await response.json(),history=Array.isArray(body.history)?body.history:[]; for(const trade of history){if(String(trade.type||"").toLowerCase()!=="liquidation")continue; const id=String(trade.trade_id??trade.uid??(trade.time+":"+trade.price+":"+trade.size)),key=pair+":"+id; if(KRAKEN_SEEN.has(key))continue; KRAKEN_SEEN.add(key); if(KRAKEN_SEEN.size>5000){const first=KRAKEN_SEEN.values().next().value;if(first)KRAKEN_SEEN.delete(first);} const timestamp=Date.parse(String(trade.time||""))||Date.now(),side=String(trade.side||"").toLowerCase(); emitDirect("KRAKEN",symbol,pair,side,Number(trade.price),Number(trade.size),timestamp,"kraken:"+id); } }
function startKrakenDirect(){ const status=ensureExchangeStats("KRAKEN"); status.selectedPairs=KRAKEN_SYMBOLS.length; status.connectedPairs=KRAKEN_SYMBOLS.length; let running=false; const tick=async()=>{if(running)return;running=true;try{for(const [symbol,pairs]of KRAKEN_SYMBOLS)for(const pair of pairs)try{await pollKrakenSymbol(symbol,pair);}catch(error){const message=String(error.message||error);status.errors++;const key=pair+":"+message;if(!KRAKEN_ERROR_LOGGED.has(key)){KRAKEN_ERROR_LOGGED.add(key);KRAKEN_LAST_ERRORS[pair]={symbol,error:message,at:new Date().toISOString()};log("DIRECT_ERROR",{exchange:"KRAKEN",pair,symbol,error:message});}}}finally{running=false;}}; log("DIRECT_CONNECTED",{exchange:"KRAKEN",source:"KRAKEN_PUBLIC_TRADE_HISTORY",pollMs:KRAKEN_POLL_MS,pairs:KRAKEN_SYMBOLS.flatMap(x=>x[1])});tick();setInterval(tick,KRAKEN_POLL_MS); }
async function buildExchanges(config){ const names=adapterNames(),exchanges=[]; for(const name of names){if(!LIQUIDATION_EXCHANGES.has(name.toUpperCase()))continue;try{const Exchange=require("aggr-server/src/exchanges/"+name),exchange=new Exchange();exchanges.push(exchange);}catch(error){log("ADAPTER_SKIPPED",{adapter:name,error:String(error.message||error)});}} config.exchanges=exchanges.map(exchange=>exchange.id);config.pairs=[]; for(const exchange of exchanges){try{await exchange.getProducts(false);const products=Array.isArray(exchange.products)?exchange.products:[],selected=products.filter(pair=>isPerpetualLiquidationPair(exchange,pair));for(const pair of selected)config.pairs.push(exchange.id+":"+pair);log("EXCHANGE_PRODUCTS",{exchange:exchange.id,available:products.length,selected:selected.length,pairs:selected});}catch(error){log("PRODUCTS_FAILED",{exchange:exchange.id,error:String(error.message||error)});}} log("AGGR_EXCHANGES_READY",{adapters:exchanges.length,exchanges:exchanges.map(exchange=>exchange.id),pairs:config.pairs.length});return exchanges; }
async function main(){ fs.mkdirSync("/data",{recursive:true});process.chdir("/data");process.argv.push("config=../../aggr-config.json");const config=require("aggr-server/src/config"),Server=require("aggr-server/src/server"),exchanges=await buildExchanges(config);startBitfinexDirect();startKrakenDirect();for(const exchange of exchanges){const status=ensureExchangeStats(exchange.id);status.selectedPairs=config.pairs.filter(pair=>pair.startsWith(exchange.id+":")).length;exchange.on("connected",()=>ensureExchangeStats(exchange.id).connectedPairs++);exchange.on("disconnected",()=>ensureExchangeStats(exchange.id).connectedPairs=Math.max(0,ensureExchangeStats(exchange.id).connectedPairs-1));exchange.on("close",()=>ensureExchangeStats(exchange.id).connectedPairs=0);exchange.on("error",()=>ensureExchangeStats(exchange.id).errors++);exchange.on("liquidations",events=>{for(const event of Array.isArray(events)?events:[events]){const normalized=normalize(event);if(!normalized)continue;publish(normalized);recordExchangeEvent(normalized.exchange,normalized.symbol,normalized.timestamp);feedStats.events++;feedStats.byExchange[normalized.exchange]=(feedStats.byExchange[normalized.exchange]||0)+1;feedStats.bySymbol[normalized.symbol]=(feedStats.bySymbol[normalized.symbol]||0)+1;scheduleFeedSummary();}});} new Server(exchanges);const server=http.createServer((req,res)=>{const pathname=String(req.url||"/").split("?")[0];if(pathname==="/health"){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify({status:"ok",source:"AGGR",exchanges:exchanges.map(x=>x.id),exchangeCount:exchanges.length+2,pairCount:config.pairs.length,hyperliquid:false,clients:CLIENTS.size,status:exchangeDiagnostics(),krakenDiagnostics:KRAKEN_LAST_ERRORS}));}if(pathname==="/liquidations"){res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache, no-store, must-revalidate","connection":"keep-alive","access-control-allow-origin":"*"});res.write(": connected\n\n");CLIENTS.add(res);req.on("close",()=>CLIENTS.delete(res));return;}res.writeHead(404);res.end();});server.listen(PORT,"127.0.0.1",()=>log("BRIDGE_LISTENING",{port:PORT,endpoint:"/liquidations",exchanges:exchanges.map(x=>x.id).concat("BITFINEX","KRAKEN"),exchangeCount:exchanges.length+2,pairCount:config.pairs.length}));}
main().catch(error=>{log("FATAL",{error:String(error.stack||error)});process.exit(1);});