const { fetchFeed, normalizeTs, normalizeSymbol, bucketStart, POLL_MS } = require('../src/liquidation-monitor');
const { findCurrentMarket, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const SYMBOL = 'BTC';
const PERIOD_MS = 5 * 60 * 1000;
const RUN_MS = PERIOD_MS - 15 * 1000;
const HISTORY_LOOKBACK_MS = 30 * 60 * 1000;
const FEED_POLL_MS = POLL_MS || 4000;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function eventTime(event) {
  return normalizeTs(event?.ts ?? event?.timestamp ?? event?.time ?? event?.createdAt ?? event?.created_at);
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

async function getClobPriceLine(periodStart) {
  const fallback = {
    line: 'CLOB PRICE: n/a',
    url: 'https://polymarket.com/event/btc-updown-5m-' + Math.floor(periodStart / 1000)
  };

  try {
    const market = await findCurrentMarket(SYMBOL, Date.now(), '5m');
    const url = market?.url || fallback.url;
    if (!market) return fallback;

    const [upMid, downMid] = await Promise.all([
      findClobMidpoint(market, 'UP'),
      findClobMidpoint(market, 'DOWN')
    ]);

    let cheaper = null;
    if (Number.isFinite(upMid) && Number.isFinite(downMid)) {
      cheaper = upMid <= downMid
        ? { outcome: 'UP', price: upMid }
        : { outcome: 'DOWN', price: downMid };
    } else if (Number.isFinite(upMid)) {
      cheaper = { outcome: 'UP', price: upMid };
    } else if (Number.isFinite(downMid)) {
      cheaper = { outcome: 'DOWN', price: downMid };
    }

    return {
      line: cheaper
        ? 'CLOB PRICE: ' + cheaper.outcome + ' ' + cheaper.price.toFixed(2)
        : fallback.line,
      url
    };
  } catch (error) {
    console.warn('Polymarket CLOB lookup failed: ' + error.message);
    return fallback;
  }
}

async function sendFirstLiquidation(event, periodStart) {
  const { line: clobLine, url: marketUrl } = await getClobPriceLine(periodStart);

  const text = [
    '🔥 BTC · LIQUIDATION',
    '',
    clobLine,
    '',
    '➡️ CURRENT · Polymarket 5M',
    marketUrl
  ].join('\n');

  console.log(
    'Sending Telegram liquidation alert: event=' +
    JSON.stringify({
      ts: eventTime(event),
      exchange: event?.exchange,
      side: event?.side,
      price: event?.price,
      qty: event?.qty,
      notional: event?.notional
    }) +
    ' text=' + JSON.stringify(text)
  );

  await sendTelegramMessage(text);
  console.log('Telegram liquidation alert sent');
}

async function main() {
  const startedAt = Date.now();
  const seen = new Set();
  let alertedPeriod = null;
  let lastSeenTs = 0;

  console.log('MarginPad BTC monitor: /feed via fetchFeed, poll=' + FEED_POLL_MS + 'ms');

  while (Date.now() - startedAt < RUN_MS) {
    const now = Date.now();
    const periodStart = bucketStart(now);

    try {
      const events = await fetchFeed([SYMBOL]);

      const current = (events || [])
        .map(event => ({ event, ts: eventTime(event) }))
        .filter(row =>
          row.ts &&
          row.ts <= now &&
          row.ts >= now - HISTORY_LOOKBACK_MS
        )
        .sort((a, b) => a.ts - b.ts);

      console.log(
        'MarginPad BTC POLL: returned=' + (events || []).length +
        ' recent_events=' + current.length +
        ' alerted=' + (alertedPeriod === periodStart) +
        ' newest_ts=' + (current.length ? new Date(current[current.length - 1].ts).toISOString() : 'n/a')
      );

      for (const row of current) {
        const key = eventKey(row.event);
        if (seen.has(key)) continue;
        seen.add(key);

        if (alertedPeriod === periodStart) {
          console.log('MarginPad BTC: alert already sent for current 5M — ignore');
          break;
        }

        console.log(
          'MarginPad BTC NEW LIQUIDATION: ts=' +
          new Date(row.ts).toISOString() +
          ' side=' + JSON.stringify(row.event?.side) +
          ' period=' + new Date(periodStart).toISOString()
        );

        try {
          await sendFirstLiquidation(row.event, periodStart);
          alertedPeriod = periodStart;
          lastSeenTs = row.ts;
          console.log('MarginPad BTC ALERT LOCKED until next 5M period');
        } catch (error) {
          console.error('BTC liquidation alert send failed: ' + error.message);
        }

        break;
      }
    } catch (error) {
      console.warn('MarginPad poll failed: ' + error.message);
    }

    const remaining = RUN_MS - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(FEED_POLL_MS, remaining));
  }

  console.log('MarginPad BTC monitor finished; lastSeenTs=' + (lastSeenTs ? new Date(lastSeenTs).toISOString() : 'n/a'));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
