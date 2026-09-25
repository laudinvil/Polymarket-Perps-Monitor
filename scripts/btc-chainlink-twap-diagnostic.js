const RTDS_URL = "wss://ws-live-data.polymarket.com";
const GAMMA_URL = "https://gamma-api.polymarket.com";
const CLOB_URL = "https://clob.polymarket.com";

const RUN_MS = 5 * 60 * 60 * 1000;
const POLL_MS = 15 * 1000;
const PERIOD_MS = 5 * 60 * 1000;
const HISTORY_MAX = 240;
const MIN_EDGE = Number(process.env.BTC_5M_MIN_EDGE ?? "0.00");

const API_KEY = process.env.CHAINLINK_DATA_STREAMS_API_KEY || "";
const USER_SECRET = process.env.CHAINLINK_DATA_STREAMS_USER_SECRET || "";
const FEED_ID =
  process.env.CHAINLINK_DATA_STREAMS_FEED_ID ||
  "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8";
const CHAINLINK_REST =
  process.env.CHAINLINK_DATA_STREAMS_REST_URL || "https://api.dataengine.chain.link";
const CHAINLINK_WS =
  process.env.CHAINLINK_DATA_STREAMS_WS_URL || "wss://ws.dataengine.chain.link";

let stopping = false;
let rtdsWs = null;
let latestRtds = null;
let latestChainlink = null;
let chainlinkStream = null;
let currentPeriodStart = null;
let periodStartPrice = null;
let latestMarket = null;
const priceHistory = [];
const alertedPeriods = new Set();

function log(level, event, message, data = undefined) {
  console.log(JSON.stringify({
    level,
    event,
    message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) })
  }));
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

function parseJson(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
  return response.json();
}

function periodStart(now = Date.now()) {
  return Math.floor(now / PERIOD_MS) * PERIOD_MS;
}

function periodSlug(startMs) {
  return "btc-updown-5m-" + Math.floor(startMs / 1000);
}

function extractRtds(message) {
  if (!message || message.topic !== "crypto_prices_twap_sixty") return null;
  const p = message.payload || {};
  const value = num(p.value ?? p.price ?? p.twap ?? p.twapPrice);
  if (value === null) return null;

  return {
    value,
    timestamp: num(p.timestamp ?? p.ts ?? message.timestamp),
    receivedAt: Date.now()
  };
}

function connectRtds() {
  rtdsWs = new WebSocket(RTDS_URL);

  rtdsWs.addEventListener("open", () => {
    log("INFO", "rtds_connected", "Connected to Polymarket RTDS");
    rtdsWs.send(JSON.stringify({
      action: "subscribe",
      subscriptions: [{ topic: "crypto_prices_twap_sixty", type: "update" }]
    }));
  });

  rtdsWs.addEventListener("message", event => {
    try {
      const row = extractRtds(JSON.parse(String(event.data)));
      if (!row) return;
      latestRtds = row;
    } catch (err) {
      log("WARN", "rtds_parse_failed", "RTDS message parse failed", { message: err.message });
    }
  });

  rtdsWs.addEventListener("error", err => {
    log("WARN", "rtds_error", "RTDS websocket error", {
      message: String(err?.message || err)
    });
  });

  rtdsWs.addEventListener("close", () => {
    if (!stopping) {
      log("WARN", "rtds_closed", "RTDS closed; reconnecting");
      setTimeout(connectRtds, 1000);
    }
  });
}

async function connectChainlink() {
  if (!API_KEY || !USER_SECRET) {
    log("WARN", "chainlink_credentials_missing",
      "Chainlink Data Streams credentials are missing; direct Chainlink leg disabled", {
        apiKey: Boolean(API_KEY),
        userSecret: Boolean(USER_SECRET),
        feedId: FEED_ID
      });
    return;
  }

  try {
    const sdk = await import("@chainlink/data-streams-sdk");
    const { createClient, decodeReport } = sdk;

    const client = createClient({
      apiKey: API_KEY,
      userSecret: USER_SECRET,
      endpoint: CHAINLINK_REST,
      wsEndpoint: CHAINLINK_WS
    });

    chainlinkStream = client.createStream([FEED_ID]);

    chainlinkStream.on("report", report => {
      try {
        const decoded = decodeReport(report.fullReport, report.feedID);
        const raw = decoded?.benchmarkPrice ?? decoded?.price;
        const value = num(raw) === null ? null : Number(raw) / 1e18;
        if (value === null) throw new Error("No benchmark price in report");

        latestChainlink = {
          value,
          timestamp: num(report.observationsTimestamp),
          validFrom: num(report.validFromTimestamp),
          receivedAt: Date.now()
        };

        priceHistory.push({
          timestamp: Date.now(),
          value
        });
        while (priceHistory.length > HISTORY_MAX) priceHistory.shift();
      } catch (err) {
        log("WARN", "chainlink_decode_failed", "Chainlink report decode failed", {
          message: err.message
        });
      }
    });

    chainlinkStream.on("error", err => {
      log("WARN", "chainlink_stream_error", "Chainlink stream error", {
        message: String(err?.message || err)
      });
    });

    await chainlinkStream.connect();
    log("INFO", "chainlink_connected", "Connected to Chainlink Data Streams", {
      feedId: FEED_ID
    });
  } catch (err) {
    log("WARN", "chainlink_connect_failed", "Chainlink connection failed", {
      message: err.message
    });
  }
}

function activePrice() {
  return latestChainlink?.value ?? latestRtds?.value ?? null;
}

function dataDelta() {
  if (!latestChainlink || !latestRtds) return null;
  const deltaUsd = latestChainlink.value - latestRtds.value;
  return {
    deltaUsd,
    deltaBps: latestRtds.value ? deltaUsd / latestRtds.value * 10_000 : null,
    chainlinkAgeMs: Date.now() - latestChainlink.receivedAt,
    rtdsAgeMs: Date.now() - latestRtds.receivedAt
  };
}

function volatilityPerSqrtSecond() {
  if (priceHistory.length < 20) return null;

  const returns = [];
  for (let i = 1; i < priceHistory.length; i++) {
    const a = priceHistory[i - 1];
    const b = priceHistory[i];
    const dt = (b.timestamp - a.timestamp) / 1000;
    if (dt <= 0 || a.value <= 0 || b.value <= 0) continue;
    returns.push({
      r: Math.log(b.value / a.value),
      dt
    });
  }

  if (returns.length < 20) return null;

  const mean = returns.reduce((s, x) => s + x.r, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x.r - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const avgDt = returns.reduce((s, x) => s + x.dt, 0) / returns.length;
  if (!Number.isFinite(variance) || avgDt <= 0) return null;

  return Math.sqrt(variance / avgDt);
}

function normalCdf(x) {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    0.254829592 +
    t * (-0.284496736 +
    t * (1.421413741 +
    t * (-1.453152027 + t * 1.061405429)));
  const erf = 1 - poly * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

function resetPeriodIfNeeded() {
  const start = periodStart();

  if (currentPeriodStart === start) return false;

  currentPeriodStart = start;
  periodStartPrice = activePrice();

  log("INFO", "new_5m_period", "Started new BTC 5M period", {
    start: new Date(start).toISOString(),
    end: new Date(start + PERIOD_MS).toISOString(),
    periodStartPrice
  });

  return true;
}

function settlementProbabilityUp() {
  const price = activePrice();
  if (price === null || periodStartPrice === null) return null;

  const remainingMs = currentPeriodStart + PERIOD_MS - Date.now();
  if (remainingMs <= 0) return null;

  const sigma = volatilityPerSqrtSecond();
  if (!sigma || sigma <= 0) return null;

  const horizon = remainingMs / 1000;
  const denominator = sigma * Math.sqrt(horizon);
  if (denominator <= 0) return null;

  const logMove = Math.log(price / periodStartPrice);
  return normalCdf(logMove / denominator);
}

function marketOutcomeTokens(event) {
  const markets = Array.isArray(event?.markets) ? event.markets : [];

  for (const market of markets) {
    const outcomes = parseJson(market.outcomes);
    const tokenIds = parseJson(market.clobTokenIds);

    if (!Array.isArray(outcomes) || !Array.isArray(tokenIds)) continue;
    if (outcomes.length !== tokenIds.length) continue;

    const rows = outcomes.map((outcome, i) => ({
      outcome: text(outcome),
      tokenId: text(tokenIds[i])
    }));

    const up = rows.find(x => /^up$/i.test(x.outcome));
    const down = rows.find(x => /^down$/i.test(x.outcome));

    if (up && down) {
      return {
        market,
        up,
        down
      };
    }
  }

  return null;
}

async function discoverMarket() {
  const start = periodStart();
  const slug = periodSlug(start);

  let event = null;

  try {
    event = await getJson(
      GAMMA_URL + "/events/slug/" + encodeURIComponent(slug)
    );
  } catch {
    const data = await getJson(
      GAMMA_URL + "/events?slug=" + encodeURIComponent(slug) +
      "&active=true&closed=false&limit=10"
    );
    event = Array.isArray(data) ? data[0] : null;
  }

  if (!event) return null;

  const tokens = marketOutcomeTokens(event);
  if (!tokens) return null;

  return {
    slug,
    url: "https://polymarket.com/event/" + text(event.slug || slug),
    eventId: text(event.id),
    title: text(event.title),
    upToken: tokens.up.tokenId,
    downToken: tokens.down.tokenId,
    marketId: text(tokens.market.id),
    question: text(tokens.market.question)
  };
}

async function midpoint(tokenId) {
  const data = await getJson(
    CLOB_URL + "/midpoint?token_id=" + encodeURIComponent(tokenId)
  );
  return num(data?.mid ?? data?.price);
}

async function fetchMarketPrices(market) {
  const [up, down] = await Promise.all([
    midpoint(market.upToken),
    midpoint(market.downToken)
  ]);

  return { up, down };
}

function bestEdge(probabilityUp, prices) {
  if (probabilityUp === null) return null;

  const candidates = [
    {
      side: "UP",
      model: probabilityUp,
      price: prices.up,
      edge: prices.up === null ? null : probabilityUp - prices.up
    },
    {
      side: "DOWN",
      model: 1 - probabilityUp,
      price: prices.down,
      edge: prices.down === null ? null : (1 - probabilityUp) - prices.down
    }
  ];

  return candidates
    .filter(x => Number.isFinite(x.edge) && Number.isFinite(x.price))
    .sort((a, b) => b.edge - a.edge)[0] || null;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";

  if (!token || !chatId) {
    log("WARN", "telegram_not_configured", "Telegram credentials are missing");
    return false;
  }

  const response = await fetch(
    "https://api.telegram.org/bot" + token + "/sendMessage",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        disable_web_page_preview: false
      }),
      signal: AbortSignal.timeout(10_000)
    }
  );

  if (!response.ok) throw new Error("Telegram HTTP " + response.status);

  const body = await response.json();
  if (!body.ok) throw new Error("Telegram API rejected message");

  return true;
}

async function maybeAlert(market, probabilityUp, prices, edge) {
  if (!edge || edge.edge < MIN_EDGE) return;

  const periodKey = currentPeriodStart + ":" + edge.side;
  if (alertedPeriods.has(periodKey)) return;

  const comparison = dataDelta();
  const remaining = Math.max(
    0,
    Math.round((currentPeriodStart + PERIOD_MS - Date.now()) / 1000)
  );

  const message = [
    "🔥 BTC · 5M",
    "",
    "SIGNAL: " + edge.side,
    "MODEL: " + (edge.model * 100).toFixed(2) + "%",
    "CLOB: " + (edge.price * 100).toFixed(2) + "%",
    "EDGE: +" + (edge.edge * 100).toFixed(2) + "%",
    "",
    "CHAINLINK: $" + activePrice().toFixed(2),
    "START TWAP: $" + periodStartPrice.toFixed(2),
    "RTDS TWAP60: " + (latestRtds ? "$" + latestRtds.value.toFixed(2) : "N/A"),
    "DS ↔ RTDS: " +
      (comparison
        ? (comparison.deltaUsd >= 0 ? "+" : "") + comparison.deltaUsd.toFixed(2) +
          " USD (" + comparison.deltaBps.toFixed(2) + " bps)"
        : "N/A"),
    "TIME LEFT: " + Math.floor(remaining / 60) + ":" +
      String(remaining % 60).padStart(2, "0"),
    "",
    "➡️ NEXT · Polymarket 5M",
    "https://polymarket.com/event/" + market.slug
  ].join("\n");

  await sendTelegram(message);
  alertedPeriods.add(periodKey);

  log("INFO", "telegram_alert_sent", "BTC 5M edge alert sent", {
    periodStart: new Date(currentPeriodStart).toISOString(),
    side: edge.side,
    model: edge.model,
    clob: edge.price,
    edge: edge.edge,
    url: market.url
  });
}

async function tick() {
  if (stopping) return;

  try {
    resetPeriodIfNeeded();

    if (!periodStartPrice) {
      log("WARN", "period_start_unavailable", "Waiting for Chainlink TWAP to establish period start");
      return;
    }

    const market = await discoverMarket();
    if (!market) {
      log("WARN", "market_not_found", "Current BTC 5M Polymarket market not found", {
        slug: periodSlug(currentPeriodStart)
      });
      return;
    }

    latestMarket = market;
    const prices = await fetchMarketPrices(market);
    const probabilityUp = settlementProbabilityUp();
    const edge = bestEdge(probabilityUp, prices);

    log("INFO", "btc_5m_snapshot", "BTC 5M strategy snapshot", {
      periodStart: new Date(currentPeriodStart).toISOString(),
      periodEnd: new Date(currentPeriodStart + PERIOD_MS).toISOString(),
      marketUrl: market.url,
      chainlink: activePrice(),
      periodStartPrice,
      rtdsTwap60: latestRtds?.value ?? null,
      prices,
      probabilityUp,
      edge,
      minEdge: MIN_EDGE
    });

    await maybeAlert(market, probabilityUp, prices, edge);
  } catch (err) {
    log("ERROR", "tick_failed", "BTC 5M monitor error; monitoring continues", {
      message: err.message
    });
  }
}

function stop() {
  if (stopping) return;
  stopping = true;

  if (rtdsWs && rtdsWs.readyState === WebSocket.OPEN) rtdsWs.close();

  log("INFO", "monitor_stopped", "BTC 5M edge monitor stopped");
  process.exit(0);
}

async function start() {
  log("INFO", "monitor_started", "BTC 5M Chainlink edge monitor started", {
    runHours: RUN_MS / 3_600_000,
    pollSec: POLL_MS / 1000,
    periodMinutes: 5,
    minEdge: MIN_EDGE,
    feedId: FEED_ID
  });

  connectRtds();
  await connectChainlink();

  await new Promise(resolve => setTimeout(resolve, 5000));
  await tick();

  const timer = setInterval(tick, POLL_MS);

  setTimeout(() => {
    clearInterval(timer);
    stop();
  }, RUN_MS);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);

start();
