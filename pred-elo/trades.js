const CONFIG = require("./config");

function chunk(values, size) {
  const result = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

function batchKey(conditions) {
  return conditions.join(",");
}

async function fetchTrades(conditions, cursor) {
  const params = new URLSearchParams();
  params.set("limit", String(CONFIG.collector.pageSize));
  params.set("condition", conditions.join(","));
  if (cursor) params.set("cursor", cursor);

  const response = await fetch(`${CONFIG.dataApi.baseUrl}/v2/trades?${params}`);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }

  return response.json();
}

function tradeIdentity(raw, index) {
  const direct = raw?.id ?? raw?.tradeId ?? raw?.trade_id;
  if (direct) return String(direct);

  const tx = raw?.transactionHash ?? raw?.transaction_hash ?? raw?.transaction;
  const condition = raw?.conditionId ?? raw?.condition_id ?? raw?.condition;
  const asset = raw?.asset ?? raw?.tokenId ?? raw?.token_id;
  const timestamp = raw?.timestamp ?? 0;
  const side = raw?.side ?? "";
  const size = raw?.size ?? "";
  const price = raw?.price ?? "";

  if (!tx && !condition) return null;

  return [
    tx || "no-tx",
    condition || "no-condition",
    asset || "no-asset",
    timestamp,
    side,
    size,
    price,
    index,
  ].join(":");
}

function normalizeTrade(raw, index) {
  const tradeId = tradeIdentity(raw, index);
  const conditionId = raw?.conditionId ?? raw?.condition_id ?? raw?.condition;
  const wallet = raw?.proxyWallet ?? raw?.proxy_wallet ?? raw?.wallet ?? raw?.user;
  const tokenId = raw?.asset ?? raw?.tokenId ?? raw?.token_id;
  const outcome = raw?.outcome ?? raw?.outcomeName;
  const side = String(raw?.side || "").toUpperCase();
  const price = Number(raw?.price);
  const size = Number(raw?.size);
  const timestamp = Number(raw?.timestamp ?? raw?.createdAt ?? 0);

  if (!tradeId || !conditionId || !wallet || !tokenId || !outcome) return null;
  if (!["BUY", "SELL"].includes(side)) return null;
  if (!Number.isFinite(price) || !Number.isFinite(size) || size <= 0) return null;
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  return {
    tradeId,
    wallet: String(wallet),
    conditionId: String(conditionId),
    tokenId: String(tokenId),
    outcome: String(outcome),
    side,
    price,
    size,
    timestamp,
  };
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  return payload?.data || payload?.trades || [];
}

function extractNextCursor(payload) {
  return (
    payload?.next_cursor ??
    payload?.nextCursor ??
    payload?.pagination?.next_cursor ??
    payload?.pagination?.nextCursor ??
    null
  );
}

async function syncTrades(state, metrics) {
  const conditionIds = Object.keys(state.markets).filter((id) =>
    state.markets[id]?.category === "SPORTS" || state.markets[id]?.category === "ESPORTS"
  );

  const batches = chunk(conditionIds, CONFIG.collector.maxConditionsPerBatch);
  const seen = new Set(state.seenTrades);
  let newTrades = 0;
  let duplicates = 0;
  let pages = 0;

  for (const conditions of batches) {
    const key = batchKey(conditions);
    const batchState = state.cursors.batches[key] || { conditions, cursor: null };
    let cursor = batchState.cursor;

    for (let page = 0; page < CONFIG.collector.maxPagesPerBatch; page += 1) {
      let payload;
      try {
        payload = await fetchTrades(conditions, cursor);
        metrics.apiRequests += 1;
      } catch (error) {
        metrics.apiRequests += 1;
        metrics.apiErrors += 1;
        if (error.status === 429 || error.status === 503) metrics[error.status] += 1;
        break;
      }

      const rows = extractRows(payload);
      const normalized = rows.map((row, index) => normalizeTrade(row, index)).filter(Boolean);

      for (const trade of normalized) {
        if (seen.has(trade.tradeId)) {
          duplicates += 1;
          continue;
        }
        seen.add(trade.tradeId);
        newTrades += 1;
        state._newTrades.push(trade);
      }

      pages += 1;

      const nextCursor = extractNextCursor(payload);
      if (!nextCursor || rows.length === 0) {
        cursor = nextCursor;
        break;
      }
      cursor = nextCursor;
    }

    state.cursors.batches[key] = { conditions, cursor };
  }

  state.seenTrades = Array.from(seen).slice(-CONFIG.collector.seenTradesLimit);

  metrics.newTrades = newTrades;
  metrics.duplicates = duplicates;
  metrics.pages = pages;
}

module.exports = { syncTrades, normalizeTrade, extractRows, extractNextCursor };
