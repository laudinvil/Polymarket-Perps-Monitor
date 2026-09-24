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

function midFromBook(book) {
  if (Array.isArray(book)) return num(book[0]?.[0]);
  if (!book || typeof book !== "object") return null;
  if (Number.isFinite(Number(book.midpoint))) return Number(book.midpoint);

  const bids = Array.isArray(book.bids) ? book.bids : [];
  const asks = Array.isArray(book.asks) ? book.asks : [];
  const bid = bids.length ? Number(bids[0]?.[0]) : NaN;
  const ask = asks.length ? Number(asks[0]?.[0]) : NaN;

  if (Number.isFinite(bid) && Number.isFinite(ask)) return (bid + ask) / 2;
  if (Number.isFinite(bid)) return bid;
  if (Number.isFinite(ask)) return ask;
  return null;
}

function extractVenueFromBook(book, venue) {
  if (!book || typeof book !== "object") return null;

  let up = num(book.up ?? book.price_up);
  let down = num(book.down ?? book.price_down);
  if (venue === "kalshi") { up = Number.isFinite(up) ? up : midFromBook(book.yes); down = Number.isFinite(down) ? down : midFromBook(book.no); }
  else if (venue === "polymarket") { up = Number.isFinite(up) ? up : midFromBook(book.orderbook_up); down = Number.isFinite(down) ? down : midFromBook(book.orderbook_down); }
  else { up = Number.isFinite(up) ? up : midFromBook(book); }

  if (Number.isFinite(up) && !Number.isFinite(down)) down = 1 - up;
  if (Number.isFinite(down) && !Number.isFinite(up)) up = 1 - down;

  return {
    up: Number.isFinite(up) ? up : null,
    down: Number.isFinite(down) ? down : null,
    bestBid: num(book.best_bid),
    bestAsk: num(book.best_ask),
    priceToBeat: num(book.price_to_beat),
    slug: book.slug || null
  };
}

function getMarketData(data) {
  const books = data?.books || {};

  return {
    polymarket: extractVenueFromBook(books.polymarket, "polymarket"),
    kalshi: extractVenueFromBook(books.kalshi, "kalshi"),
    limitless: extractVenueFromBook(books.limitless, "limitless")
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

      console.log("DepthFeed parsed data: " + JSON.stringify({
        polymarket: market.polymarket,
        kalshi: market.kalshi,
        limitless: market.limitless
      }));
      console.log("DepthFeed response keys: " + Object.keys(data || {}).join(","));

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
