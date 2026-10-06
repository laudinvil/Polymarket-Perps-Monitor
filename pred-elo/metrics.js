function buildMetrics(state, previous = {}) {
  const predictions = Object.values(state.predictions);
  const active = predictions.filter((p) => p.status === "ACTIVE").length;
  const exited = predictions.filter((p) => p.status === "EXITED").length;
  const hedged = predictions.filter((p) => p.hedged).length;

  return {
    ...previous,
    markets: Object.keys(state.markets).length,
    sportsMarkets: Object.values(state.markets).filter((m) => m.category === "SPORTS").length,
    esportsMarkets: Object.values(state.markets).filter((m) => m.category === "ESPORTS").length,
    activePredictions: active,
    exitedPredictions: exited,
    hedgedPredictions: hedged,
    seenTrades: state.seenTrades.length,
    updatedAt: Date.now(),
  };
}

module.exports = { buildMetrics };
