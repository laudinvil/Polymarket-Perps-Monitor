const RTDS_URL = "wss://ws-live-data.polymarket.com";
const RUN_MS = 5 * 60 * 60 * 1000;
const POLL_MS = 15 * 1000;

const API_KEY = process.env.CHAINLINK_DATA_STREAMS_API_KEY || "";
const USER_SECRET = process.env.CHAINLINK_DATA_STREAMS_USER_SECRET || "";
const FEED_ID = process.env.CHAINLINK_DATA_STREAMS_FEED_ID || "0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8";
const CHAINLINK_REST = process.env.CHAINLINK_DATA_STREAMS_REST_URL || "https://api.dataengine.chain.link";
const CHAINLINK_WS = process.env.CHAINLINK_DATA_STREAMS_WS_URL || "wss://ws.dataengine.chain.link";

let latestRtds = null;
let latestChainlink = null;
let rtdsWs = null;
let stopping = false;

function log(level, event, message, data = undefined) {
  console.log(JSON.stringify({
    level,
    event,
    message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) })
  }));
}

function numeric(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function extractRtds(message) {
  if (!message || message.topic !== "crypto_prices_twap_sixty") return null;
  const p = message.payload || {};
  const value = numeric(p.value ?? p.price ?? p.twap ?? p.twapPrice);
  if (value === null) return null;
  return {
    value,
    symbol: p.symbol ?? null,
    timestamp: numeric(p.timestamp ?? p.ts ?? message.timestamp),
    receivedAt: Date.now(),
    raw: p
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
      const message = JSON.parse(String(event.data));
      const row = extractRtds(message);
      if (!row) return;
      latestRtds = row;
      log("INFO", "rtds_twap60", "Polymarket RTDS Chainlink TWAP 60s update", row);
    } catch (err) {
      log("WARN", "rtds_parse_failed", "Could not parse RTDS message", { message: err.message });
    }
  });

  rtdsWs.addEventListener("error", err => {
    log("WARN", "rtds_error", "Polymarket RTDS WebSocket error", { message: String(err?.message || err) });
  });

  rtdsWs.addEventListener("close", () => {
    if (!stopping) {
      log("WARN", "rtds_closed", "Polymarket RTDS WebSocket closed; reconnecting");
      setTimeout(connectRtds, 1000);
    }
  });
}

async function connectChainlink() {
  if (!API_KEY || !USER_SECRET) {
    log("WARN", "chainlink_credentials_missing",
      "Chainlink Data Streams comparison is disabled until API key and user secret are configured", {
        apiKey: Boolean(API_KEY),
        userSecret: Boolean(USER_SECRET),
        feedId: FEED_ID,
        rest: CHAINLINK_REST,
        websocket: CHAINLINK_WS
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

    const stream = client.createStream([FEED_ID]);

    stream.on("report", report => {
      try {
        const decoded = decodeReport(report.fullReport, report.feedID);
        const priceRaw = decoded?.benchmarkPrice ?? decoded?.price;
        const price = numeric(priceRaw) === null ? null : Number(priceRaw) / 1e18;
        if (price === null) throw new Error("Decoded report has no benchmark price");

        latestChainlink = {
          value: price,
          timestamp: numeric(report.observationsTimestamp),
          validFrom: numeric(report.validFromTimestamp),
          feedId: report.feedID,
          receivedAt: Date.now()
        };

        log("INFO", "chainlink_twap", "Chainlink Data Streams update", latestChainlink);
      } catch (err) {
        log("WARN", "chainlink_decode_failed", "Could not decode Chainlink Data Streams report", { message: err.message });
      }
    });

    stream.on("error", err => {
      log("WARN", "chainlink_stream_error", "Chainlink Data Streams error", {
        message: String(err?.message || err)
      });
    });

    await stream.connect();
    log("INFO", "chainlink_connected", "Connected to Chainlink Data Streams", { feedId: FEED_ID });
  } catch (err) {
    log("WARN", "chainlink_connect_failed", "Could not connect to Chainlink Data Streams", {
      message: err.message
    });
  }
}

function compare() {
  if (!latestRtds || !latestChainlink) return;

  const delta = latestRtds.value - latestChainlink.value;
  log("INFO", "twap_comparison", "Chainlink Data Streams vs Polymarket RTDS TWAP60", {
    rtdsTwap60: latestRtds.value,
    chainlinkDataStreams: latestChainlink.value,
    deltaUsd: delta,
    deltaBps: latestChainlink.value ? delta / latestChainlink.value * 10000 : null,
    rtdsTimestamp: latestRtds.timestamp,
    chainlinkTimestamp: latestChainlink.timestamp,
    ageRtdsMs: Date.now() - latestRtds.receivedAt,
    ageChainlinkMs: Date.now() - latestChainlink.receivedAt
  });
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (rtdsWs && rtdsWs.readyState === WebSocket.OPEN) rtdsWs.close();
  log("INFO", "monitor_stopped", "TWAP diagnostic stopped");
  process.exit(0);
}

async function start() {
  log("INFO", "monitor_started", "Continuous BTC Chainlink TWAP comparison started", {
    runHours: RUN_MS / 3600000,
    compareEverySec: POLL_MS / 1000,
    rtdsTopic: "crypto_prices_twap_sixty",
    chainlinkFeed: FEED_ID
  });

  connectRtds();
  await connectChainlink();

  const timer = setInterval(compare, POLL_MS);
  setTimeout(() => {
    clearInterval(timer);
    stop();
  }, RUN_MS);
}

process.on("SIGTERM", stop);
process.on("SIGINT", stop);
start();
