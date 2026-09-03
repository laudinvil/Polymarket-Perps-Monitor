const { DEFAULT_SYMBOLS, fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey } = require('./liquidation-monitor');
const { findCurrentMarket, findNextMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = (process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const POLL_MS = 15000;
const alertedBuckets = new Set();
const alertedEvents = new Set();

function formatUsd(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
}

function pruneState(currentBucket) {
  for (const bucket of alertedBuckets) {
    if (bucket < currentBucket) alertedBuckets.delete(bucket);
  }

  for (const key of alertedEvents) {
    const bucket = Number(key.split(':', 1)[0]);
    if (!Number.isFinite(bucket) || bucket < currentBucket - 5 * 60 * 1000) {
      alertedEvents.delete(key);
    }
  }
}

async function checkOnce() {
  const now = Date.now();
  const currentBucket = bucketStart(now);
  pruneState(currentBucket);

  if (alertedBuckets.has(currentBucket)) return;

  const results = await Promise.all(
    symbols.map(async symbol => {
      try {
        return await fetchSymbolFeed(symbol, fetch);
      } catch (error) {
        console.warn(`MarginPad live ${symbol}: ${error.message}`);
        return [];
      }
    }),
  );

  const allowed = new Set(symbols.map(normalizeSymbol));
  const candidates = results.flat().map(event => ({
    event,
    ts: normalizeTs(event.ts),
    key: eventKey(event),
  }))
    .filter(({ event, ts }) => {
      const symbol = normalizeSymbol(event.symbol);
      const side = String(event.side || '').toLowerCase();
      return ts && bucketStart(ts) === currentBucket && allowed.has(symbol)
        && (side.includes('long') || side === 'buy');
    })
    .sort((a, b) => a.ts - b.ts);

  if (!candidates.length) {
    console.log(JSON.stringify({
      type: 'liquidation_first_long_5m',
      bucketStart: new Date(currentBucket).toISOString(),
      rawEvents: results.reduce((sum, events) => sum + events.length, 0),
      alertSent: false,
    }));
    return;
  }

  const first = candidates[0];
  const firstEvent = first.event;
  const firstTs = first.ts || now;
  const symbol = normalizeSymbol(firstEvent.symbol);
  const notional = Number(firstEvent.notional) || 0;
  const price = Number(firstEvent.price);
  const qty = Number(firstEvent.qty);
  const dedupeKey = `${currentBucket}:${first.key}`;

  if (alertedEvents.has(dedupeKey)) {
    alertedBuckets.add(currentBucket);
    return;
  }

  // Claim the exact event before sending. This prevents the same event from
  // being sent twice if the polling loop sees it again in this process.
  alertedEvents.add(dedupeKey);
  alertedBuckets.add(currentBucket);

  const [currentMarket, nextMarket] = await Promise.all([
    findCurrentMarket(symbol, now),
    findNextMarket(symbol, now),
  ]);

  const timeLabel = new Date(firstTs).toISOString().slice(11, 19);
  let message = [
    '🔥 LIQUIDATION LONG',
    `${symbol} · 5M · ${timeLabel} UTC`, '',
    'Side: Long',
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

  try {
    await sendTelegramMessage(message);
  } catch (error) {
    alertedEvents.delete(dedupeKey);
    alertedBuckets.delete(currentBucket);
    throw error;
  }

  console.log(JSON.stringify({
    type: 'liquidation_first_long_5m',
    bucketStart: new Date(currentBucket).toISOString(),
    firstEvent: {
      key: first.key,
      symbol,
      side: 'Long',
      ts: firstTs,
      notionalUsd: notional,
    },
    rawEvents: results.reduce((sum, events) => sum + events.length, 0),
    alertSent: true,
  }));
}

async function main() {
  console.log(`First LONG liquidation monitor started; polling every ${POLL_MS}ms`);

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
