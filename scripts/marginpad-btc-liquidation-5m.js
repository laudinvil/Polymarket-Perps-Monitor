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

async function getClobPriceLine(periodStart) {
  const fallback = {
    line: 'PRICE: n/a',
    url: 'https://polymarket.com/event/btc-updown-5m-' + Math.floor(periodStart / 1000)
  };

  const lookupStartedAt = Date.now();

  try {
    const market = await findCurrentMarket(SYMBOL, Date.now(), '5m');
    const url = market?.url || fallback.url;
    if (!market) {
      console.log('CLOB LOOKUP: market=n/a duration_ms=' + (Date.now() - lookupStartedAt));
      console.log('POLYMARKET URL: ' + url);
      return fallback;
    }

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

    console.log(
      'CLOB LOOKUP: up=' + (Number.isFinite(upMid) ? upMid.toFixed(4) : 'n/a') +
      ' down=' + (Number.isFinite(downMid) ? downMid.toFixed(4) : 'n/a') +
      ' cheaper=' + (cheaper ? cheaper.outcome + ' ' + cheaper.price.toFixed(4) : 'n/a') +
      ' duration_ms=' + (Date.now() - lookupStartedAt)
    );
    console.log('POLYMARKET URL: ' + url);

    return {
      line: cheaper
        ? 'PRICE: ' + cheaper.outcome + ' ' + cheaper.price.toFixed(2)
        : fallback.line,
      url
    };
  } catch (error) {
    console.warn('Polymarket CLOB lookup failed: ' + error.message);
    console.log('POLYMARKET URL: ' + fallback.url);
    return fallback;
  }
}

async function sendFirstLiquidation(event, periodStart) {
  const detectionAt = Date.now();
  const eventTs = eventTime(event);
  const { line: clobLine, url: marketUrl } = await getClobPriceLine(periodStart);

  const text = [
    '🔥 BTC · 5M',
    '',
    clobLine,
    '',
    '➡️ Polymarket 5M',
    marketUrl
  ].join('\n');

  console.log(
    'LIQUIDATION TIMING: ' +
    'event_ts=' + iso(eventTs) +
    ' detected_at=' + iso(detectionAt) +
    ' detection_delay_ms=' + (eventTs ? detectionAt - eventTs : 'n/a') +
    ' period_start=' + iso(periodStart) +
    ' period_elapsed_ms=' + (detectionAt - periodStart) +
    ' period_remaining_ms=' + (periodStart + PERIOD_MS - detectionAt)
  );

  console.log(
    'Sending Telegram liquidation alert: event=' +
    JSON.stringify({
      ts: eventTs,
      exchange: event?.exchange,
      symbol: eventSymbol(event),
      side: event?.side,
      price: event?.price,
      qty: event?.qty,
      notional: event?.notional
    }) +
    ' text=' + JSON.stringify(text)
  );

  const telegramStartedAt = Date.now();
  await sendTelegramMessage(text);
  const telegramFinishedAt = Date.now();

  console.log(
    'TELEGRAM SENT: sent_at=' + iso(telegramFinishedAt) +
    ' telegram_duration_ms=' + (telegramFinishedAt - telegramStartedAt) +
    ' end_to_end_delay_ms=' + (telegramFinishedAt - eventTs)
  );
}

async function main() {
  const startedAt = Date.now();
  const seen = new Set();
  let alertedPeriod = null;
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
    const pollStartedAt = now;

    try {
      const events = await fetchFeed([SYMBOL]);
      const pollFinishedAt = Date.now();

      const diagnosed = (events || []).map(event => {
        const ts = eventTime(event);
        const eventPeriod = ts ? bucketStart(ts) : null;
        const symbol = eventSymbol(event);

        let accepted = true;
        let reason = 'accepted';

        if (!ts) {
          accepted = false;
          reason = 'missing_event_ts';
        } else if (symbol !== SYMBOL) {
          accepted = false;
          reason = 'non_btc';
        } else if (ts > pollFinishedAt) {
          accepted = false;
          reason = 'future_event';
        } else if (ts < periodStart) {
          accepted = false;
          reason = 'prior_period';
        }

        console.log(
          'LIQUIDATION DIAGNOSTIC: ' +
          'EVENT ts=' + iso(ts) +
          ' EVENT PERIOD=' + iso(eventPeriod) +
          ' CURRENT PERIOD=' + iso(periodStart) +
          ' ' + (accepted ? 'ACCEPTED' : 'REJECTED') +
          ' REASON=' + reason +
          ' symbol=' + JSON.stringify(symbol) +
          ' side=' + JSON.stringify(event?.side) +
          ' exchange=' + JSON.stringify(event?.exchange)
        );

        return { event, ts, accepted };
      });

      const current = diagnosed
        .filter(row => row.accepted)
        .sort((a, b) => a.ts - b.ts);

      const newestTs = current.length ? current[current.length - 1].ts : 0;

      console.log(
        'MarginPad BTC POLL: ' +
        'started_at=' + iso(pollStartedAt) +
        ' finished_at=' + iso(pollFinishedAt) +
        ' duration_ms=' + (pollFinishedAt - pollStartedAt) +
        ' returned=' + (events || []).length +
        ' current_period_events=' + current.length +
        ' alerted=' + (alertedPeriod === periodStart) +
        ' newest_ts=' + iso(newestTs) +
        ' newest_age_ms=' + (newestTs ? pollFinishedAt - newestTs : 'n/a') +
        ' period_start=' + iso(periodStart) +
        ' period_elapsed_ms=' + (pollFinishedAt - periodStart) +
        ' period_remaining_ms=' + (periodStart + PERIOD_MS - pollFinishedAt)
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
          'MarginPad BTC NEW LIQUIDATION: ' +
          'event_ts=' + iso(row.ts) +
          ' detected_at=' + iso(pollFinishedAt) +
          ' detection_delay_ms=' + (pollFinishedAt - row.ts) +
          ' side=' + JSON.stringify(row.event?.side) +
          ' period=' + iso(periodStart)
        );

        try {
          await sendFirstLiquidation(row.event, periodStart);
          alertedPeriod = periodStart;
          lastSeenTs = row.ts;
          console.log('MarginPad BTC ALERT LOCKED until next 5M period: locked_at=' + iso(Date.now()));
        } catch (error) {
          console.error('BTC liquidation alert send failed: ' + error.message);
        }

        break;
      }
    } catch (error) {
      console.warn('MarginPad poll failed at=' + iso(Date.now()) + ': ' + error.message);
    }

    const remaining = RUN_MS - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(FEED_POLL_MS, remaining));
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