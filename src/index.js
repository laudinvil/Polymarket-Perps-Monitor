const {
  DEFAULT_SYMBOLS,
  POLL_MS,
  fetchFeed,
  aggregateEvents,
  selectWinner,
  bucketStart,
  eventKey,
} = require('./liquidation-monitor');

const symbols = (process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

let seenBucket = null;
const recentEvents = new Map();

async function tick() {
  const events = await fetchFeed();

  for (const event of events) {
    const key = eventKey(event);
    recentEvents.set(key, event);
  }

  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, event] of recentEvents) {
    const ts = Number(event.ts) < 1e12 ? Number(event.ts) * 1000 : Number(event.ts);
    if (!Number.isFinite(ts) || ts < cutoff) recentEvents.delete(key);
  }

  const currentBucket = bucketStart(Date.now());
  const closedBucket = currentBucket - 5 * 60 * 1000;
  if (seenBucket === closedBucket) return;

  const rows = aggregateEvents([...recentEvents.values()], symbols, Date.now());
  const winner = selectWinner(rows, closedBucket);
  seenBucket = closedBucket;

  console.log(JSON.stringify({
    type: 'liquidation_5m',
    bucketStart: new Date(closedBucket).toISOString(),
    winner: winner ? {
      symbol: winner.symbol,
      events: winner.events,
      longEvents: winner.longEvents,
      shortEvents: winner.shortEvents,
      notionalUsd: winner.notionalUsd,
      longNotionalUsd: winner.longNotionalUsd,
      shortNotionalUsd: winner.shortNotionalUsd,
    } : null,
  }));
}

async function main() {
  console.log(`MarginPad liquidation monitor started: ${symbols.join(', ')}`);
  await tick();
  setInterval(() => tick().catch((error) => console.error(`tick error: ${error.message}`)), POLL_MS);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
