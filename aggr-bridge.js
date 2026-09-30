const http = require("http");
const fs = require("fs");
const HyperliquidLiquidationAdapter = require("./hyperliquid-liquidation-adapter");
const hyperliquid = new HyperliquidLiquidationAdapter();
const path = require("path");
const PORT = Number(process.env.AGGR_BRIDGE_PORT || 9090);
const SYMBOLS = new Set(["BTC","ETH","SOL","XRP","DOGE","BNB","HYPE"]);
const LIQUIDATION_EXCHANGES = new Set([
  "BINANCE_FUTURES",
  "BYBIT",
  "OKEX",
  "DYDX",
  "BITGET",
  "BITMART",
  "KRAKEN",
  "BITFINEX",
  "GATEIO",
  "HUOBI"
]);
const CLIENTS = new Set();
const FEED_LOG_MS = 60000;
const feedStats = { events: 0, byExchange: {}, bySymbol: {} };
const exchangeStatus = {};
const WINDOW_MS = 60 * 60 * 1000;
function ensureExchangeStats(id) {
  if (!exchangeStatus[id]) {
    exchangeStatus[id] = {
      connectedPairs: 0,
      selectedPairs: 0,
      lastEventAt: null,
      errors: 0,
      events: [],
      bySymbol: {}
    };
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
      bySymbolLast60m: Object.fromEntries(
        Object.entries(value.bySymbol).map(([symbol, list]) => [symbol, list.filter(ts => ts >= cutoff).length])
      )
    }];
  }));
}
let feedLogTimer = null;

function log(event, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component: "AGGR_BRIDGE", event, ...data }));
}

function scheduleFeedSummary() {
  if (feedLogTimer) return;
  feedLogTimer = setTimeout(() => {
    feedLogTimer = null;
    if (!feedStats.events) return;
    log("FEED_SUMMARY", {
      events: feedStats.events,
      byExchange: feedStats.byExchange,
      bySymbol: feedStats.bySymbol
    });
    feedStats.events = 0;
    feedStats.byExchange = {};
    feedStats.bySymbol = {};
  }, FEED_LOG_MS);
}

function symbolFromPair(pair) {
  const raw = String(pair || "").toUpperCase().replace(/[^A-Z0-9_-]/g, "");
  const compact = raw.replace(/[-_]/g, "");

  for (const symbol of SYMBOLS) {
    const bases = symbol === "BTC" ? ["BTC", "XBT"] : [symbol];
    for (const base of bases) {
      if (
        compact === base + "USDT" ||
        compact === base + "USDC" ||
        compact === base + "USD" ||
        compact === base + "USDT" + "PERP" ||
        compact === base + "USDC" + "PERP" ||
        compact === base + "USD" + "PERP" ||
        compact === base + "USDT" + "SWAP" ||
        compact === base + "USDC" + "SWAP" ||
        compact === base + "USD" + "SWAP"
      ) return symbol;
    }
    if (symbol === "BTC" && (compact === "PIXBTUSD" || compact === "PFXBTUSD")) {
      return symbol;
    }
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

function isPerpetualLiquidationPair(exchange, pair) {
  const raw = String(pair || "").toUpperCase();
  const symbol = symbolFromPair(raw);
  const id = String(exchange.id || "").toUpperCase();
  if (!symbol) return false;

  // Subscribe only to perpetual/swap liquidation markets. Exclude spot and dated futures.
  // Several exchanges expose spot and perpetual products with the same
  // symbol (for example BYBIT:BNBUSDT), so the exchange must be told which
  // product family is allowed instead of matching the symbol alone.
  if (/(?:^|[-_])\\d{6,8}$/.test(raw)) return false;

  switch (id) {
    case "BINANCE_FUTURES":
      return /(?:USDT|USDC|USD)(?:[-_]PERP)?$/.test(raw);
    case "BYBIT":
      return /(?:USDT|USDC|USD)(?:-PERP|-SWAP)?$/.test(raw) && !raw.endsWith("-SPOT");
    case "OKEX":
      return /-SWAP$/.test(raw);
    case "DYDX":
      return /-USD$/.test(raw);
    case "KRAKEN":
      return /^(?:PI|PF)_/.test(raw);
    case "GATEIO":
      return /_(?:USDT|USDC|USD)$/.test(raw);
    case "HUOBI":
      return /-(?:USDT|USD)$/.test(raw) && !raw.includes("_");
    case "BITMEX":
      return /^(?:XBT|BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)(?:USD|USDT|USDC)$/.test(raw);
    case "BITFINEX":
      return /^(?:BTC|ETH|SOL|XRP|DOGE|BNB|HYPE)(?:USD|USDT|USDC)$/.test(raw);
    case "BITGET":
      return /(?:USDT|USDC|USD)(?:-PERP|-SWAP)?$/.test(raw) && !raw.endsWith("-SPOT");
    case "BITMART":
      return /(?:USDT|USDC|USD)(?:-PERP|-SWAP)?$/.test(raw) && !raw.endsWith("-SPOT");
    default:
      return false;
  }
}

async function buildExchanges(config) {
  const names = adapterNames();
  const exchanges = [];

  for (const name of names) {
    if (!LIQUIDATION_EXCHANGES.has(name.toUpperCase())) {
      continue;
    }
    try {
      const Exchange = require("aggr-server/src/exchanges/" + name);
      const exchange = new Exchange();
      exchanges.push(exchange);
    } catch (error) {
      log("ADAPTER_SKIPPED", { adapter: name, error: String(error.message || error) });
    }
  }

  // Subscribe only to the seven requested symbols and their perpetual/swap
  // liquidation markets.
  config.exchanges = exchanges.map(exchange => exchange.id);
  config.pairs = [];

  for (const exchange of exchanges) {
    try {
      await exchange.getProducts(false);
      const products = Array.isArray(exchange.products) ? exchange.products : [];
      const selected = products.filter(pair => isPerpetualLiquidationPair(exchange, pair));

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
    // One listener per exchange, not one listener per pair. AGGR can have
    // many connected pairs and its EventEmitter otherwise exceeds the
    // default listener limit (10), producing MaxListenersExceededWarning.
    const status = ensureExchangeStats(exchange.id);
    status.selectedPairs = config.pairs.filter(pair => pair.startsWith(exchange.id + ":")).length;

    exchange.on("connected", () => {
      ensureExchangeStats(exchange.id).connectedPairs++;
    });
    exchange.on("disconnected", () => {
      ensureExchangeStats(exchange.id).connectedPairs = Math.max(0, ensureExchangeStats(exchange.id).connectedPairs - 1);
    });
    exchange.on("close", () => {
      ensureExchangeStats(exchange.id).connectedPairs = 0;
    });
    exchange.on("error", () => {
      ensureExchangeStats(exchange.id).errors++;
    });

    exchange.on("liquidations", events => {
      for (const event of Array.isArray(events) ? events : [events]) {
        const normalized = normalize(event);
        if (!normalized) continue;

        publish(normalized);
        recordExchangeEvent(normalized.exchange, normalized.symbol, normalized.timestamp);
        feedStats.events++;
        feedStats.byExchange[normalized.exchange] = (feedStats.byExchange[normalized.exchange] || 0) + 1;
        feedStats.bySymbol[normalized.symbol] = (feedStats.bySymbol[normalized.symbol] || 0) + 1;
        scheduleFeedSummary();
      }
    });
  }

  hyperliquid.on("connected", () => {
    ensureExchangeStats("HYPERLIQUID");
    exchangeStatus.HYPERLIQUID.connectedPairs = 1;
  });
  hyperliquid.on("disconnected", () => {
    exchangeStatus.HYPERLIQUID = exchangeStatus.HYPERLIQUID || { connectedPairs: 0, lastEventAt: null, errors: 0 };
    exchangeStatus.HYPERLIQUID.connectedPairs = 0;
  });
  hyperliquid.on("liquidations", event => {
    const normalized = normalize(event);
    if (!normalized) return;
    publish(normalized);
    exchangeStatus.HYPERLIQUID = exchangeStatus.HYPERLIQUID || { connectedPairs: 0, lastEventAt: null, errors: 0 };
    recordExchangeEvent("HYPERLIQUID", normalized.symbol, normalized.timestamp);
    feedStats.events++;
    feedStats.byExchange.HYPERLIQUID = (feedStats.byExchange.HYPERLIQUID || 0) + 1;
    feedStats.bySymbol[normalized.symbol] = (feedStats.bySymbol[normalized.symbol] || 0) + 1;
    scheduleFeedSummary();
  });
  hyperliquid.on("error", () => {
    exchangeStatus.HYPERLIQUID = exchangeStatus.HYPERLIQUID || { connectedPairs: 0, lastEventAt: null, errors: 0 };
    ensureExchangeStats("HYPERLIQUID").errors++;
  });
  hyperliquid.start();

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
        exchangeCount:exchanges.length + 1,
        pairCount:config.pairs.length,
        hyperliquid: true,
        clients:CLIENTS.size,
        status: exchangeDiagnostics()
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
    exchanges: exchanges.map(x=>x.id).concat("HYPERLIQUID"),
    exchangeCount: exchanges.length + 1,
    pairCount: config.pairs.length
  }));
}

main().catch(error => {
  log("FATAL", {error:String(error.stack || error)});
  process.exit(1);
});
