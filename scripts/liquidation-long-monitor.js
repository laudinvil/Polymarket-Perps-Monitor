const fs = require('fs');
const path = require('path');
const { fetchFeed, aggregateEvents, selectWinner, bucketStart, DEFAULT_SYMBOLS, POLL_MS } = require('../src/liquidation-monitor');
const { findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const STATE_PATH = path.join(process.cwd(), '.liquidation-state.json');
const TZ = 'Europe/Kyiv';
const MIN_LONG_LIQUIDATIONS = 3;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastProcessedBucket: null };
  }
}
function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}
function formatTime(epoch) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(epoch)).replace(',', '');
}

async function processClosedBucket(bucket, state) {
  if (state.lastProcessedBucket !== null && bucket <= Number(state.lastProcessedBucket)) return;

  const now = Date.now();
  const events = await fetchFeed(DEFAULT_SYMBOLS);
  const rows = aggregateEvents(events, DEFAULT_SYMBOLS, now);
  const winner = selectWinner(rows, bucket);

  if (!winner || winner.longEvents < MIN_LONG_LIQUIDATIONS) {
    const candidates = rows.filter(row => row.bucket === bucket);
    const max = candidates.length ? Math.max(...candidates.map(row => row.longEvents)) : 0;
    if (winner && winner.longEvents < MIN_LONG_LIQUIDATIONS) {
      console.log(`[5M] ${formatTime(bucket)} max LONG=${winner.longEvents} below minimum ${MIN_LONG_LIQUIDATIONS}; no alert`);
    } else if (max > 0) {
      console.log(`[5M] ${formatTime(bucket)} tie for max LONG=${max}; no alert`);
    } else {
      console.log(`[5M] ${formatTime(bucket)} no LONG liquidations; no alert`);
    }
    state.lastProcessedBucket = bucket;
    saveState(state);
    return;
  }

  const nextMarket = await findNextMarket(winner.symbol, bucket + 1, '5m');
  const nextUrl = nextMarket?.url || `https://polymarket.com/event/${winner.symbol.toLowerCase()}-updown-5m-${Math.floor((bucket + 5 * 60 * 1000) / 1000)}`;
  const message = [
    `🔥 ${winner.symbol} · 5M`,
    `LONG liquidations: ${winner.longEvents}`,
    `Period: ${formatTime(bucket)} UTC+3`,
    `➡️ NEXT · Polymarket 5M`,
    nextUrl,
  ].join('\n');

  await sendTelegramMessage(message);
  console.log(`[5M] ALERT ${winner.symbol} LONG=${winner.longEvents} period=${formatTime(bucket)} next=${nextUrl}`);
  state.lastProcessedBucket = bucket;
  saveState(state);
}

async function main() {
  console.log(`MarginPad LONG-only liquidation monitor started; symbols=${DEFAULT_SYMBOLS.join(',')}; timeframe=5m; min LONG=${MIN_LONG_LIQUIDATIONS}; alert=unique maximum LONG; ties suppressed; boundary alerts only`);
  const state = loadState();
  let lastObservedBucket = bucketStart(Date.now());

  while (true) {
    try {
      const now = Date.now();
      const currentBucket = bucketStart(now);
      if (currentBucket !== lastObservedBucket) {
        await processClosedBucket(lastObservedBucket, state);
        lastObservedBucket = currentBucket;
      }

      const events = await fetchFeed(DEFAULT_SYMBOLS);
      const rows = aggregateEvents(events, DEFAULT_SYMBOLS, Date.now());
      const currentRows = rows.filter(row => row.bucket === currentBucket);
      const counts = DEFAULT_SYMBOLS.map(symbol => {
        const row = currentRows.find(item => item.symbol === symbol);
        return `${symbol}:${row?.longEvents || 0}`;
      }).join(' ');
      console.log(`[5M] current=${formatTime(currentBucket)} ${counts}`);
    } catch (error) {
      console.error(`[5M] monitor error: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
