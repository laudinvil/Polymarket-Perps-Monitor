const http = require("http");
const fs = require("fs");
const WebSocket = require("ws");
const path = require("path");
const PORT = Number(process.env.AGGR_BRIDGE_PORT || 9090);
const SYMBOLS = new Set(["BTC"]);
const CLIENTS = new Set();
const LIQ_CLIENTS = new Set();
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

function startBitfinexDirectFeed() {
  const status = ensureExchangeStats("BITFINEX");
  let socket = null;
  let reconnectTimer = null;
  let stopped = false;
  let attempt = 0;
  let channelId = null;

  function connect() {
    if (stopped) return;
    log("BITFINEX_DIRECT_CONNECTING", { pair: "BTCF0:USTF0" });
    socket = new WebSocket("wss://api-pub.bitfinex.com/ws/2");

    socket.on("open", () => {
      attempt = 0;
      log("BITFINEX_DIRECT_OPEN", { pair: "BTCF0:USTF0" });
      socket.send(JSON.stringify({ event: "subscribe", channel: "trades", symbol: "tBTCF0:USTF0" }));
    });

    socket.on("message", raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (!Array.isArray(message)) {
        if (message.event === "subscribed" && message.channel === "trades" && message.pair === "BTCF0:USTF0") {
          channelId = message.chanId;
          status.connectedPairs = 1;
          log("BITFINEX_DIRECT_SUBSCRIBED", { pair: message.pair, channelId });
        } else if (message.event === "error") {
          status.errors++;
          log("BITFINEX_DIRECT_ERROR", { message: message.msg || "subscription error", code: message.code || null });
        }
        return;
      }
      if (message[0] !== channelId || message[1] !== "te" || !Array.isArray(message[2])) return;
      const trade = message[2];
      const timestamp = Number(trade[1]);
      const signedSize = Number(trade[2]);
      const price = Number(trade[3]);
      if (!Number.isFinite(timestamp) || !Number.isFinite(signedSize) || !Number.isFinite(price) || signedSize === 0 || price <= 0) return;
      const normalized = {
        id: "BITFINEX:" + String(trade[0]) + ":" + String(timestamp),
        timestamp,
        exchange: "BITFINEX",
        pair: "BTCF0:USTF0",
        symbol: "BTC",
        side: signedSize > 0 ? "buy" : "sell",
        price,
        size: Math.abs(signedSize),
        count: 1,
        amount: price * Math.abs(signedSize)
      };
      publish(normalized);
      recordExchangeEvent("BITFINEX", "BTC", timestamp);
      feedStats.events++;
      feedStats.byExchange.BITFINEX = (feedStats.byExchange.BITFINEX || 0) + 1;
      feedStats.bySymbol.BTC = (feedStats.bySymbol.BTC || 0) + 1;
      scheduleFeedSummary();
    });

    socket.on("error", error => {
      status.errors++;
      log("BITFINEX_DIRECT_SOCKET_ERROR", { error: String(error.message || error) });
    });

    socket.on("close", (code, reason) => {
      channelId = null;
      status.connectedPairs = 0;
      log("BITFINEX_DIRECT_CLOSED", { code, reason: String(reason || "") });
      if (!stopped) {
        attempt++;
        const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5)));
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, delay);
      }
    });
  }

  connect();
  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    if (socket) socket.close();
  };
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
    if (symbol === "BTC" && (compact === "PIXBTUSD" || compact === "PFXBTUSD" || compact === "BTC" || compact === "BTCF0USTF0")) return symbol;
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
  const exchange = String(event.exchange || "AGGR").toUpperCase();
  const reportedAmount = Number(event.amount);
  const amount = exchange === "BITFINEX" ? price * size : (Number.isFinite(reportedAmount) && reportedAmount > 0 ? reportedAmount : price * size);
  return {id:event.id||"",timestamp:Number(event.timestamp)||Date.now(),exchange,pair:String(event.pair||event.symbol||""),symbol,side:String(event.side||"").toLowerCase(),price,size,count:Number.isFinite(count)&&count>0?count:1,amount};
}
function publish(event) { const data=JSON.stringify(event); for (const res of CLIENTS) { try { res.write("data: "+data+"\n\n"); } catch { CLIENTS.delete(res); } } }
function publishLiquidation(event) { const data=JSON.stringify(event); for (const res of LIQ_CLIENTS) { try { res.write("data: "+data+"\n\n"); } catch { LIQ_CLIENTS.delete(res); } } }
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
    case "BITFINEX": return raw === "BTCF0:USTF0";
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
async function buildExchanges(config){ const ACTIVE_EXCHANGES=new Set(["ASTER","BINANCE_FUTURES","BITFINEX","BITGET","BITUNIX","BYBIT","CRYPTOCOM","GATEIO","HUOBI","HYPERLIQUID","KRAKEN","OKEX","PHEMEX","POLONIEX"]); const names=adapterNames().filter(name=>ACTIVE_EXCHANGES.has(name.toUpperCase())),exchanges=[]; for(const name of names){try{const Exchange=require("aggr-server/src/exchanges/"+name),exchange=new Exchange();exchanges.push(exchange);}catch(error){log("ADAPTER_SKIPPED",{adapter:name,error:String(error.message||error)});}} config.exchanges=exchanges.map(exchange=>exchange.id);config.pairs=[]; const PRODUCT_TIMEOUT_MS=Number(process.env.AGGR_PRODUCT_TIMEOUT_MS||15000); await Promise.all(exchanges.map(async exchange=>{try{await Promise.race([exchange.getProducts(false),new Promise((_,reject)=>setTimeout(()=>reject(new Error("product discovery timeout")),PRODUCT_TIMEOUT_MS))]);const products=Array.isArray(exchange.products)?exchange.products:[];const selected=exchange.id==="BITFINEX"?[]:products.filter(pair=>isPerpetualTradePair(exchange,pair));for(const pair of selected)config.pairs.push(exchange.id+":"+pair);if(exchange.id==="HYPERLIQUID"&&!config.pairs.includes("HYPERLIQUID:BTC"))config.pairs.push("HYPERLIQUID:BTC");log("EXCHANGE_PRODUCTS",{exchange:exchange.id,available:products.length,selected:selected.length,pairs:selected});}catch(error){if(exchange.id==="HYPERLIQUID"&&!config.pairs.includes("HYPERLIQUID:BTC"))config.pairs.push("HYPERLIQUID:BTC");log("PRODUCTS_FAILED",{exchange:exchange.id,error:String(error.message||error)});}})); log("AGGR_EXCHANGES_READY",{adapters:exchanges.length,exchanges:exchanges.map(exchange=>exchange.id),pairs:config.pairs.length});return exchanges; }
async function main(){ fs.mkdirSync("/data",{recursive:true});process.chdir("/data");process.argv.push("config=../../aggr-config.json");const config=require("aggr-server/src/config"),Server=require("aggr-server/src/server"),exchanges=await buildExchanges(config);for(const exchange of exchanges){const status=ensureExchangeStats(exchange.id);status.selectedPairs=config.pairs.filter(pair=>pair.startsWith(exchange.id+":")).length;exchange.on("connected",()=>ensureExchangeStats(exchange.id).connectedPairs++);exchange.on("disconnected",()=>ensureExchangeStats(exchange.id).connectedPairs=Math.max(0,ensureExchangeStats(exchange.id).connectedPairs-1));exchange.on("close",()=>ensureExchangeStats(exchange.id).connectedPairs=0);exchange.on("error",()=>ensureExchangeStats(exchange.id).errors++);exchange.on("liquidations",events=>{for(const event of Array.isArray(events)?events:[events]){
 const symbol=SYMBOLS.has(String(event?.symbol||"").toUpperCase())?String(event.symbol).toUpperCase():symbolFromPair(event?.pair||event?.symbol);
 if(!symbol||String(event?.exchange||exchange.id).toUpperCase()==="HITBTC")continue;
 publishLiquidation({...event,liquidation:true,symbol,exchange:String(event?.exchange||exchange.id).toUpperCase(),timestamp:Number(event?.timestamp||event?.ts||event?.time)||Date.now()});
}});
exchange.on("trades",events=>{for(const event of Array.isArray(events)?events:[events]){const normalized=normalize(event);if(!normalized || normalized.exchange==="DERIBIT")continue;publish(normalized);recordExchangeEvent(normalized.exchange,normalized.symbol,normalized.timestamp);const count=Number(normalized.count||1);feedStats.events+=count;feedStats.byExchange[normalized.exchange]=(feedStats.byExchange[normalized.exchange]||0)+count;feedStats.bySymbol[normalized.symbol]=(feedStats.bySymbol[normalized.symbol]||0)+count;scheduleFeedSummary();}});} new Server(exchanges);startBitfinexDirectFeed();const server=http.createServer((req,res)=>{const pathname=String(req.url||"/").split("?")[0];if(pathname==="/health"){res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});return res.end(JSON.stringify({status:"ok",source:"AGGR",exchanges:exchanges.map(x=>x.id),exchangeCount:exchanges.length+1,pairCount:config.pairs.length,hyperliquid:true,clients:CLIENTS.size,status:exchangeDiagnostics(),krakenDiagnostics:KRAKEN_LAST_ERRORS}));}if(pathname==="/trades"){res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache, no-store, must-revalidate","connection":"keep-alive","access-control-allow-origin":"*"});res.write(": connected\n\n");CLIENTS.add(res);req.on("close",()=>CLIENTS.delete(res));return;}
if(pathname==="/liquidations"){res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache, no-store, must-revalidate","connection":"keep-alive","access-control-allow-origin":"*"});res.write(": connected\n\n");LIQ_CLIENTS.add(res);req.on("close",()=>LIQ_CLIENTS.delete(res));return;}res.writeHead(404);res.end();});server.listen(PORT,"127.0.0.1",()=>log("BRIDGE_LISTENING",{port:PORT,endpoint:"/trades",exchanges:exchanges.map(x=>x.id).concat("KRAKEN"),exchangeCount:exchanges.length+2,pairCount:config.pairs.length}));}
main().catch(error=>{log("FATAL",{error:String(error.stack||error)});process.exit(1);});