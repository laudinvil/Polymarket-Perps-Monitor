const CONFIG = require("./config");
const { loadState, saveState } = require("./storage");
const { discoverMarkets } = require("./discovery");
const { syncTrades } = require("./trades");
const { aggregatePending } = require("./aggregator");
const { buildMetrics } = require("./metrics");

const state = loadState();

let running = false;
let lastDiscovery = 0;

async function discoveryCycle() {
  const result = await discoverMarkets();
  state.markets = { ...state.markets, ...result.markets };
  lastDiscovery = Date.now();
  console.log(
    `[PRED-ELO] DISCOVERY SPORTS=${result.counts.SPORTS} ESPORTS=${result.counts.ESPORTS} TOTAL=${Object.keys(state.markets).length}`
  );
  saveState(state);
}

async function tradeCycle() {
  if (!Object.keys(state.markets).length) return;
  state._newTrades = [];
  const metrics = {
    apiRequests: 0,
    apiErrors: 0,
    429: 0,
    503: 0,
    newTrades: 0,
    duplicates: 0,
    pages: 0,
  };

  await syncTrades(state, metrics);
  aggregatePending(state);

  state.metrics = buildMetrics(state, {
    ...state.metrics,
    ...metrics,
  });

  saveState(state);

  console.log(
    `[PRED-ELO] TRADES new=${metrics.newTrades} dup=${metrics.duplicates} pages=${metrics.pages} activePredictions=${state.metrics.activePredictions}`
  );
}

async function cycle() {
  if (running) return;
  running = true;
  try {
    if (!lastDiscovery || Date.now() - lastDiscovery >= CONFIG.gamma.discoveryIntervalMs) {
      try {
        await discoveryCycle();
      } catch (error) {
        console.error(`[PRED-ELO] DISCOVERY_ERROR ${error.message}`);
      }
    }
    await tradeCycle();
  } finally {
    running = false;
  }
}

console.log("[PRED-ELO] START ELO_ENABLED=false");
cycle();
setInterval(cycle, CONFIG.dataApi.tradeSyncIntervalMs);
