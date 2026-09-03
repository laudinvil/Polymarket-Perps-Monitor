const {
  DEFAULT_SYMBOLS,
  fetchFeed,
  aggregateEvents,
  selectWinner,
  bucketStart,
  eventKey,
} = require('./liquidation-monitor');
const { findNextMarket } = require('./polymarket');

const symbols = DEFAULT_SYMBOLS;

async function main() {
  console.log(`Symbols: ${symbols.join(', ')}`);

  const events = await fetchFeed();
  console.log(`MarginPad feed events: ${events.length}`);

  const present = new Set(events.map((e) => String(e.symbol || '').toUpperCase().replace(/USDT$|USD$/i, '')));
  console.log(`Symbols present in feed: ${symbols.filter((s) => present.has(s)).join(', ') || 'NONE'}`);
  console.log(`HYPE present: ${present.has('HYPE') ? 'YES' : 'NO'}`);

  const uniqueKeys = new Set(events.map(eventKey));
  console.log(`Unique event keys: ${uniqueKeys.size}`);
  console.log(`Duplicate events in response: ${events.length - uniqueKeys.size}`);

  const now = Date.now();
  const currentBucket = bucketStart(now);
  const closedBucket = currentBucket - 5 * 60 * 1000;
  console.log(`Current 5m bucket: ${new Date(currentBucket).toISOString()}`);
  console.log(`Closed 5m bucket: ${new Date(closedBucket).toISOString()}`);

  const rows = aggregateEvents(events, symbols, now);
  const winner = selectWinner(rows, closedBucket);
  console.log('Closed 5m aggregation:');
  for (const row of rows) {
    console.log(JSON.stringify({
      symbol: row.symbol,
      events: row.events,
      longEvents: row.longEvents,
      shortEvents: row.shortEvents,
      notionalUsd: row.notionalUsd,
      longNotionalUsd: row.longNotionalUsd,
      shortNotionalUsd: row.shortNotionalUsd,
    }));
  }
  console.log(`Winner: ${winner ? `${winner.symbol} (${winner.events} events, $${Math.round(winner.notionalUsd)})` : 'NONE'}`);

  console.log('Polymarket next 5m markets:');
  for (const symbol of symbols) {
    const market = await findNextMarket(symbol, now);
    console.log(`${symbol}: ${market ? market.url : 'NOT FOUND'}`);
  }

  console.log(`TELEGRAM_BOT_TOKEN configured: ${process.env.TELEGRAM_BOT_TOKEN ? 'YES' : 'NO'}`);
  console.log(`TELEGRAM_CHAT_ID configured: ${process.env.TELEGRAM_CHAT_ID ? 'YES' : 'NO'}`);
  console.log('Telegram send: DRY-RUN (no message sent)');
}

main().catch((error) => {
  console.error(`DIAGNOSTIC FAILED: ${error.message}`);
  process.exit(1);
});
