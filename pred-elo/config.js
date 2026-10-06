const CONFIG = {
  gamma: {
    baseUrl: "https://gamma-api.polymarket.com",
    discoveryIntervalMs: 10 * 60 * 1000,
  },
  dataApi: {
    baseUrl: "https://data-api.polymarket.com",
    tradeSyncIntervalMs: 15 * 1000,
  },
  discovery: {
    sportsLimit: 20,
    esportsLimit: 20,
  },
  collector: {
    pageSize: 500,
    maxPagesPerBatch: 5,
    maxConditionsPerBatch: 20,
    seenTradesLimit: 50_000,
  },
  metrics: {
    intervalMs: 60 * 1000,
  },
  elo: {
    enabled: false,
    startRating: 1500,
    baseK: 40,
    maxDelta: 40,
    epsilon: 0.01,
    maxSurprise: 4,
    minResolved: 20,
  },
};

module.exports = CONFIG;
