const crypto = require("crypto");

function predictionId(trade) {
  return crypto
    .createHash("sha256")
    .update(`${trade.wallet}:${trade.conditionId}:${trade.outcome}`)
    .digest("hex");
}

function getPrediction(state, trade) {
  const id = predictionId(trade);
  if (!state.predictions[id]) {
    state.predictions[id] = {
      predictionId: id,
      wallet: trade.wallet,
      conditionId: trade.conditionId,
      category: state.markets[trade.conditionId]?.category || null,
      outcome: trade.outcome,
      shares: 0,
      cost: 0,
      entryProbability: null,
      firstTradeAt: trade.timestamp,
      lastTradeAt: trade.timestamp,
      status: "ACTIVE",
      resolved: false,
      result: null,
      hedged: false,
      eloApplied: false,
    };
  }
  return state.predictions[id];
}

function aggregateTrade(state, trade) {
  const prediction = getPrediction(state, trade);
  prediction.lastTradeAt = Math.max(prediction.lastTradeAt || 0, trade.timestamp || 0);

  if (trade.side === "BUY") {
    prediction.shares += trade.size;
    prediction.cost += trade.size * trade.price;
  } else {
    const sellSize = Math.min(trade.size, prediction.shares);
    if (sellSize > 0 && prediction.shares > 0) {
      const averageCost = prediction.cost / prediction.shares;
      prediction.shares -= sellSize;
      prediction.cost -= averageCost * sellSize;
    }
  }

  if (prediction.shares >= 1) {
    prediction.status = "ACTIVE";
    prediction.entryProbability = prediction.cost / prediction.shares;
  } else {
    prediction.shares = 0;
    prediction.cost = 0;
    prediction.entryProbability = null;
    prediction.status = "EXITED";
  }

  return prediction;
}

function aggregatePending(state) {
  const trades = state._newTrades || [];
  const byId = new Set();

  for (const trade of trades) {
    if (byId.has(trade.tradeId)) continue;
    byId.add(trade.tradeId);
    aggregateTrade(state, trade);
  }

  delete state._newTrades;
}

module.exports = { aggregatePending, aggregateTrade, predictionId };
