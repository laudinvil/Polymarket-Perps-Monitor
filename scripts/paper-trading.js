const PAPER_TRADE_USD = 1;

const openPositions = new Map();
let nextPositionId = 1;

function openPaperBuy({ iid, symbol, price, signalSide, alertTime = Date.now() }) {
  if (!Number.isFinite(price) || price <= 0) return null;
  const quantity = PAPER_TRADE_USD / price;
  const id = `P${String(nextPositionId++).padStart(5, '0')}`;
  const position = {
    id,
    iid,
    symbol,
    side: 'LONG',
    action: 'BUY',
    signalSide,
    investedUsd: PAPER_TRADE_USD,
    entryPrice: price,
    quantity,
    markPrice: price,
    openedAt: alertTime,
  };
  openPositions.set(id, position);
  return position;
}

function updateMark(iid, price) {
  if (!Number.isInteger(iid) || !Number.isFinite(price) || price <= 0) return [];
  const updated = [];
  for (const position of openPositions.values()) {
    if (position.iid !== iid) continue;
    position.markPrice = price;
    updated.push(position);
  }
  return updated;
}

function unrealizedPnl(position) {
  return (position.markPrice - position.entryPrice) * position.quantity;
}

function snapshot() {
  const positions = Array.from(openPositions.values()).map(position => ({
    ...position,
    unrealizedPnl: unrealizedPnl(position),
    markValueUsd: position.quantity * position.markPrice,
    returnPct: ((position.markPrice - position.entryPrice) / position.entryPrice) * 100,
  }));
  const totalInvested = positions.reduce((sum, p) => sum + p.investedUsd, 0);
  const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  return { positions, totalInvested, totalPnl };
}

function formatUsd(value) {
  const sign = value >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(value).toFixed(3)}`;
}

function formatPosition(position) {
  const pnl = unrealizedPnl(position);
  const returnPct = ((position.markPrice - position.entryPrice) / position.entryPrice) * 100;
  return `${position.id} ${position.symbol} BUY $${position.investedUsd.toFixed(2)} @ ${position.entryPrice} | mark=${position.markPrice} | PnL=${formatUsd(pnl)} (${returnPct >= 0 ? '+' : ''}${returnPct.toFixed(2)}%)`;
}

function logSnapshot(log) {
  const { positions, totalInvested, totalPnl } = snapshot();
  if (positions.length === 0) {
    log('PAPER: no open positions.');
    return;
  }
  log(`PAPER: ${positions.length} open BUY positions | invested=$${totalInvested.toFixed(2)} | unrealized PnL=${formatUsd(totalPnl)}`);
  for (const position of positions) log(`PAPER: ${formatPosition(position)}`);
}

module.exports = {
  PAPER_TRADE_USD,
  openPaperBuy,
  updateMark,
  snapshot,
  logSnapshot,
};
