const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.AGGR_BRIDGE_PORT || 9090);
const SYMBOLS = new Set(["BTC","ETH","SOL","XRP","DOGE","BNB","HYPE"]);
const CLIENTS = new Set();

function log(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: "AGGR_BRIDGE", event, ...data }));
}

function symbolFromPair(pair) {
  const raw = String(pair || "").toUpperCase();
  for (const symbol of SYMBOLS) {
    if (raw.replace(/[^A-Z]/g, "").startsWith(symbol)) return symbol;
  }
  return null;
}

function normalize(event) {
  if (!event || event.liquidation !== true) return null;
  const symbol = symbolFromPair(event.pair || event.symbol);
  if (!symbol) return null;

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
    try { res.write("data: " + data + "\n\n"); }
    catch { CLIENTS.delete(res); }
  }
}

function adapterNames() {
  const dir = path.dirname(require.resolve("aggr-server/src/exchanges/binance_futures"));
  return fs.readdirSync(dir)
    .filter(name => name.endsWith(".js"))
    .map(name => name.slice(0, -3))
    .filter(name => name !== "index");
}

function isUsefulDerivativePair(pair) {
  const raw = String(pair || "").toUpperCase();
  if (!symbolFromPair(raw)) return false;

  // Prefer perpetual/futures/swap contracts. Some AGGR derivatives adapters
  // expose plain USDT/USD contract symbols, so those are accepted as well.
  return /PERP|SWAP|FUT|USDT|USDC|USD/.test(raw);
}

async function buildExchanges(config) {
  const names = adapterNames();
  const exchanges = [];

  for (const name of names) {
    try {
      const Exchange = require("aggr-server/src/exchanges/" + name);
      const exchange = new Exchange();
      exchanges.push(exchange);
    } catch (error) {
      log("ADAPTER_SKIPPED", { adapter: name, error: String(error.message || error) });
    }
  }

  // Let AGGR manage all available adapters. We only subscribe to the seven
  // requested symbols, and only to products exposed by each adapter.
  config.exchanges = exchanges.map(exchange => exchange.id);
  config.pairs = [];

  for (const exchange of exchanges) {
    try {
      await exchange.getProducts(false);
      const products = Array.isArray(exchange.products) ? exchange.products : [];
      const selected = products.filter(isUsefulDerivativePair);

      for (const pair of selected) {
        config.pairs.push(exchange.id + ":" + pair);
      }

      log("EXCHANGE_PRODUCTS", {
        exchange: exchange.id,
        available: products.length,
        selected: selected.length,
        pairs: selected
      });
    } catch (error) {
      log("PRODUCTS_FAILED", {
        exchange: exchange.id,
        error: String(error.message || error)
      });
    }
  }

  log("AGGR_EXCHANGES_READY", {
    adapters: exchanges.length,
    exchanges: exchanges.map(exchange => exchange.id),
    pairs: config.pairs.length
  });

  return exchanges;
}

async function main() {
  // Deplexo mounts /data as writable while the application image is read-only.
  // aggr-server's persistence module initializes during require() and writes
  // persistence.json relative to process.cwd(), regardless of persistence
  // settings. Keep that file in the writable runtime volume.
  fs.mkdirSync("/data", { recursive: true });
  process.chdir("/data");

  process.argv.push("config=../../aggr-config.json");
  const config = require("aggr-server/src/config");
  const Server = require("aggr-server/src/server");
  const exchanges = await buildExchanges(config);

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
      res.writeHead(200, {
        "content-type":"application/json",
        "cache-control":"no-store"
      });
      return res.end(JSON.stringify({
        status:"ok",
        source:"AGGR",
        exchanges:exchanges.map(x=>x.id),
        exchangeCount:exchanges.length,
        pairCount:config.pairs.length,
        clients:CLIENTS.size
      }));
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
    port: PORT,
    endpoint: "/liquidations",
    exchanges: exchanges.map(x=>x.id),
    exchangeCount: exchanges.length,
    pairCount: config.pairs.length
  }));
}

main().catch(error => {
  log("FATAL", {error:String(error.stack || error)});
  process.exit(1);
});
