const http = require("http");
const fs = require("fs");
const WebSocket = require("ws");
const path = require("path");
const PORT = Number(process.env.AGGR_BRIDGE_PORT || 9090);
const SYMBOLS = new Set(["BTC"]);
const CLIENTS = new Set();
const FEED_LOG_MS = 60000;
const KRAKEN_POLL_MS = Number(process.env.KRAKEN_POLL_MS || 2000);
const KRAKEN_SYMBOLS = [
  ["BTC", ["PI_XBTUSD", "PF_XBTUSD"]]
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
      if (bitfinexCompact === base + "USDT" || bitfinexCompact === base + "USDC" || bitfinexCompact === base + "USD" || compact === base + "USDT" + "PERP" || compact === base + "USDC" + "PERP" || compact === base + "USD" + "PERP" || compact === base + "USDT" + "SWAP" || compact === base + "USDC" + "SWAP" || compact === base + "USD" + "SWAP" || compact === base + "USDC" + "PERPETUAL" || compact === base + "USD" + "PERPETUAL") return symbol;
    }
    if (symbol === "BTC" && (compact === "PIXBTUSD" || compact === "PFXBTUSD" || compact === "BTC")) return symbol;
  }
  return null;
}
function normalize(event) {
  if (!event || event.liquidation === true) return null;
  const explicitSymbol = String(event.symbol || "").toUpperCase();
  const symbol = SYMBOLS.has(explicitSymbol) ? explicitSymbol : symbolFromPair(event.pair || event.symbol);
  if (!symbol) return null;
  const price = Number(event.price), size = Number(event.size);
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) return null;
  const count = Number(event.count);
  const amount = Number(event.amount);
  return {id:event.id||"",timestamp:Number(event.timestamp)||Date.now(),exchange:String(event.exchange||"AGGR").toUpperCase(),pair:String(event.pair||event.symbol||""),symbol,side:String(event.side||"").toLowerCase(),price,size,count:Number.isFinite(count)&&count>0?count:1,amount:Number.isFinite(amount)&&amount>0?amount:price*size};
}
function publish(event) { const data=JSON.stringify(event); for (const res of CLIENTS) { try { res.write("data: "+data+"\n\n"); } catch { CLIENTS.delete(res); } } }
function adapterNames() { const dir=path.dirname(require.resolve("aggr-server/src/exchanges/binance_futures")); return fs.readdirSync(dir).filter(name=>name.endsWith(".js")).map(name=>name.slice(0,-3)).filter(name=>name!=="index"); }
function isPerpetualTradePair(exchange,pair) {
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
    case "ASTER": return /(?:USDT|USDC|USD)(?:[-_]?(?:PERP|SWAP))?$/.test(raw);
    case "BINANCE": return false;
    case "BINANCE_US": return false;
    case "BITUNIX": return /(?:USDT|USDC|USD)(?:[-_]?(?:PERP|SWAP))?$/.test(raw);
    case "COINBASE": return /(?:-PERP|-SWAP)$/.test(raw);
    case "CRYPTOCOM": return /(?:USDT|USDC|USD)(?:[-_]?(?:PERP|SWAP))?$/.test(raw);
    case "HITBTC": return /(?:USDT|USDC|USD)(?:[-_]?(?:PERP|SWAP))?$/.test(raw);
    case "KUCOIN": return /(?:USDTM|USDCM|USDM)$/.test(raw);
    case "PHEMEX": return /(?:USDT|USDC|USD)(?:[-_]?(?:PERP|SWAP))?$/.test(raw);
    case "POLONIEX": return /(?:USDT|USDC|USD)(?:[-_]?(?:PERP|SWAP))?$/.test(raw);
    case "HYPERLIQUID": return raw === "BTC";
    case "BITSTAMP": return false;
    default: return false;
  }
}
async function buildExchanges(config){ const ACTIVE_EXCHANGES=new Set(["BINANCE_FUTURES"]); const names=adapterNames().filter(name=>ACTIVE_EXCHANGES.has(name.toUpperCase())),exchanges=[]; for(const name of names){try{const Exchange=require("aggr-server/src/exchanges/"+name),exchange=new Exchange();exchanges.push(exchange);}catch(error){log("ADAPTER_SKIPPED",{adapter:name,error:String(error.message||error)});}} config.exchanges=exchanges.map(exchange=>exchange.id);config.pairs=[]; for(const exchange of exchanges){try{await exchange.getProducts(false);const products=Array.isArray(exchange.products)?exchange.products:[],selected=products.filter(pair=>isPerpetualTradePair(exchange,pair));for(const pair of selected)config.pairs.push(exchange.id+":"+pair);if(exchange.id==="HYPERLIQUID"&&!config.pairs.includes("HYPERLIQUID:BTC"))config.pairs.push("HYPERLIQUID:BTC");log("EXCHANGE_PRODUCTS",{exchange:exchange.id,available:products.length,selected:selected.length,pairs:selected});}catch(error){if(exchange.id==="HYPERLIQUID"&&!config.pairs.includes("HYPERLIQUID:BTC"))config.pairs.push("HYPERLIQUID:BTC");log("PRODUCTS_FAILED",{exchange:exchange.id,error:String(error.message||error)});}} log("AGGR_EXCHANGES_READY",{adapters:exchanges.length,exchanges:exchanges.map(exchange=>exchange.id),pairs:config.pairs.length});return exchanges; }
async function main(){ fs.mkdirSync("/data",{recursive:true});process.chdir("/data");process.argv.push("config=../../aggr-config.json");const config=require("aggr-server/src/config"),Server=require("aggr-server/src/server"),exchanges=await buildExchanges(config);for(const exchange of exchanges){const status=ensureExchangeStats(exchange.id);status.selectedPairs=config.pairs.filter(pair=>pair.startsWith(exchange.id+":")).length;exchange.on("connected",()=>ensureExchangeStats(exchange.id).connectedPairs++);exchange.on("disconnected",()=>ensureExchangeStats(exchange.id).connectedPairs=Math.max(0,ensureExchangeStats(exchange.id).connectedPairs-1));exchange.on("close",()=>ensureExchangeStats(exchange.id).connectedPairs=0);exchange.on("error",()=>ensureExchangeStats(exchange.id).errors++);exchange.on("trades",events=>{for(const event of Array.isArray(events)?events:[events]){const normalized=normalize(event);if(!normalized || normalized.exchange==="DERIBIT")continue;publish(normalized);recordExchangeEvent(normalized.exchange,normalized.symbol,normalized.timestamp);const count=Number(normalized.count||1);feedStats.events+=count;feedStats.byExchange[normalized.exchange]=(feedStats.byExchange[normalized.exchange]||0)+count;feedStats.bySymbol[normalized.symbol]=(feedStats.bySymbol[normalized.symbol]||0)+count;scheduleFeedSummary();}});} new Server(exchanges);const server=http.createServer((req,res)=>{const pathname=String(req.url||"/").split("?")[0];if(pathname==="/health"){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify({status:"ok",source:"AGGR",exchanges:exchanges.map(x=>x.id),exchangeCount:exchanges.length,pairCount:config.pairs.length,hyperliquid:true,clients:CLIENTS.size,status:exchangeDiagnostics(),krakenDiagnostics:KRAKEN_LAST_ERRORS}));}if(pathname==="/trades"){res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache, no-store, must-revalidate","connection":"keep-alive","access-control-allow-origin":"*"});res.write(": connected\n\n");CLIENTS.add(res);req.on("close",()=>CLIENTS.delete(res));return;}res.writeHead(404);res.end();});server.listen(PORT,"127.0.0.1",()=>log("BRIDGE_LISTENING",{port:PORT,endpoint:"/trades",exchanges:exchanges.map(x=>x.id),exchangeCount:exchanges.length,pairCount:config.pairs.length}));}
main().catch(error=>{log("FATAL",{error:String(error.stack||error)});process.exit(1);});