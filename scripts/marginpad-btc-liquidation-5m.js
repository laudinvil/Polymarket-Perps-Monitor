const { fetchFeed, normalizeTs, normalizeSymbol, bucketStart, POLL_MS } = require('../src/liquidation-monitor');
const { findCurrentMarket, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const SYMBOL = 'BTC';
const PERIOD_MS = 5 * 60 * 1000;
const RUN_MS = PERIOD_MS - 15 * 1000;
const HISTORY_LOOKBACK_MS = 30 * 60 * 1000;
const FEED_POLL_MS = POLL_MS || 4000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function iso(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : 'n/a';
}

function eventTime(event) {
  const value = event?.ts ?? event?.timestamp ?? event?.time ?? event?.createdAt ?? event?.created_at ?? event?.data?.ts ?? event?.data?.timestamp;
  return normalizeTs(value);
}

function eventSymbol(event) {
  return normalizeSymbol(event?.symbol ?? event?.market ?? event?.pair ?? event?.instrument ?? event?.asset ?? event?.data?.symbol ?? event?.data?.market);
}

function eventKey(event) {
  return [
    eventTime(event),
    event?.exchange,
    normalizeSymbol(event?.symbol),
    event?.side,
    event?.price,
    event?.qty,
    event?.notional
  ].join('|');
}

async function getNextMarketUrl() {
  const fallbackEpoch = bucketStart(Date.now()) + PERIOD_MS;
  try {
    const market = await findNextMarket(SYMBOL, Date.now(), '5m');
    return market?.url || 'https://polymarket.com/event/btc-updown-5m-' + Math.floor(fallbackEpoch / 1000);
  } catch (error) {
    console.warn('Polymarket next market lookup failed: ' + error.message);
    return 'https://polymarket.com/event/btc-updown-5m-' + Math.floor(fallbackEpoch / 1000);
  }
}

async function sendLatestLiquidation(event, periodStart) {
  const detectionAt = Date.now();
  const eventTs = eventTime(event);
  const direction = String(event?.side || event?.direction || '').toLowerCase().includes('long') || String(event?.side || event?.direction || '').toLowerCase() === 'buy'
    ? 'LONG'
    : String(event?.side || event?.direction || '').toLowerCase().includes('short') || String(event?.side || event?.direction || '').toLowerCase() === 'sell'
      ? 'SHORT'
      : 'UNKNOWN';
  const marketUrl = await getNextMarketUrl();

  const text = [
    '🔥 BTC · 5M',
    '',
    'LAST LIQUIDATION: ' + direction,
    '',
    '➡️ NEXT · Polymarket 5M',
    marketUrl
  ].join('\n');

  console.log(
    'LATEST LIQUIDATION: ' +
    'event_ts=' + iso(eventTs) +
    ' detected_at=' + iso(detectionAt) +
    ' detection_delay_ms=' + (eventTs ? detectionAt - eventTs : 'n/a') +
    ' direction=' + direction +
    ' period_start=' + iso(periodStart)
  );

  console.log('Sending Telegram latest liquidation alert: text=' + JSON.stringify(text));
  await sendTelegramMessage(text);
  console.log('TELEGRAM SENT: sent_at=' + iso(Date.now()));
}

async function main() {
  const startedAt = Date.now();
  let currentPeriodStart = bucketStart(startedAt);
  let latestLiquidation = null;
  let lastSeenTs = 0;

  console.log(
    'MarginPad BTC monitor START: started_at=' + iso(startedAt) +
    ' poll_ms=' + FEED_POLL_MS +
    ' run_ms=' + RUN_MS +
    ' expected_stop_at=' + iso(startedAt + RUN_MS)
  );

  while (Date.now() - startedAt < RUN_MS) {
    const now = Date.now();
    const periodStart = bucketStart(now);

    if (periodStart !== currentPeriodStart) {
      currentPeriodStart = periodStart;
      latestLiquidation = null;
    }

    const pollStartedAt = now;

    try {
      const events = await fetchFeed([SYMBOL]);
      const pollFinishedAt = Date.now();

      const current = (events || [])
        .map(event => {
          const ts = eventTime(event);
          const symbol = eventSymbol(event);
          return { event, ts, symbol };
        })
        .filter(row => row.ts && row.symbol === SYMBOL && row.ts <= pollFinishedAt && bucketStart(row.ts) === periodStart)
        .sort((a, b) => a.ts - b.ts);

      const newest = current.length ? current[current.length - 1] : null;

      if (newest && (!latestLiquidation || newest.ts > latestLiquidation.ts)) {
        latestLiquidation = newest;
        lastSeenTs = newest.ts;
        console.log(
          'MarginPad BTC LATEST UPDATE: event_ts=' + iso(newest.ts) +
          ' side=' + JSON.stringify(newest.event?.side) +
          ' exchange=' + JSON.stringify(newest.event?.exchange) +
          ' period=' + iso(periodStart)
        );
      }

      console.log(
        'MarginPad BTC POLL: ' +
        'started_at=' + iso(pollStartedAt) +
        ' finished_at=' + iso(pollFinishedAt) +
        ' duration_ms=' + (pollFinishedAt - pollStartedAt) +
        ' returned=' + (events || []).length +
        ' current_period_events=' + current.length +
        ' latest_ts=' + iso(latestLiquidation?.ts) +
        ' period_start=' + iso(periodStart) +
        ' period_elapsed_ms=' + (pollFinishedAt - periodStart) +
        ' period_remaining_ms=' + (periodStart + PERIOD_MS - pollFinishedAt)
      );
    } catch (error) {
      console.warn('MarginPad poll failed at=' + iso(Date.now()) + ': ' + error.message);
    }

    const remaining = RUN_MS - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(FEED_POLL_MS, remaining));
  }

  if (latestLiquidation) {
    try {
      await sendLatestLiquidation(latestLiquidation.event, currentPeriodStart);
    } catch (error) {
      console.error('BTC latest liquidation alert send failed: ' + error.message);
    }
  } else {
    console.log('MarginPad BTC: no liquidation found in current 5M period — no alert');
  }

  const finishedAt = Date.now();
  console.log(
    'MarginPad BTC monitor FINISHED: finished_at=' + iso(finishedAt) +
    ' runtime_ms=' + (finishedAt - startedAt) +
    ' lastSeenTs=' + iso(lastSeenTs)
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
