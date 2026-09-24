const fs = require("fs");

const GAMMA_API = "https://gamma-api.polymarket.com";
const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const STATE_FILE = "state/btc-5m-oi.json";
const PERIOD = 300;
const POLY_URL = "https://polymarket.com/event/btc-updown-5m-";
const TELEGRAM_UPDATE_MS = 3000;

const CONVEX_URL = process.env.CONVEX_URL || process.env.NEXT_PUBLIC_CONVEX_URL || null;

async function convexMutation(path, args) {
  if (!CONVEX_URL) throw new Error("Missing CONVEX_URL");
  const res = await fetch(CONVEX_URL + "/api/mutation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: path, args: args, format: "json" }),
    signal: AbortSignal.timeout(10000)
  });
  const body = await res.text();
  if (!res.ok) throw new Error("Convex HTTP " + res.status + ": " + body);
  const json = JSON.parse(body);
  if (json.status !== "success") throw new Error("Convex mutation error: " + (json.errorMessage || body));
  return json.value;
}


async function telegramRequest(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });

  const body = await res.text();
  if (!res.ok) throw new Error("Telegram HTTP " + res.status + ": " + body);

  let json;
  try {
    json = JSON.parse(body);
  } catch (_) {
    throw new Error("Invalid Telegram response: " + body);
  }

  if (!json.ok) throw new Error("Telegram API error: " + body);
  return json.result;
}

function formatPrice(value) {
  return Number.isFinite(value) ? value.toFixed(4) : "n/a";
}

function buildTelegramText(market, state) {
  const side = state.firstIncrease ? state.firstIncrease.side : null;
  const from = state.firstIncrease ? state.firstIncrease.from : null;
  const to = state.firstIncrease ? state.firstIncrease.to : null;

  return [
    "🔥 BTC · 5M",
    "",
    "UP: " + formatPrice(displayPrice(state.up)),
    "DOWN: " + formatPrice(displayPrice(state.down)),
    "",
    formatPrice(from) + " → " + formatPrice(to) +
      " · BUY " + (side === "UP" ? "DOWN" : "UP") +
      " " + (side === "UP" ? "⬇️" : "⬆️"),
    "",
    "➡️ Polymarket 5M",
    market.url
  ].join("\n");
}

async function createTelegramMessage(market, state) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("Missing TELEGRAM_CHAT_ID");

  const result = await telegramRequest("sendMessage", {
    chat_id: chatId,
    text: buildTelegramText(market, state),
    disable_web_page_preview: false
  });

  console.log("Telegram NEXT message created message_id=" + result.message_id);
  return result.message_id;
}

async function editTelegramMessage(messageId, market, state) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("Missing TELEGRAM_CHAT_ID");

  await telegramRequest("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: buildTelegramText(market, state),
    disable_web_page_preview: false
  });
}

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
    price: null,
    lastObservedDisplayPrice: null,
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
    firstIncrease: null,
    alerted: false,
    initialPriceUp: null,
    initialPriceDown: null,
    updatedAt: new Date().toISOString()
  };
}

function updatePrice(priceState, data, label) {
  const bestBid = data.best_bid != null ? Number(data.best_bid) :
    data.bestBid != null ? Number(data.bestBid) : priceState.bestBid;
  const bestAsk = data.best_ask != null ? Number(data.best_ask) :
    data.bestAsk != null ? Number(data.bestAsk) : priceState.bestAsk;

  if (Number.isFinite(bestBid)) priceState.bestBid = bestBid;
  if (Number.isFinite(bestAsk)) priceState.bestAsk = bestAsk;

  const price = Number(data.price);
  if (Number.isFinite(price)) {
    priceState.price = price;
    priceState.lastTrade = price;
  }

  const mid = midpoint(priceState.bestBid, priceState.bestAsk);
  if (mid !== null) priceState.midpoint = mid;

  priceState.updatedAt = new Date().toISOString();
  console.log(
    "CLOB STATE " + label +
    " bid=" + (priceState.bestBid ?? "null") +
    " ask=" + (priceState.bestAsk ?? "null") +
    " mid=" + (priceState.midpoint ?? "null")
  );
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
  if (priceState.price == null && priceState.lastTrade != null) {
    priceState.price = priceState.lastTrade;
  }

  priceState.updatedAt = new Date().toISOString();
}

function displayPrice(priceState) {
  const bid = Number(priceState.bestBid);
  const ask = Number(priceState.bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  return (bid + ask) / 2;
}

function detectThresholdCross(state, side, label) {
  if (state.alerted) return false;

  const current = displayPrice(side);
  if (!Number.isFinite(current)) return false;

  const baselineKey = label === "UP" ? "initialPriceUp" : "initialPriceDown";

  // Freeze the first valid midpoint for each side. All later movement
  // is measured against this same baseline, so UP and DOWN are symmetric.
  if (state[baselineKey] === null || state[baselineKey] === undefined) {
    state[baselineKey] = current;
    console.log("INITIAL " + label + " price=" + current.toFixed(4));
    return false;
  }

  const baseline = Number(state[baselineKey]);
  if (!Number.isFinite(baseline) || baseline <= 0) return false;

  // FIRST INCREASE is the first meaningful positive percentage move
  // from the frozen baseline. There is no fixed 0.52/0.53 price bias.
  const movementPct = ((current - baseline) / baseline) * 100;

  // Equal threshold for both sides. A 1% move means the same relative
  // move regardless of whether the side started at 0.51 or 0.49.
  const FIRST_INCREASE_PCT = 13;

  if (movementPct >= FIRST_INCREASE_PCT) {
    state.firstIncrease = {
      side: label,
      from: baseline,
      to: current,
      movementPct: movementPct,
      detectedAt: new Date().toISOString()
    };
    state.alerted = true;

    console.log(
      "FIRST INCREASE detected side=" + label +
      " from=" + baseline.toFixed(4) +
      " to=" + current.toFixed(4) +
      " movePct=" + movementPct.toFixed(3) + "%"
    );

    return true;
  }

  return false;
}
async function runTelegramUpdater(currentStart, market) {
  let telegramMessageId = null;
  let stopped = false;
  let telegramMarketClaimed = false;

  async function updateTelegram() {
    if (stopped) return;
    if (telegramMessageId !== null) return;
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) return;

    const state = readState();
    if (!state.up || !state.down ||
        Number(state.monitoredNextPeriodStart) !== market.start) {
      return;
    }

    if (!state.alerted || !state.firstIncrease) return;

    try {
      if (!telegramMarketClaimed) {
        const claim = await convexMutation("btc5mState:claimTelegramMarketV3", {
          marketSlug: market.slug
        });

        if (!claim.allowed) {
          telegramMarketClaimed = true;
          telegramMessageId = -1;
          console.log("Telegram DEDUPE blocked market=" + market.slug);
          return;
        }

        telegramMarketClaimed = true;
      }

      telegramMessageId = await createTelegramMessage(market, state);
      console.log(
        "Telegram threshold alert sent market=" + market.slug +
        " side=" + state.firstIncrease.side +
        " from=" + formatPrice(state.firstIncrease.from) +
        " to=" + formatPrice(state.firstIncrease.to)
      );
    } catch (err) {
      console.error("Telegram threshold alert failed: " + err.message);
      telegramMarketClaimed = false;
    }
  }

  await updateTelegram();

  const timer = setInterval(function() {
    updateTelegram().catch(function(err) {
      console.error("Telegram updater error: " + err.stack);
    });
  }, TELEGRAM_UPDATE_MS);

  return function stopTelegramUpdater() {
    stopped = true;
    clearInterval(timer);
  };
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
          console.log("Telegram uses one message per NEXT market; edits are throttled to " + TELEGRAM_UPDATE_MS + "ms");

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

          const eventType = message.event_type || message.type || "unknown";
          console.log("CLOB EVENT type=" + eventType);
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
            detectThresholdCross(
              state,
              side,
              side === state.up ? "UP" : "DOWN"
            );
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
              const assetId = change.asset_id || message.asset_id || change.asset;
              const side = assetId === market.tokens.UP ? state.up :
                assetId === market.tokens.DOWN ? state.down : null;
              if (!side) continue;

              const bestBid = change.best_bid ?? change.bestBid ?? change.bid;
              const bestAsk = change.best_ask ?? change.bestAsk ?? change.ask;
              const price = change.price ?? change.last_trade_price ?? change.lastTradePrice;

              updatePrice(side, {
                best_bid: bestBid,
                best_ask: bestAsk,
                price: price
              }, side === state.up ? "UP" : "DOWN");

              detectThresholdCross(
                state,
                side,
                side === state.up ? "UP" : "DOWN"
              );

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
            const assetId = message.asset_id || message.asset;
            const side = assetId === market.tokens.UP ? state.up :
              assetId === market.tokens.DOWN ? state.down : null;
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

  const stopTelegramUpdater = await runTelegramUpdater(currentStart, market);

  try {
    await runWebSocket(currentStart, market);
  } finally {
    stopTelegramUpdater();
  }

  const finalState = readState();
  finalState.finishedMonitoringAt = new Date().toISOString();
  writeState(finalState);

  console.log(
    "NEXT market monitoring finished: " +
    market.slug +
    " UP=" + formatPrice(displayPrice(finalState.up)) +
    " DOWN=" + formatPrice(displayPrice(finalState.down))
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
