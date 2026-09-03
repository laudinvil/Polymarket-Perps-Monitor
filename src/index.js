const { DEFAULT_SYMBOLS, fetchFeed, aggregateEvents, selectWinner, bucketStart, eventKey } = require('./liquidation-monitor');
const { findCurrentMarket, findNextMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = (process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
const recentEvents = new Map();
const POLL_MS = 15000;

function formatUsd(value) { return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`; }

async function check(now) {
  const events = await fetchFeed(symbols, fetch, now);
  for (const event of events) recentEvents.set(eventKey(event), event);

  const cutoff = now - 15 * 60 * 1000;
  for (const [key, event] of recentEvents) {
    const ts = Number(event.ts) < 1e12 ? Number(event.ts) * 1000 : Number(event.ts);
    if (!Number.isFinite(ts) || ts < cutoff) recentEvents.delete(key);
  }

  const closedBucket = bucketStart(now) - 5 * 60 * 1000;
  const rows = aggregateEvents([...recentEvents.values()], symbols, now);
  const winner = selectWinner(rows, closedBucket);

  console.log(JSON.stringify({
    type: 'liquidation_5m',
    bucketStart: new Date(closedBucket).toISOString(),
    fetchedEvents: events.length,
    bufferedEvents: recentEvents.size,
    winner: winner ? {
      symbol: winner.symbol, events: winner.events,
      longEvents: winner.longEvents, shortEvents: winner.shortEvents,
      notionalUsd: winner.notionalUsd,
      longNotionalUsd: winner.longNotionalUsd,
      shortNotionalUsd: winner.shortNotionalUsd,
    } : null,
  }));

  if (!winner || winner.notionalUsd <= 0) return;

  const [currentMarket, nextMarket] = await Promise.all([
    findCurrentMarket(winner.symbol, now),
    findNextMarket(winner.symbol, now),
  ]);
  const bucketLabel = new Date(closedBucket).toISOString().slice(11, 16);
  let message = [
    '🔥 LIQUIDATION SPIKE', `${winner.symbol} · 5M · ${bucketLabel} UTC`, '',
    `Liquidations: ${winner.events}`,
    `Long: ${winner.longEvents} · Short: ${winner.shortEvents}`,
    `Volume: ${formatUsd(winner.notionalUsd)}`,
    `Long volume: ${formatUsd(winner.longNotionalUsd)}`,
    `Short volume: ${formatUsd(winner.shortNotionalUsd)}`,
  ].join('\n');
  message += currentMarket ? `\n\n🔴 Current Polymarket 5M\n${currentMarket.url}` : '\n\n🔴 Current Polymarket 5M\nMarket not found';
  message += nextMarket ? `\n\n➡️ Next Polymarket 5M\n${nextMarket.url}` : '\n\n➡️ Next Polymarket 5M\nMarket not found yet';

  await sendTelegramMessage(message);
  console.log(`Telegram alert sent for ${winner.symbol} ${new Date(closedBucket).toISOString()}`);
}

async function main() {
  console.log(`Continuous MarginPad monitor started; polling every ${POLL_MS}ms`);
  let lastAlertBucket = null;
  while (true) {
    const now = Date.now();
    try {
      const before = lastAlertBucket;
      await check(now);
      const closed = bucketStart(now) - 5 * 60 * 1000;
      if (before !== closed) lastAlertBucket = closed;
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
