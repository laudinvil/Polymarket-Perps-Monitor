const RTDS_URL = "wss://ws-live-data.polymarket.com";
const GAMMA_URL = "https://gamma-api.polymarket.com";
const CLOB_URL = "https://clob.polymarket.com";

const RUN_MS = 5 * 60 * 60 * 1000;
const POLL_MS = 15 * 1000;
const PERIOD_MS = 5 * 60 * 1000;
const HISTORY_MAX = 240;
const MIN_EDGE = Number(process.env.BTC_5M_MIN_EDGE ?? "0.03");
const MIN_ALERT_AGE_MS = 90 * 1000;
const MIN_MODEL_PROBABILITY = 0.53;
const MIN_MOVE_BPS = 2;
const CONFIRMATION_SAMPLES = 2;
const CLOB_CONFIRMATION_TICKS = 2;

const API_KEY = process.env.CHAINLINK_DATA_STREAMS_API_KEY || "";
const USER_SECRET = process.env.CHAINLINK_DATA_STREAMS_USER_SECRET || "";
const FEED_ID =
  process.env.CHAINLINK_DATA_STREAMS_FEED_ID ||
  "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8";
const CHAINLINK_REST =
  process.env.CHAINLINK_DATA_STREAMS_REST_URL || "https://api.dataengine.chain.link";
const CHAINLINK_WS =
  process.env.CHAINLINK_DATA_STREAMS_WS_URL || "wss://ws.dataengine.chain.link";

const CONVEX_URL = process.env.CONVEX_URL || "https://brainy-canary-207.eu-west-1.convex.cloud";
const CONVEX_LOG_PATH = "btc5mState:logBtc5m";
const CONVEX_DEDUPE_PATH = "btc5mState:claimTelegramMarketV3";

let stopping = false;
let rtdsWs = null;
let latestRtds = null;
let latestChainlink = null;
let chainlinkStream = null;
let currentPeriodStart = null;
let periodStartPrice = null;
let latestMarket = null;
const priceHistory = [];
const signalHistory = [];
const alertedPeriods = new Set();

function log(level, event, message, data = undefined) {
  const payload = {
    level,
    event,
    message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) })
  };
  console.log(JSON.stringify(payload));

  void fetch(CONVEX_URL + "/api/mutation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: CONVEX_LOG_PATH,
      args: {
        level,
        event,
        message,
        ...(data === undefined ? {} : { data: JSON.stringify(data) })
      },
      format: "json"
    }),
    signal: AbortSignal.timeout(5000)
  }).catch(err => {
    console.error(JSON.stringify({
      level: "WARN",
      event: "convex_log_persist_failed",
      message: "Convex log persistence failed",
      data: JSON.stringify({ message: err.message })
    }));
  });
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
  const symbol = text(p.symbol ?? p.pair ?? p.feed);
  if (symbol && !/^btc\/usd$/i.test(symbol) && !/^btc-usd$/i.test(symbol) && !/^btcusd$/i.test(symbol)) {
    return null;
  }

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

function directionalConfirmation(side) {
  const recent = signalHistory.slice(-CONFIRMATION_SAMPLES);
  if (recent.length < CONFIRMATION_SAMPLES) return false;
  return recent.every((s) => s.side === side && s.edge >= MIN_EDGE && s.model >= MIN_MODEL_PROBABILITY);
}

function clobConfirmation(side) {
  const recent = signalHistory.slice(-CLOB_CONFIRMATION_TICKS);
  if (recent.length < CLOB_CONFIRMATION_TICKS) return false;
  return recent.every((s) => s.side === side && Number.isFinite(s.price));
}

function chainlinkMomentumBps() {
  const current = latestChainlink?.value ?? activePrice();
  if (!Number.isFinite(current) || !Number.isFinite(periodStartPrice) || periodStartPrice <= 0) return null;
  return (current / periodStartPrice - 1) * 10_000;
}

function recentChainlinkMoveBps(windowMs = 60_000) {
  if (!latestChainlink?.value || latestChainlink.value <= 0) return null;
  const cutoff = Date.now() - windowMs;
  let anchor = null;
  for (const row of priceHistory) {
    if (row.timestamp <= cutoff) anchor = row;
    else break;
  }
  if (!anchor || !anchor.value || anchor.value <= 0) return null;
  return (latestChainlink.value / anchor.value - 1) * 10_000;
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
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
  const now = Date.now();
  const start = periodStart(now);

  if (currentPeriodStart === null) {
    if (now - start > POLL_MS * 2) {
      currentPeriodStart = start + PERIOD_MS;
      periodStartPrice = null;
      log("INFO", "waiting_for_5m_boundary", "Waiting for the next exact BTC 5M boundary", {
        nextStart: new Date(currentPeriodStart).toISOString()
      });
      return false;
    }
  }

  if (currentPeriodStart !== start) {
    currentPeriodStart = start;
    periodStartPrice = activePrice();

    log("INFO", "new_5m_period", "Started new BTC 5M period", {
      start: new Date(start).toISOString(),
      end: new Date(start + PERIOD_MS).toISOString(),
      periodStartPrice
    });

    return true;
  }

  if (periodStartPrice === null && activePrice() !== null) {
    periodStartPrice = activePrice();
    log("INFO", "5m_boundary_captured", "Captured BTC 5M opening price", {
      start: new Date(start).toISOString(),
      periodStartPrice
    });
    return true;
  }

  return false;
}

function settlementProbabilityUp() {
  const price = activePrice();
  if (price === null || periodStartPrice === null || periodStartPrice <= 0) return null;

  const periodMoveBps = (price / periodStartPrice - 1) * 10_000;
  const recentMoveBps = recentChainlinkMoveBps();
  const momentumBps = recentMoveBps === null
    ? periodMoveBps
    : periodMoveBps * 0.75 + recentMoveBps * 0.25;

  // Chainlink-only directional model; no volatility warm-up is required.
  const score = momentumBps / 20;
  return clamp(0.5 + 0.20 * Math.tanh(score), 0.30, 0.70);
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
      return { market, up, down };
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

function edgeCandidates(probabilityUp, prices) {
  if (probabilityUp === null) return [];

  return [
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
}

function bestEdge(probabilityUp, prices) {
  return edgeCandidates(probabilityUp, prices)
    .filter(x => Number.isFinite(x.edge) && Number.isFinite(x.price))
    .sort((a, b) => b.edge - a.edge)[0] || null;
}

async function claimAlertUrl(url) {
  const response = await fetch(CONVEX_URL + "/api/mutation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: CONVEX_DEDUPE_PATH,
      args: { marketSlug: url },
      format: "json"
    }),
    signal: AbortSignal.timeout(5000)
  });

  if (!response.ok) {
    throw new Error("Convex dedupe HTTP " + response.status);
  }

  const body = await response.json();
  const allowed = body?.value?.allowed ?? body?.result?.allowed;
  if (typeof allowed !== "boolean") {
    throw new Error("Convex dedupe returned invalid response");
  }

  return allowed;
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
  const ageMs = Date.now() - market.startMs;
  if (ageMs < MIN_ALERT_AGE_MS) {
    log("INFO", "alert_too_early", "Skipping BTC 5M alert during the first minute of the period", {
      start: new Date(market.startMs).toISOString(),
      ageMs,
      minAlertAgeMs: MIN_ALERT_AGE_MS
    });
    return;
  }

  if (!edge || edge.edge < MIN_EDGE) return;
  const moveBps = chainlinkMomentumBps();
  if (edge.model < MIN_MODEL_PROBABILITY) return;
  if (moveBps === null || Math.abs(moveBps) < MIN_MOVE_BPS) return;

  signalHistory.push({
    side: edge.side,
    model: edge.model,
    edge: edge.edge,
    price: edge.price,
    at: Date.now()
  });
  if (signalHistory.length > 20) signalHistory.shift();

  if (!directionalConfirmation(edge.side)) {
    log("INFO", "confirmation_pending", "Waiting for three consecutive model/edge confirmations", { side: edge.side });
    return;
  }
  if (!clobConfirmation(edge.side)) {
    log("INFO", "clob_confirmation_pending", "Waiting for two consecutive CLOB observations", { side: edge.side });
    return;
  }

  const alertUrl = market.url;

  if (alertedPeriods.has(alertUrl)) {
    log("INFO", "duplicate_alert_blocked", "Duplicate alert blocked by identical URL", {
      url: alertUrl,
      reason: "local_url_dedupe"
    });
    return;
  }

  const allowed = await claimAlertUrl(alertUrl);
  if (!allowed) {
    log("INFO", "duplicate_alert_blocked", "Duplicate alert blocked by identical URL", {
      url: alertUrl,
      reason: "convex_url_dedupe"
    });
    alertedPeriods.add(alertUrl);
    return;
  }

  const comparison = dataDelta();
  const moveBps = chainlinkMomentumBps();
  const rtdsValue = latestRtds?.value ?? null;
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
    "MOVE: " + (moveBps === null ? "N/A" : (moveBps >= 0 ? "+" : "") + moveBps.toFixed(1) + " bps"),
    "RTDS TWAP60: " + (rtdsValue === null ? "N/A" : "$" + rtdsValue.toFixed(2)),
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
  alertedPeriods.add(alertUrl);

  log("INFO", "telegram_alert_sent", "BTC 5M edge alert sent", {
    periodStart: new Date(currentPeriodStart).toISOString(),
    side: edge.side,
    model: edge.model,
    clob: edge.price,
    edge: edge.edge,
    url: market.url,
    moveBps,
    rtdsAvailable: rtdsValue !== null,
    dsRtdsDeltaBps: comparison?.deltaBps ?? null
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
      modelUp: probabilityUp,
      modelDown: probabilityUp === null ? null : 1 - probabilityUp,
      edgeUp: edgeCandidates(probabilityUp, prices).find(x => x.side === "UP")?.edge ?? null,
      edgeDown: edgeCandidates(probabilityUp, prices).find(x => x.side === "DOWN")?.edge ?? null,
      selectedEdge: edge?.edge ?? null,
      selectedSide: edge?.side ?? null,
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
