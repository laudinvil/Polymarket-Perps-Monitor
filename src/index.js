const { DEFAULT_SYMBOLS, fetchFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey, WINDOW_MS } = require('./liquidation-monitor');
const { findCurrentMarket, findNextMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = (process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const POLL_MS = 15000;
const alertedBuckets = new Set();

function formatUsd(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
}

function sideLabel(side) {
  const value = String(side || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 'Long';
  if (value.includes('short') || value === 'sell') return 'Short';
  return String(side || 'Unknown');
}

async function checkOnce() {
  const now = Date.now();
  const currentBucket = bucketStart(now);

  // Reset state automatically when a new 5-minute bucket begins.
  for (const bucket of alertedBuckets) {
    if (bucket < currentBucket) alertedBuckets.delete(bucket);
  }

  if (alertedBuckets.has(currentBucket)) return;

  const events = await fetchFeed(symbols, fetch, now);
  const allowed = new Set(symbols.map(normalizeSymbol));

  const candidates = events
    .map(event => ({ event, ts: normalizeTs(event.ts) }))
    .filter(({ event, ts }) => {
      const symbol = normalizeSymbol(event.symbol);
      return ts && bucketStart(ts) === currentBucket && allowed.has(symbol);
    })
    .sort((a, b) => a.ts - b.ts);

  if (!candidates.length) {
    console.log(JSON.stringify({
      type: 'liquidation_first_5m',
      bucketStart: new Date(currentBucket).toISOString(),
      fetchedEvents: events.length,
      alertSent: false,
    }));
    return;
  }

  // First raw liquidation seen in this 5-minute period wins. Nothing else alerts until reset.
  const first = candidates[0].event;
  const firstTs = normalizeTs(first.ts) || now;
  const symbol = normalizeSymbol(first.symbol);
  const side = sideLabel(first.side);
  const notional = Number(first.notional) || 0;
  const price = Number(first.price);
  const qty = Number(first.qty);

  alertedBuckets.add(currentBucket);

  const [currentMarket, nextMarket] = await Promise.all([
    findCurrentMarket(symbol, now),
    findNextMarket(symbol, now),
  ]);

  const timeLabel = new Date(firstTs).toISOString().slice(11, 19);
  let message = [
    '🔥 LIQUIDATION',
    `${symbol} · 5M · ${timeLabel} UTC`, '',
    `Side: ${side}`,
    `Volume: ${formatUsd(notional)}`,
    Number.isFinite(price) ? `Price: ${price}` : null,
    Number.isFinite(qty) ? `Qty: ${qty}` : null,
  ].filter(Boolean).join('\n');

  message += currentMarket
    ? `\n\n🔴 Current Polymarket 5M\n${currentMarket.url}`
    : '\n\n🔴 Current Polymarket 5M\nMarket not found';
  message += nextMarket
    ? `\n\n➡️ Next Polymarket 5M\n${nextMarket.url}`
    : '\n\n➡️ Next Polymarket 5M\nMarket not found yet';

  await sendTelegramMessage(message);

  console.log(JSON.stringify({
    type: 'liquidation_first_5m',
    bucketStart: new Date(currentBucket).toISOString(),
    firstEvent: {
      key: eventKey(first),
      symbol,
      side,
      ts: firstTs,
      notionalUsd: notional,
    },
    fetchedEvents: events.length,
    alertSent: true,
  }));
}

async function main() {
  console.log(`First-liquidation monitor started; polling every ${POLL_MS}ms`);

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
