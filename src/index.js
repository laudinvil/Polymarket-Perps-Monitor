const { DEFAULT_SYMBOLS, fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey } = require('./liquidation-monitor');
const { findNextMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = (process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const POLL_MS = 15000;
const reportedBuckets = new Set();

function formatUsd(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
}

function pruneState(currentBucket) {
  for (const bucket of reportedBuckets) {
    if (bucket < currentBucket) reportedBuckets.delete(bucket);
  }
}

async function checkOnce() {
  const now = Date.now();
  const currentBucket = bucketStart(now);
  pruneState(currentBucket);

  // Only evaluate a bucket after it has closed. This guarantees that the
  // alert contains the final liquidation counts for all monitored coins.
  const closedBucket = currentBucket - 5 * 60 * 1000;
  if (reportedBuckets.has(closedBucket)) return;

  const results = await Promise.all(
    symbols.map(async symbol => {
      try {
        return [symbol, await fetchSymbolFeed(symbol, fetch)];
      } catch (error) {
        console.warn(`MarginPad live ${symbol}: ${error.message}`);
        return [symbol, []];
      }
    }),
  );

  const allowed = new Set(symbols.map(normalizeSymbol));
  const counts = new Map(symbols.map(symbol => [normalizeSymbol(symbol), 0]));
  const seen = new Set();

  for (const [, events] of results) {
    for (const event of events) {
      const ts = normalizeTs(event.ts);
      const symbol = normalizeSymbol(event.symbol);
      const side = String(event.side || '').toLowerCase();
      if (!ts || bucketStart(ts) !== closedBucket || !allowed.has(symbol)) continue;
      if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;

      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(symbol, (counts.get(symbol) || 0) + 1);
    }
  }

  reportedBuckets.add(closedBucket);

  const ranking = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const [winnerSymbol, winnerCount] = ranking[0] || [null, 0];

  // One liquidation is not an alert. We also require a strict leader:
  // if two or more coins have the same highest count, no alert is sent.
  if (!winnerSymbol || winnerCount <= 1 || ranking[1]?.[1] === winnerCount) {
    console.log(JSON.stringify({
      type: 'liquidation_max_count_5m',
      bucketStart: new Date(closedBucket).toISOString(),
      counts: Object.fromEntries(ranking),
      alertSent: false,
      reason: winnerCount <= 1 ? 'winner_count_le_1' : 'no_unique_winner',
    }));
    return;
  }

  const winnerEvents = [];
  for (const [, events] of results) {
    for (const event of events) {
      const ts = normalizeTs(event.ts);
      const symbol = normalizeSymbol(event.symbol);
      if (symbol !== winnerSymbol || !ts || bucketStart(ts) !== closedBucket) continue;
      const side = String(event.side || '').toLowerCase();
      if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
      const key = eventKey(event);
      if (winnerEvents.some(item => item.key === key)) continue;
      winnerEvents.push({ key, event, ts });
    }
  }

  const longCount = winnerEvents.filter(({ event }) => {
    const side = String(event.side || '').toLowerCase();
    return side.includes('long') || side === 'buy';
  }).length;
  const shortCount = winnerCount - longCount;
  const totalVolume = winnerEvents.reduce((sum, { event }) => sum + (Number(event.notional) || 0), 0);

  const nextMarket = await findNextMarket(winnerSymbol, now);
  const bucketLabel = new Date(closedBucket).toISOString().slice(11, 16);

  let message = [
    '🔥 LIQUIDATION SPIKE',
    `${winnerSymbol} · 5M · ${bucketLabel} UTC`, '',
    `Liquidations: ${winnerCount}`,
    `Long: ${longCount} · Short: ${shortCount}`,
    `Volume: ${formatUsd(totalVolume)}`,
  ].join('\n');

  message += nextMarket
    ? `\n\n➡️ Next Polymarket 5M\n${nextMarket.url}`
    : '\n\n➡️ Next Polymarket 5M\nMarket not found yet';

  await sendTelegramMessage(message);

  console.log(JSON.stringify({
    type: 'liquidation_max_count_5m',
    bucketStart: new Date(closedBucket).toISOString(),
    winner: {
      symbol: winnerSymbol,
      liquidations: winnerCount,
      longCount,
      shortCount,
      notionalUsd: totalVolume,
    },
    counts: Object.fromEntries(ranking),
    alertSent: true,
  }));
}

async function main() {
  console.log(`5M liquidation count monitor started; polling every ${POLL_MS}ms`);

  while (true) {
    try {
      await checkOnce();
    } catch (error) {
      console.error(`MONITOR CYCLE FAILED: ${error.stack || error.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(`MONITOR FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
