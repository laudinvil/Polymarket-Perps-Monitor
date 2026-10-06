const CONFIG = require("./config");

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }
  return response.json();
}

function normalizeMarket(market, event, category) {
  const conditionId = market?.conditionId || market?.condition_id || market?.condition;
  if (!conditionId) return null;

  return {
    eventId: String(event?.id ?? market?.eventId ?? ""),
    category,
    title: market?.question || market?.title || event?.title || "",
    slug: market?.slug || event?.slug || "",
    status: market?.closed || market?.active === false ? "CLOSED" : "ACTIVE",
    lastSeen: Math.floor(Date.now() / 1000),
    resolved: Boolean(market?.resolved || event?.resolved),
  };
}

async function discoverCategory(category, tagSlug, limit) {
  const markets = {};

  const payload = await fetchJson(
    `${CONFIG.gamma.baseUrl}/events?active=true&closed=false&tag_slug=${encodeURIComponent(tagSlug)}&limit=100&offset=0`
  );

  const events = Array.isArray(payload)
    ? payload
    : (payload?.data || payload?.events || []);

  for (const event of events) {
    const eventMarkets = Array.isArray(event?.markets) ? event.markets : [];

    for (const market of eventMarkets) {
      const normalized = normalizeMarket(market, event, category);
      if (!normalized) continue;
      markets[market.conditionId || market.condition_id || market.condition] = normalized;

      if (Object.keys(markets).length >= limit) break;
    }

    if (Object.keys(markets).length >= limit) break;
  }

  return Object.entries(markets).slice(0, limit);
}

async function discoverMarkets() {
  const [sports, esports] = await Promise.all([
    discoverCategory("SPORTS", "sports", CONFIG.discovery.sportsLimit),
    discoverCategory("ESPORTS", "esports", CONFIG.discovery.esportsLimit),
  ]);

  return {
    markets: Object.fromEntries([...sports, ...esports]),
    counts: {
      SPORTS: sports.length,
      ESPORTS: esports.length,
    },
  };
}

module.exports = { discoverMarkets };
