const { DEFAULT_SYMBOLS, fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart } = require('./liquidation-monitor');
const { findCurrentMarket, findNextMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = (process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const POLL_MS = 15000;
const alertedBuckets = new Set();

function formatUsd(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`;
}

async function checkOnce() {
  const now = Date.now();
  const currentBucket = bucketStart(now);

  for (const bucket of alertedBuckets) {
    if (bucket < currentBucket) alertedBuckets.delete(bucket);
  }

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
  const candidates = results.flat().map(event => ({ event, ts: normalizeTs(event.ts) }))
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

  const first = candidates[0].event;
  const firstTs = normalizeTs(first.ts) || now;
  const symbol = normalizeSymbol(first.symbol);
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

  await sendTelegramMessage(message);

  console.log(JSON.stringify({
    type: 'liquidation_first_long_5m',
    bucketStart: new Date(currentBucket).toISOString(),
    firstEvent: {
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
