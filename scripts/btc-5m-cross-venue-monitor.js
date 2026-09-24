const POLL_MS = 1100;

const DEPTHFEED_URL = "https://api.depthfeed.com/v3/screener/btc/5m";
const POLY_URL = "https://polymarket.com/event/btc-updown-5m-";

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function telegramRequest(method, payload) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
  const res = await fetch("https://api.telegram.org/bot" + token + "/" + method, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(8000)
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
  await telegramRequest("sendMessage", { chat_id: chatId, text, disable_web_page_preview: false });
}

async function fetchScreener() {
  const key = process.env.DEPTHFEED_API_KEY;
  if (!key) throw new Error("Missing DEPTHFEED_API_KEY");
  const res = await fetch(DEPTHFEED_URL, {
    headers: { "Authorization": "Bearer " + key, "Accept": "application/json", "User-Agent": "polymarket-cross-venue-monitor/1.0" },
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
  if (json.error) throw new Error("DepthFeed " + (json.error.code || "ERROR") + ": " + (json.error.message || JSON.stringify(json.error)));
  return json.data;
}

function num(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }

function extractVenue(data, name) {
  const v = data && data[name];
  if (!v || typeof v !== "object") return null;
  return {
    up: num(v.up), down: num(v.down), bestBid: num(v.best_bid), bestAsk: num(v.best_ask),
    priceToBeat: num(v.price_to_beat), slug: v.slug || null
  };
}

function getMarketData(data) {
  return {
    polymarket: extractVenue(data, "polymarket"),
    kalshi: extractVenue(data, "kalshi"),
    limitless: extractVenue(data, "limitless")
  };
}

function pp(a, b) { return Math.abs(a - b) * 100; }
function periodStartSec() { return Math.floor(Date.now() / 1000 / 300) * 300; }

function marketUrl(data) {
  const slug = data.polymarket?.slug || data.limitless?.slug;
  if (slug && slug.startsWith("btc-updown-5m-")) return POLY_URL + slug.split("btc-updown-5m-")[1];
  return POLY_URL + periodStartSec();
}

function fmt(value) {
  return Number.isFinite(value) ? value.toFixed(4) : "n/a";
}

function buildDataAlert(market) {
  const lines = [
    "📡 BTC · 5M · DATA",
    "",
    "POLYMARKET UP: " + fmt(market.polymarket?.up),
    "POLYMARKET DOWN: " + fmt(market.polymarket?.down),
    "KALSHI UP: " + fmt(market.kalshi?.up),
    "KALSHI DOWN: " + fmt(market.kalshi?.down),
    "LIMITLESS UP: " + fmt(market.limitless?.up),
    "LIMITLESS DOWN: " + fmt(market.limitless?.down),
    ""
  ];

  if (Number.isFinite(market.kalshi?.up) && Number.isFinite(market.limitless?.up) && Number.isFinite(market.polymarket?.up)) {
    const externalUp = (market.kalshi.up + market.limitless.up) / 2;
    lines.push("EXTERNAL AVG UP: " + fmt(externalUp));
    lines.push("KALSHI ↔ LIMITLESS: " + pp(market.kalshi.up, market.limitless.up).toFixed(2) + " pp");
    lines.push("POLYMARKET ↔ AVG: " + pp(market.polymarket.up, externalUp).toFixed(2) + " pp");
  } else {
    lines.push("VENUE DATA: incomplete");
  }

  lines.push("", "➡️ Polymarket 5M", marketUrl(market));
  return lines.join("\n");
}

async function main() {
  console.log("BTC 5M cross-venue DATA monitor started");
  console.log("Endpoint: " + DEPTHFEED_URL);
  console.log("FILTERS: DISABLED");

  let lastPeriod = periodStartSec();
  let sentForPeriod = false;

  while (true) {
    try {
      const currentPeriod = periodStartSec();
      if (currentPeriod !== lastPeriod) {
        lastPeriod = currentPeriod;
        sentForPeriod = false;
        console.log("New BTC 5M period: " + currentPeriod);
      }

      const data = await fetchScreener();
      if (!data) { await sleep(POLL_MS); continue; }

      const market = getMarketData(data);

      console.log("DepthFeed data: " + JSON.stringify({
        polymarket: market.polymarket,
        kalshi: market.kalshi,
        limitless: market.limitless
      }));

      if (!sentForPeriod) {
        await sendTelegram(buildDataAlert(market));
        sentForPeriod = true;
        console.log("DATA ALERT sent");
      }
    } catch (err) {
      console.error("Monitor error: " + err.message);
      console.log("Keeping monitor alive; retrying in 5s");
      await sleep(5000);
      continue;
    }
    await sleep(POLL_MS);
  }
}

main().catch(err => { console.error("Fatal startup error: " + err.stack); process.exit(1); });
