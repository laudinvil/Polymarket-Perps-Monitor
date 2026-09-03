const {
  DEFAULT_SYMBOLS,
  POLL_MS,
  fetchFeed,
  aggregateEvents,
  selectWinner,
  bucketStart,
  eventKey,
} = require('./liquidation-monitor');
const { findNextMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = (process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

let seenBucket = null;
const recentEvents = new Map();

function formatUsd(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
}

async function tick() {
  const now = Date.now();
  const events = await fetchFeed();

  for (const event of events) {
    recentEvents.set(eventKey(event), event);
  }

  const cutoff = now - 15 * 60 * 1000;
  for (const [key, event] of recentEvents) {
    const ts = Number(event.ts) < 1e12 ? Number(event.ts) * 1000 : Number(event.ts);
    if (!Number.isFinite(ts) || ts < cutoff) recentEvents.delete(key);
  }

  const currentBucket = bucketStart(now);
  const closedBucket = currentBucket - 5 * 60 * 1000;
  if (seenBucket === closedBucket) return;

  const rows = aggregateEvents([...recentEvents.values()], symbols, now);
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

  if (!winner || winner.events <= 0) return;

  try {
    const market = await findNextMarket(winner.symbol, now);
    const bucketLabel = new Date(closedBucket).toISOString().slice(11, 16);
    let message = [
      '🔥 LIQUIDATION SPIKE',
      `${winner.symbol} · 5M · ${bucketLabel} UTC`,
      '',
      `Liquidations: ${winner.events}`,
      `Long: ${winner.longEvents} · Short: ${winner.shortEvents}`,
      `Volume: ${formatUsd(winner.notionalUsd)}`,
      `Long volume: ${formatUsd(winner.longNotionalUsd)}`,
      `Short volume: ${formatUsd(winner.shortNotionalUsd)}`,
    ].join('\n');

    if (market) {
      message += `\n\n➡️ Next Polymarket 5M\n${market.url}`;
    } else {
      message += '\n\n➡️ Next Polymarket 5M\nMarket not found yet';
    }

    await sendTelegramMessage(message);
    console.log(`Telegram alert sent for ${winner.symbol} ${new Date(closedBucket).toISOString()}`);
  } catch (error) {
    console.error(`Telegram/Polymarket alert error: ${error.message}`);
  }
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
