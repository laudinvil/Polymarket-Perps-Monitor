const POLL_MS = 1100;
const TRIGGER_PP = Number(process.env.DIVERGENCE_TRIGGER_PP || 4);
const RESET_PP = Number(process.env.DIVERGENCE_RESET_PP || 2);
const CONSENSUS_MAX_PP = Number(process.env.CONSENSUS_MAX_PP || 2);

const DEPTHFEED_URL = "https://api.depthfeed.com/v3/screener/btc/5m";
const POLY_URL = "https://polymarket.com/event/btc-updown-5m-";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function telegramRequest(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8000)
  });

  const body = await res.text();
  if (!res.ok) throw new Error("Telegram HTTP " + res.status + ": " + body);

  const json = JSON.parse(body);
  if (!json.ok) throw new Error("Telegram API error: " + body);
  return json.result;
}

async function sendTelegram(text) {
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) throw new Error("Missing TELEGRAM_CHAT_ID");

  await telegramRequest("sendMessage", {
    chat_id: chatId,
    text,
    disable_web_page_preview: false
  });
}

async function fetchScreener() {
  const key = process.env.DEPTHFEED_API_KEY;
  if (!key) throw new Error("Missing DEPTHFEED_API_KEY");

  const res = await fetch(DEPTHFEED_URL, {
    headers: {
      "Authorization": "Bearer " + key,
      "Accept": "application/json",
      "User-Agent": "polymarket-cross-venue-monitor/1.0"
    },
    signal: AbortSignal.timeout(8000)
  });

  const body = await res.text();

  if (res.status === 429) {
    const retry = Number(res.headers.get("retry-after") || 1);
    console.error("DepthFeed rate limited; retrying in " + retry + "s");
    await sleep(Math.max(1000, retry * 1000));
    return null;
  }

  if (!res.ok) throw new Error("DepthFeed HTTP " + res.status + ": " + body);

  const json = JSON.parse(body);
  if (json.error) {
    throw new Error(
      "DepthFeed " + (json.error.code || "ERROR") + ": " +
      (json.error.message || JSON.stringify(json.error))
    );
  }

  return json.data;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractVenue(data, name) {
  const v = data && data[name];
  if (!v || typeof v !== "object") return null;

  const up = num(v.up);
  const down = num(v.down);

  return {
    up,
    down,
    bestBid: num(v.best_bid),
    bestAsk: num(v.best_ask),
    priceToBeat: num(v.price_to_beat),
    slug: v.slug || null
  };
}

function getMarketData(data) {
  // The documented /v3/screener/btc/5m response exposes the three
  // venues under data.{polymarket,kalshi,limitless}.
  const polymarket = extractVenue(data, "polymarket");
  const kalshi = extractVenue(data, "kalshi");
  const limitless = extractVenue(data, "limitless");

  if (!polymarket || !kalshi || !limitless) return null;
  if (![polymarket.up, kalshi.up, limitless.up].every(Number.isFinite)) return null;

  return { polymarket, kalshi, limitless };
}

function pp(a, b) {
  return Math.abs(a - b) * 100;
}

function average(a, b) {
  return (a + b) / 2;
}

function periodStartSec() {
  return Math.floor(Date.now() / 1000 / 300) * 300;
}

function marketUrl(data) {
  const slug =
    data.polymarket.slug ||
    data.limitless.slug;

  if (slug && slug.startsWith("btc-updown-5m-")) {
    return POLY_URL + slug.split("btc-updown-5m-")[1];
  }

  return POLY_URL + periodStartSec();
}

function buildAlert(market, side, externalAverage, divergence) {
  const p = market.polymarket[side];
  const k = market.kalshi[side];
  const l = market.limitless[side];

  const relation =
    p < externalAverage
      ? "POLYMARKET BELOW EXTERNAL"
      : "POLYMARKET ABOVE EXTERNAL";

  return [
    "🔥 BTC · 5M · CROSS-VENUE",
    "",
    "POLYMARKET " + side + ": " + p.toFixed(4),
    "KALSHI " + side + ": " + k.toFixed(4),
    "LIMITLESS " + side + ": " + l.toFixed(4),
    "",
    "EXTERNAL AVG: " + externalAverage.toFixed(4),
    "DIVERGENCE: " + divergence.toFixed(2) + " pp",
    "SIGNAL: " + relation,
    "",
    "➡️ Polymarket 5M",
    marketUrl(market)
  ].join("\n");
}

function analyze(market) {
  // Require Kalshi and Limitless to agree reasonably closely.
  // Then compare Polymarket against their average.
  const externalUpSpread = pp(market.kalshi.up, market.limitless.up);

  if (externalUpSpread > CONSENSUS_MAX_PP) {
    return {
      triggered: false,
      reason: "external venues disagree by " + externalUpSpread.toFixed(2) + " pp"
    };
  }

  const externalUp = average(market.kalshi.up, market.limitless.up);
  const divergenceUp = (market.polymarket.up - externalUp) * 100;

  // DOWN is mathematically the inverse of UP, so the same divergence
  // magnitude is used. A positive UP divergence means Polymarket prices
  // UP higher; the equivalent DOWN divergence is negative.
  const absDivergence = Math.abs(divergenceUp);

  if (absDivergence < TRIGGER_PP) {
    return {
      triggered: false,
      divergence: absDivergence,
      externalUp,
      reason: "below trigger"
    };
  }

  const side = divergenceUp >= 0 ? "UP" : "DOWN";

  // The external average for DOWN is simply 1 - external UP.
  const externalSide =
    side === "UP" ? externalUp : 1 - externalUp;

  const sideDivergence = Math.abs(
    (side === "UP" ? market.polymarket.up : market.polymarket.down) -
    externalSide
  ) * 100;

  return {
    triggered: sideDivergence >= TRIGGER_PP,
    side,
    divergence: sideDivergence,
    externalAverage: externalSide,
    externalUp,
    externalUpSpread,
    reason: "trigger"
  };
}

async function main() {
  console.log("BTC 5M cross-venue divergence monitor started");
  console.log("Endpoint: " + DEPTHFEED_URL);
  console.log(
    "Trigger=" + TRIGGER_PP +
    "pp reset=" + RESET_PP +
    "pp external-consensus-max=" + CONSENSUS_MAX_PP + "pp"
  );

  let alertedForPeriod = false;
  let armed = true;
  let lastPeriod = periodStartSec();

  while (true) {
    try {
      const currentPeriod = periodStartSec();

      if (currentPeriod !== lastPeriod) {
        lastPeriod = currentPeriod;
        alertedForPeriod = false;
        armed = true;
        console.log("New BTC 5M period: " + currentPeriod);
      }

      const data = await fetchScreener();

      if (!data) {
        await sleep(POLL_MS);
        continue;
      }

      const market = getMarketData(data);

      if (!market) {
        console.log("Screener returned incomplete venue data; skipping");
        await sleep(POLL_MS);
        continue;
      }

      const result = analyze(market);

      console.log(
        "BTC 5M UP " +
        market.polymarket.up.toFixed(4) + "/" +
        market.kalshi.up.toFixed(4) + "/" +
        market.limitless.up.toFixed(4) +
        " divergence=" +
        (result.divergence != null ? result.divergence.toFixed(2) + "pp" : "n/a")
      );

      if (!armed && result.divergence != null && result.divergence <= RESET_PP) {
        armed = true;
        console.log("Signal reset; monitor re-armed");
      }

      if (
        armed &&
        !alertedForPeriod &&
        result.triggered &&
        result.side &&
        result.divergence >= TRIGGER_PP
      ) {
        await sendTelegram(buildAlert(
          market,
          result.side,
          result.externalAverage,
          result.divergence
        ));

        alertedForPeriod = true;
        armed = false;

        console.log(
          "ALERT sent side=" + result.side +
          " divergence=" + result.divergence.toFixed(2) + "pp"
        );
      }
    } catch (err) {
      // A bad/temporary DepthFeed response must never kill the monitor.
      console.error("Monitor error: " + err.message);
      console.log("Keeping monitor alive; retrying in 5s");
      await sleep(5000);
      continue;
    }

    await sleep(POLL_MS);
  }
}

main().catch(err => {
  console.error("Fatal startup error: " + err.stack);
  process.exit(1);
});
