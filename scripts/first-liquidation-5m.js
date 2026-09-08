const { DEFAULT_SYMBOLS, fetchSymbolFeed, normalizeTs, normalizeSymbol } = require('../src/liquidation-monitor');
const { findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const symbols = (process.env.SYMBOLS || DEFAULT_SYMBOLS.join(','))
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

const POLL_MS = 15000;
const POLYMARKET_PERIOD_MS = 15 * 60 * 1000;
const alertedPeriods = new Set();

function periodStart(ts) {
  return Math.floor(ts / POLYMARKET_PERIOD_MS) * POLYMARKET_PERIOD_MS;
}

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
  const currentPeriod = periodStart(now);

  // Polymarket 15M periods are fixed wall-clock periods (:00, :15, :30, :45).
  // Once the first liquidation is found in a period, all later liquidations
  // in that same 15M period are ignored. The period key is discarded as time advances.
  for (const period of alertedPeriods) {
    if (period < currentPeriod) alertedPeriods.delete(period);
  }

  if (alertedPeriods.has(currentPeriod)) return;

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

  const periodEnd = currentPeriod + POLYMARKET_PERIOD_MS;
  const allowed = new Set(symbols.map(normalizeSymbol));
  const candidates = results.flat()
    .map(event => ({ event, ts: normalizeTs(event.ts) }))
    .filter(({ event, ts }) => {
      const symbol = normalizeSymbol(event.symbol);
      return ts >= currentPeriod && ts < periodEnd && allowed.has(symbol);
    })
    .sort((a, b) => a.ts - b.ts);

  if (!candidates.length) {
    console.log(JSON.stringify({
      type: 'liquidation_first_5m',
      periodStart: new Date(currentPeriod).toISOString(),
      periodEnd: new Date(periodEnd).toISOString(),
      rawEvents: results.reduce((sum, events) => sum + events.length, 0),
      alertSent: false,
    }));
    return;
  }

  // FIRST liquidation of the Polymarket 15M period. Everything after it
  // is ignored until the next fixed 15M boundary.
  const first = candidates[0].event;
  const firstTs = normalizeTs(first.ts) || now;
  const symbol = normalizeSymbol(first.symbol);
  const side = sideLabel(first.side);
  const notional = Number(first.notional) || 0;
  const price = Number(first.price);
  const qty = Number(first.qty);

  // Lock the whole 15M period immediately: no second liquidation can alert.
  alertedPeriods.add(currentPeriod);

  const nextMarket = await findNextMarket(symbol, now);

  const timeLabel = new Date(firstTs).toISOString().slice(11, 19);
  let message = [
    '🔥 LIQUIDATION',
    `${symbol} · 5M · ${timeLabel} UTC`, '',
    `Side: ${side}`,
    `Volume: ${formatUsd(notional)}`,
    Number.isFinite(price) ? `Price: ${price}` : null,
    Number.isFinite(qty) ? `Qty: ${qty}` : null,
  ].filter(Boolean).join('\n');

  message += nextMarket
    ? `\n\n➡️ NEXT · Polymarket 5M\n${nextMarket.url}`
    : '\n\n➡️ NEXT · Polymarket 5M\nMarket not found yet';

  await sendTelegramMessage(message);

  console.log(JSON.stringify({
    type: 'liquidation_first_5m',
    periodStart: new Date(currentPeriod).toISOString(),
    periodEnd: new Date(periodEnd).toISOString(),
    firstEvent: {
      symbol,
      side,
      ts: firstTs,
      notionalUsd: notional,
    },
    ignoredAfterFirst: Math.max(0, candidates.length - 1),
    rawEvents: results.reduce((sum, events) => sum + events.length, 0),
    alertSent: true,
  }));
}

async function main() {
  console.log(`First-liquidation 5M monitor started; first liquidation only per Polymarket 15M period; polling every ${POLL_MS}ms`);

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
