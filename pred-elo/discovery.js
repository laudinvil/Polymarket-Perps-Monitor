const CONFIG = require("./config");

function normalizeCategory(value) {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "SPORTS" || raw === "SPORT") return "SPORTS";
  if (raw === "ESPORTS" || raw === "ESPORT" || raw === "E-SPORTS") return "ESPORTS";
  return null;
}

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

function categoryFromObject(obj) {
  const candidates = [
    obj?.category,
    obj?.sportsCategory,
    obj?.sportCategory,
    obj?.tags?.find?.((t) => normalizeCategory(t?.label || t?.name || t?.slug))?.label,
  ];
  for (const candidate of candidates) {
    const category = normalizeCategory(candidate);
    if (category) return category;
  }
  return null;
}

async function discoverMarkets() {
  const markets = {};

  // Gamma schemas can evolve. Prefer metadata fields/tags; never classify by title keywords.
  const payload = await fetchJson(
    `${CONFIG.gamma.baseUrl}/events?active=true&closed=false&limit=100`
  );

  const events = Array.isArray(payload) ? payload : (payload?.data || payload?.events || []);

  for (const event of events) {
    const category = categoryFromObject(event);
    if (!category) continue;

    const eventMarkets = Array.isArray(event.markets) ? event.markets : [];
    for (const market of eventMarkets) {
      const conditionId = market?.conditionId || market?.condition_id;
      if (!conditionId) continue;

      markets[conditionId] = {
        eventId: String(event.id ?? market.eventId ?? ""),
        category,
        title: market.question || market.title || event.title || "",
        slug: market.slug || event.slug || "",
        status: market.closed ? "CLOSED" : (market.active === false ? "CLOSED" : "ACTIVE"),
        lastSeen: Math.floor(Date.now() / 1000),
        resolved: false,
      };
    }
  }

  const byCategory = {
    SPORTS: Object.values(markets).filter((m) => m.category === "SPORTS").slice(0, CONFIG.discovery.sportsLimit),
    ESPORTS: Object.values(markets).filter((m) => m.category === "ESPORTS").slice(0, CONFIG.discovery.esportsLimit),
  };

  return {
    markets: Object.fromEntries(
      [...byCategory.SPORTS, ...byCategory.ESPORTS].map((m) => [
        Object.keys(markets).find((id) => markets[id] === m),
        m,
      ])
    ),
    counts: {
      SPORTS: byCategory.SPORTS.length,
      ESPORTS: byCategory.ESPORTS.length,
    },
  };
}

module.exports = { discoverMarkets, normalizeCategory };
