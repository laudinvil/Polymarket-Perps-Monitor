const fs = require("fs");

const GAMMA_API = "https://gamma-api.polymarket.com";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const STATE_FILE = "state/btc-5m-oi.json";
const PERIOD = 300;
const POLY_URL = "https://polymarket.com/event/btc-updown-5m-";

function periodStart(ts) {
  return Math.floor(ts / PERIOD) * PERIOD;
}

function sleep(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
}

async function getJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "btc-5m-next-ws-monitor/1.0",
          "Accept": "application/json"
        },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) throw new Error("HTTP " + res.status + " from " + url);
      return await res.json();
    } catch (err) {
      lastError = err;
      console.error("API attempt " + attempt + "/3 failed: " + err.message);
      if (attempt < 3) await sleep(2000);
    }
  }
  throw lastError;
}

function getMarketFromEvent(event) {
  const markets = Array.isArray(event && event.markets) ? event.markets : [];
  const market = markets.find(function(m) {
    const q = String(m.question || "").toLowerCase();
    const s = String(m.slug || "").toLowerCase();
    return s.indexOf("btc-updown-5m") >= 0 ||
      q.indexOf("bitcoin") >= 0 ||
      q.indexOf("btc") >= 0;
  }) || markets[0];

  if (!market) throw new Error("BTC 5M market not found");

  let outcomes = market.outcomes;
  let tokenIds = market.clobTokenIds || market.clob_token_ids;

  try {
    if (typeof outcomes === "string") outcomes = JSON.parse(outcomes);
  } catch (_) {}
  try {
    if (typeof tokenIds === "string") tokenIds = JSON.parse(tokenIds);
  } catch (_) {}

  if (!Array.isArray(outcomes) || !Array.isArray(tokenIds)) {
    throw new Error("BTC 5M market outcomes/token IDs unavailable");
  }

  const tokens = {};
  for (let i = 0; i < outcomes.length; i++) {
    const outcome = String(outcomes[i]).trim().toUpperCase();
    if ((outcome === "UP" || outcome === "DOWN") && tokenIds[i]) {
      tokens[outcome] = String(tokenIds[i]);
    }
  }

  if (!tokens.UP || !tokens.DOWN) {
    throw new Error("BTC 5M UP/DOWN token IDs not found");
  }

  return {
    conditionId: market.conditionId || market.condition_id || null,
    tokens: tokens
  };
}

async function getNextMarket(start) {
  const nextStart = start + PERIOD;
  const slug = "btc-updown-5m-" + nextStart;
  const event = await getJson(GAMMA_API + "/events/slug/" + slug);
  const market = getMarketFromEvent(event);

  return {
    start: nextStart,
    slug: slug,
    url: POLY_URL + nextStart,
    conditionId: market.conditionId,
    tokens: market.tokens
  };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}

function writeState(state) {
  fs.mkdirSync("state", { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

function midpoint(bestBid, bestAsk) {
  const bid = Number(bestBid);
  const ask = Number(bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return (bid + ask) / 2;
}

function createPriceState() {
  return {
    bestBid: null,
    bestAsk: null,
    midpoint: null,
    lastTrade: null,
    updatedAt: null
  };
}

function createNextState(currentStart, market) {
  return {
    monitoredCurrentPeriodStart: currentStart,
    monitoredNextPeriodStart: market.start,
    nextMarketSlug: market.slug,
    nextMarketUrl: market.url,
    nextMarketConditionId: market.conditionId,
    up: createPriceState(),
    down: createPriceState(),
    updatedAt: new Date().toISOString()
  };
}

function updatePrice(priceState, data) {
  const bestBid = data.best_bid != null ? Number(data.best_bid) : priceState.bestBid;
  const bestAsk = data.best_ask != null ? Number(data.best_ask) : priceState.bestAsk;

  if (Number.isFinite(bestBid)) priceState.bestBid = bestBid;
  if (Number.isFinite(bestAsk)) priceState.bestAsk = bestAsk;

  const price = Number(data.price);
  if (Number.isFinite(price)) {
    priceState.lastTrade = price;
  }

  const mid = midpoint(priceState.bestBid, priceState.bestAsk);
  if (mid !== null) priceState.midpoint = mid;

  priceState.updatedAt = new Date().toISOString();
}

function updateFromBook(priceState, bids, asks) {
  if (Array.isArray(bids) && bids.length > 0) {
    const prices = bids
      .map(function(level) { return Number(level && level.price); })
      .filter(Number.isFinite);
    if (prices.length > 0) priceState.bestBid = Math.max.apply(null, prices);
  }

  if (Array.isArray(asks) && asks.length > 0) {
    const prices = asks
      .map(function(level) { return Number(level && level.price); })
      .filter(Number.isFinite);
    if (prices.length > 0) priceState.bestAsk = Math.min.apply(null, prices);
  }

  const mid = midpoint(priceState.bestBid, priceState.bestAsk);
  if (mid !== null) priceState.midpoint = mid;

  priceState.updatedAt = new Date().toISOString();
}

async function runWebSocket(currentStart, market) {
  while (periodStart(Math.floor(Date.now() / 1000)) === currentStart) {
    try {
      await new Promise(function(resolve) {
        const ws = new WebSocket(WS_URL);
        let pingTimer = null;
        let closed = false;

        function finish() {
          if (closed) return;
          closed = true;
          if (pingTimer) clearInterval(pingTimer);
          try { ws.close(); } catch (_) {}
          resolve();
        }

        ws.addEventListener("open", function() {
          console.log(
            "CLOB WebSocket connected; monitoring NEXT market=" +
            market.slug +
            " UP/DOWN"
          );

          ws.send(JSON.stringify({
            type: "market",
            assets_ids: [market.tokens.UP, market.tokens.DOWN],
            custom_feature_enabled: true
          }));

          pingTimer = setInterval(function() {
            if (ws.readyState === WebSocket.OPEN) {
              try { ws.send("PING"); } catch (_) {}
            }
          }, 10000);
        });

        ws.addEventListener("message", function(event) {
          if (event.data === "PONG") return;

          let message;
          try {
            message = JSON.parse(event.data);
          } catch (err) {
            console.error("Invalid CLOB WebSocket message: " + err.message);
            return;
          }

          const eventType = message.event_type;
          const state = readState();

          if (!state.up || !state.down ||
              Number(state.monitoredNextPeriodStart) !== market.start) {
            return;
          }

          if (eventType === "book") {
            const side = message.asset_id === market.tokens.UP ? state.up :
              message.asset_id === market.tokens.DOWN ? state.down : null;
            if (!side) return;

            updateFromBook(side, message.bids, message.asks);
            writeState(state);

            console.log(
              "NEXT " + (side === state.up ? "UP" : "DOWN") +
              " BOOK bid=" + (side.bestBid != null ? side.bestBid.toFixed(4) : "n/a") +
              " ask=" + (side.bestAsk != null ? side.bestAsk.toFixed(4) : "n/a") +
              " mid=" + (side.midpoint != null ? side.midpoint.toFixed(4) : "n/a")
            );
            return;
          }

          if (eventType === "price_change" || eventType === "best_bid_ask") {
            const changes = eventType === "price_change"
              ? (Array.isArray(message.price_changes) ? message.price_changes : [])
              : [message];

            for (const change of changes) {
              const assetId = change.asset_id || message.asset_id;
              const side = assetId === market.tokens.UP ? state.up :
                assetId === market.tokens.DOWN ? state.down : null;
              if (!side) continue;

              updatePrice(side, change);
              console.log(
                "NEXT " + (side === state.up ? "UP" : "DOWN") +
                " bid=" + (side.bestBid != null ? side.bestBid.toFixed(4) : "n/a") +
                " ask=" + (side.bestAsk != null ? side.bestAsk.toFixed(4) : "n/a") +
                " mid=" + (side.midpoint != null ? side.midpoint.toFixed(4) : "n/a")
              );
            }

            state.updatedAt = new Date().toISOString();
            writeState(state);
            return;
          }

          if (eventType === "last_trade_price") {
            const side = message.asset_id === market.tokens.UP ? state.up :
              message.asset_id === market.tokens.DOWN ? state.down : null;
            if (!side) return;

            const price = Number(message.price);
            if (Number.isFinite(price)) {
              side.lastTrade = price;
              side.updatedAt = new Date().toISOString();
              state.updatedAt = side.updatedAt;
              writeState(state);
              console.log(
                "NEXT " + (side === state.up ? "UP" : "DOWN") +
                " last trade=" + price.toFixed(4)
              );
            }
          }
        });

        ws.addEventListener("error", function(event) {
          console.error("CLOB WebSocket error: " + String(event && event.message || "unknown"));
        });

        ws.addEventListener("close", function(event) {
          console.log(
            "CLOB WebSocket closed code=" +
            event.code +
            " reason=" +
            String(event.reason || "")
          );
          finish();
        });

        const rolloverTimer = setInterval(function() {
          if (periodStart(Math.floor(Date.now() / 1000)) !== currentStart) {
            clearInterval(rolloverTimer);
            finish();
          }
        }, 1000);
      });

      if (periodStart(Math.floor(Date.now() / 1000)) !== currentStart) {
        break;
      }

      console.log("CLOB WebSocket reconnecting in 3s");
      await sleep(3000);
    } catch (err) {
      console.error("CLOB WebSocket monitor error: " + err.stack);
      await sleep(3000);
    }
  }
}

async function monitorPeriod(currentStart) {
  const market = await getNextMarket(currentStart);

  console.log(
    "Monitoring ONLY NEXT market: " +
    market.slug +
    " url=" +
    market.url
  );

  const state = createNextState(currentStart, market);
  writeState(state);

  await runWebSocket(currentStart, market);

  const finalState = readState();
  finalState.finishedMonitoringAt = new Date().toISOString();
  writeState(finalState);

  console.log(
    "NEXT market monitoring finished: " +
    market.slug +
    " UP=" + (finalState.up.midpoint != null ? finalState.up.midpoint.toFixed(4) : "n/a") +
    " DOWN=" + (finalState.down.midpoint != null ? finalState.down.midpoint.toFixed(4) : "n/a")
  );
}

async function main() {
  console.log("BTC 5M NEXT-market CLOB WebSocket monitor started");
  console.log("Current live market is NOT monitored");
  console.log("No 4:25 snapshot; NEXT market is streamed continuously");

  while (true) {
    const currentStart = periodStart(Math.floor(Date.now() / 1000));

    try {
      await monitorPeriod(currentStart);
    } catch (err) {
      console.error("Period monitor error: " + err.stack);
      console.log("Keeping monitor alive; retrying in 15s");
      await sleep(15000);
      continue;
    }
  }
}

main().catch(function(err) {
  console.error(err);
  process.exit(1);
});
