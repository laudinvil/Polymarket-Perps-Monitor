const {
  DEFAULT_SYMBOLS,
  POLL_MS,
  fetchFeed,
  aggregateEvents,
  selectWinner,
  bucketStart,
} = require('./liquidation-monitor');

const symbols = (process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

let seenBucket = null;
let recentEvents = [];

async function tick() {
  const events = await fetchFeed();
  recentEvents = recentEvents.concat(events);

  // Keep a rolling 15 minutes locally; the feed is polled every 4 seconds.
  const cutoff = Date.now() - 15 * 60 * 1000;
  recentEvents = recentEvents.filter((e) => {
    const ts = Number(e.ts) < 1e12 ? Number(e.ts) * 1000 : Number(e.ts);
    return Number.isFinite(ts) && ts >= cutoff;
  });

  const currentBucket = bucketStart(Date.now());
  const closedBucket = currentBucket - 5 * 60 * 1000;
  if (seenBucket === closedBucket) return;

  const rows = aggregateEvents(recentEvents, symbols, Date.now());
  const winner = selectWinner(rows, closedBucket);
  seenBucket = closedBucket;

  if (!winner) {
    console.log(JSON.stringify({ type: 'liquidation_5m', bucket: closedBucket, winner: null }));
    return;
  }

  console.log(JSON.stringify({
    type: 'liquidation_5m',
    bucket: closedBucket,
    winner: {
      symbol: winner.symbol,
      events: winner.events,
      longEvents: winner.longEvents,
      shortEvents: winner.shortEvents,
      notionalUsd: winner.notionalUsd,
      longNotionalUsd: winner.longNotionalUsd,
      shortNotionalUsd: winner.shortNotionalUsd,
    },
  }));
}

async function main() {
  console.log(`MarginPad liquidation monitor started: ${symbols.join(', ')}`);
  await tick();
  setInterval(() => tick().catch((error) => console.error(error.message)), POLL_MS);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
