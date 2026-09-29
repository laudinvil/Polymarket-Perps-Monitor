const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.AGGR_BRIDGE_PORT || 9090);
const SYMBOLS = new Set(["BTC","ETH","SOL","XRP","DOGE","BNB","HYPE"]);
const CLIENTS = new Set();

function log(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: "AGGR_BRIDGE", event, ...data }));
}

function normalize(event) {
  if (!event || event.liquidation !== true) return null;
  const symbol = String(event.pair || event.symbol || "").toUpperCase()
    .replace(/USDT|USDC|USD|PERP|[-_]/g, "").replace("SWAP", "");
  if (!SYMBOLS.has(symbol)) return null;
  const price = Number(event.price);
  const size = Number(event.size);
  if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size <= 0) return null;
  return {
    id: event.id || "",
    timestamp: Number(event.timestamp) || Date.now(),
    exchange: String(event.exchange || "AGGR").toUpperCase(),
    pair: String(event.pair || event.symbol || ""),
    symbol,
    side: String(event.side || "").toLowerCase(),
    price,
    size
  };
}

function publish(event) {
  const data = JSON.stringify(event);
  for (const res of CLIENTS) {
    try { res.write("data: " + data + "\n\n"); } catch { CLIENTS.delete(res); }
  }
}

function buildExchanges(config) {
  // AGGR is the only liquidation source used by the monitor.
  // These are AGGR exchange adapters, not direct monitor connections.
  config.exchanges = ["binance_futures", "bybit", "okex"];
  return config.exchanges.map(name => new (require("aggr-server/src/exchanges/" + name))());
}

async function main() {
  process.argv.push("config=" + path.join(__dirname, "aggr-config.json"));
  const config = require("aggr-server/src/config");
  const Server = require("aggr-server/src/server");
  const exchanges = buildExchanges(config);

  for (const exchange of exchanges) {
    exchange.on("liquidations", events => {
      for (const event of Array.isArray(events) ? events : [events]) {
        const normalized = normalize(event);
        if (!normalized) continue;
        publish(normalized);
        log("LIQUIDATION", {
          exchange: normalized.exchange,
          symbol: normalized.symbol,
          side: normalized.side,
          price: normalized.price,
          size: normalized.size
        });
      }
    });
  }

  new Server(exchanges);

  const server = http.createServer((req, res) => {
    const pathname = String(req.url || "/").split("?")[0];
    if (pathname === "/health") {
      res.writeHead(200, {"content-type":"application/json","cache-control":"no-store"});
      return res.end(JSON.stringify({status:"ok",source:"AGGR",exchanges:exchanges.map(x=>x.id),clients:CLIENTS.size}));
    }
    if (pathname === "/liquidations") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-store, must-revalidate",
        "connection": "keep-alive",
        "access-control-allow-origin": "*"
      });
      res.write(": connected\n\n");
      CLIENTS.add(res);
      req.on("close", () => CLIENTS.delete(res));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(PORT, "127.0.0.1", () => log("BRIDGE_LISTENING", {
    port: PORT, endpoint: "/liquidations", exchanges: exchanges.map(x=>x.id)
  }));
}

main().catch(error => {
  log("FATAL", {error:String(error.stack || error)});
  process.exit(1);
});
