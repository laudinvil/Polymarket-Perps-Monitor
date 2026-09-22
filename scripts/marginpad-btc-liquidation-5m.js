const { normalizeTs, normalizeSymbol, bucketStart } = require('../src/liquidation-monitor');
const { findCurrentMarket, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const SYMBOL = 'BTC';
const PERIOD_MS = 5 * 60 * 1000;
const RUN_MS = PERIOD_MS - 15 * 1000;
const FEED_POLL_MS = 3000;
const PROXY_VERSION = 'feed-fallback-v1';
const DEFAULT_CONVEX_SITE_URL = 'https://brainy-canary-207.eu-west-1.convex.site';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function fetchMarginPadDirect(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {headers:{accept:'application/json','cache-control':'no-cache','user-agent':'Polymarket-Perps-Monitor/2.0'},signal:controller.signal});
    const json = await response.json();
    if (!response.ok || json?.ok === false) throw new Error('MarginPad HTTP ' + response.status);
    return json;
  } finally { clearTimeout(timeout); }
}
function extractMarginPadEvents(json) {
  const data=json?.data;
  if(Array.isArray(json?.events)) return json.events;
  if(Array.isArray(json?.liquidations)) return json.liquidations;
  if(Array.isArray(data?.events)) return data.events;
  if(Array.isArray(data?.liquidations)) return data.liquidations;
  if(Array.isArray(data?.data?.events)) return data.data.events;
  if(Array.isArray(data?.data?.liquidations)) return data.data.liquidations;
  if(Array.isArray(data)) return data;
  return [];
}
async function fetchViaConvexProxy() {
  const siteUrl=String(process.env.CONVEX_SITE_URL||DEFAULT_CONVEX_SITE_URL).replace(/\/$/,'');
  const token=String(process.env.CONVEX_INGEST_TOKEN||'');
  if(!token) throw new Error('CONVEX_INGEST_TOKEN missing');
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),4000);
  try{
    const response=await fetch(siteUrl+'/marginpad-btc-liquidations?limit=400',{headers:{accept:'application/json',authorization:'Bearer '+token,'cache-control':'no-cache'},signal:controller.signal});
    const json=await response.json();
    if(!response.ok||json?.ok===false) throw new Error('Convex MarginPad proxy HTTP '+response.status+': '+(json?.error||'unknown'));
    console.log('Convex proxy: events='+(json.events||[]).length+' live='+(json.liveEvents??'n/a')+' feed='+(json.feedEvents??'n/a')+' liveError='+JSON.stringify(json.liveError)+' feedError='+JSON.stringify(json.feedError));
    return Array.isArray(json.events)?json.events:[];
  }finally{clearTimeout(timeout);}
}
async function fetchMarginPadSources() {
  const promises=[
    ['convex',fetchViaConvexProxy()],
    ['live-direct',fetchMarginPadDirect('https://marginpad.io/api/v1/liquidations/live?symbol=BTC&limit=400',2500)],
    ['feed-direct',fetchMarginPadDirect('https://marginpad.io/api/v1/feed',2500)]
  ];
  const settled=await Promise.allSettled(promises.map(x=>x[1]));
  const merged=new Map();
  for(let i=0;i<settled.length;i++){
    const name=promises[i][0], result=settled[i];
    if(result.status!=='fulfilled'){console.warn('MarginPad source '+name+' failed: '+(result.reason?.message||result.reason));continue;}
    const events=name==='convex'?result.value:extractMarginPadEvents(result.value);
    console.log('MarginPad source '+name+': events='+events.length);
    for(const event of events){
      const symbol=normalizeSymbol(event?.symbol??event?.market??event?.pair);
      if(!symbol||symbol==='BTC') merged.set(eventKey(event),event);
    }
  }
  return [...merged.values()];
}
function directionOf(event) {
  const fields = [
    event?.side,
    event?.direction,
    event?.liquidation_side,
    event?.liquidationSide,
    event?.type,
    event?.action,
    event?.positionSide,
    event?.position_side,
    event?.orderSide,
    event?.order_side
  ].map(value => String(value ?? '').trim().toLowerCase()).filter(Boolean);
  for (const side of fields) {
    if (/(^|[_ -])(long|buy|bid)([_ -]|$)/.test(side) || side.includes('long_liquidation') || side.includes('buy_liquidation')) return 'LONG';
    if (/(^|[_ -])(short|sell|ask)([_ -]|$)/.test(side) || side.includes('short_liquidation') || side.includes('sell_liquidation')) return 'SHORT';
  }
  return null;
}
function eventTime(event) {
  return normalizeTs(event?.ts ?? event?.timestamp ?? event?.time ?? event?.createdAt ?? event?.created_at);
}
function eventKey(event) {
  return [eventTime(event), event?.exchange, normalizeSymbol(event?.symbol), event?.side, event?.price, event?.qty, event?.notional].join('|');
}

async function convexRuntimeRequest(type, data) {
  const siteUrl = String(process.env.CONVEX_SITE_URL || DEFAULT_CONVEX_SITE_URL).replace(/\/$/, '');
  const token = String(process.env.CONVEX_INGEST_TOKEN || '');
  if (!token) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(siteUrl + '/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ type, data }),
      signal: controller.signal
    });
  } catch (error) {
    console.warn('Convex runtime log failed: ' + error.message);
  } finally {
    clearTimeout(timeout);
  }
}

const RUNTIME_RUN_ID = Number(process.env.GITHUB_RUN_ID || Date.now());
const RUNTIME_GITHUB_RUN_ID = String(process.env.GITHUB_RUN_ID || RUNTIME_RUN_ID);
const RUNTIME_COMMIT_SHA = String(process.env.GITHUB_SHA || 'unknown');

async function startConvexRuntime() {
  await convexRuntimeRequest('runtime.start', {
    runId: RUNTIME_RUN_ID,
    githubRunId: RUNTIME_GITHUB_RUN_ID,
    commitSha: RUNTIME_COMMIT_SHA,
    startedAt: Date.now()
  });
}

async function logConvexRuntime(level, message) {
  await convexRuntimeRequest('runtime.log', {
    runId: RUNTIME_RUN_ID,
    level,
    message,
    ts: Date.now()
  });
}

async function heartbeatConvexRuntime() {
  await convexRuntimeRequest('runtime.heartbeat', {
    runId: RUNTIME_RUN_ID,
    heartbeatAt: Date.now()
  });
}

async function saveLiquidationToConvex(event, direction) {
  const siteUrl = String(process.env.CONVEX_SITE_URL || DEFAULT_CONVEX_SITE_URL).replace(/\/$/, '');
  const token = String(process.env.CONVEX_INGEST_TOKEN || '');
  if (!token) {
    console.warn('Convex liquidation logging skipped: CONVEX_INGEST_TOKEN missing');
    return;
  }
  const eventId = eventKey(event);
  const now = Date.now();
  const payload = {
    type: 'liquidation.event',
    data: {
      eventId,
      symbol: normalizeSymbol(event?.symbol),
      ts: eventTime(event),
      exchange: event?.exchange == null ? undefined : String(event.exchange),
      side: event?.side == null ? undefined : String(event.side),
      direction: direction || undefined,
      price: Number.isFinite(Number(event?.price)) ? Number(event.price) : undefined,
      qty: Number.isFinite(Number(event?.qty)) ? Number(event.qty) : undefined,
      notional: Number.isFinite(Number(event?.notional)) ? Number(event.notional) : undefined,
      firstSeenAt: now,
      lastSeenAt: now
    }
  };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    let response;
    try {
      response = await fetch(siteUrl + '/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) throw new Error('HTTP ' + response.status);
    console.log('Convex liquidation recorded: eventId=' + eventId);
  } catch (error) {
    console.warn('Convex liquidation logging failed: ' + error.message);
  }
}

async function getClobPriceLine(periodStart) {
  const fallback = 'CLOB PRICE: n/a';
  const marketUrl = 'https://polymarket.com/event/btc-updown-5m-' + Math.floor(periodStart / 1000);
  try {
    const result = await Promise.race([
      (async () => {
        const market = await findCurrentMarket(SYMBOL, Date.now(), '5m');
        const url = market?.url || marketUrl;
        const [upMid, downMid] = await Promise.all([findClobMidpoint(market, 'UP'), findClobMidpoint(market, 'DOWN')]);
        let cheaper = null;
        if (Number.isFinite(upMid) && Number.isFinite(downMid)) cheaper = upMid <= downMid ? { outcome: 'UP', price: upMid } : { outcome: 'DOWN', price: downMid };
        else if (Number.isFinite(upMid)) cheaper = { outcome: 'UP', price: upMid };
        else if (Number.isFinite(downMid)) cheaper = { outcome: 'DOWN', price: downMid };
        return {
          line: cheaper ? 'CLOB PRICE: ' + cheaper.outcome + ' ' + cheaper.price.toFixed(2) : fallback,
          url
        };
      })(),
      new Promise(resolve => setTimeout(() => resolve(null), 500))
    ]);
    return result || { line: fallback, url: marketUrl };
  } catch (error) {
    console.warn('Polymarket lookup failed, continuing liquidation alert: ' + error.message);
    return { line: fallback, url: marketUrl };
  }
}

async function sendFirstLiquidation(event, periodStart) {
  const direction = directionOf(event);
  if (!direction) return false;
  const { line: clobLine, url: marketUrl } = await getClobPriceLine(periodStart);
  const text = ['🔥 BTC · LIQUIDATION', '', 'DIRECTION: ' + direction, clobLine, '', '➡️ CURRENT · Polymarket 5M', marketUrl].join('\n');
  console.log('Sending Telegram liquidation alert: direction=' + direction + ' text=' + JSON.stringify(text));
  const result = await Promise.race([
    sendTelegramMessage(text),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Telegram send timeout after 4000ms')), 4000))
  ]);
  console.log('Telegram liquidation alert sent: message_id=' + (result?.message_id ?? 'unknown'));
  return true;
}

async function main() {
  const startedAt = Date.now();
  const seen = new Set();
  // Convex runtime logging is best-effort; the monitor must not depend on it.\n  void startConvexRuntime().catch(error => console.warn('Convex runtime start failed: ' + error.message));
  void logConvexRuntime('info', 'MarginPad BTC monitor started; polling Convex MarginPad proxy every 3000ms').catch(error => console.warn('Convex startup log failed: ' + error.message));

  while (Date.now() - startedAt < RUN_MS) {
    const now = Date.now();
    try {
      const pollStartedAt = Date.now();
      void heartbeatConvexRuntime().catch(error => console.warn('Convex heartbeat failed: ' + error.message));
      let events;
      try {
        events = await fetchMarginPadSources();
      } catch (error) {
        void logConvexRuntime('error', 'MarginPad poll error: ' + error.message);
        throw error;
      }
      void logConvexRuntime('info', 'MarginPad poll completed in ' + (Date.now() - pollStartedAt) + 'ms; returned=' + (events || []).length);
      const rows = (events || [])
        .map(event => ({ event, ts: eventTime(event), direction: directionOf(event) }))
        .filter(row => row.ts && row.ts <= now)
        .sort((a, b) => b.ts - a.ts);

      const newest = rows[0] || null;
      console.log('MarginPad BTC POLL: rows=' + rows.length +
        ' newest_ts=' + (newest?.ts ? new Date(newest.ts).toISOString() : 'n/a') +
        ' newest_age_ms=' + (newest?.ts ? Math.max(0, now - newest.ts) : 'n/a') +
        ' newest_side=' + JSON.stringify(newest?.event?.side ?? null) +
        ' newest_direction=' + JSON.stringify(newest?.direction ?? null));
      console.log('MarginPad LIVE BTC: events=' + rows.length + ' sides=' + JSON.stringify(rows.slice(0, 10).map(row => ({
        ts: row.ts, side: row.event?.side, direction: row.direction, price: row.event?.price, qty: row.event?.qty, notional: row.event?.notional
      }))));
      const directional = rows.filter(row => row.direction);
      console.log('MarginPad BTC DIRECTIONAL: ' + directional.length + '/' + rows.length);
      console.log('MarginPad BTC SIDES: ' + JSON.stringify([...new Set(rows.slice(0, 50).map(row => row.event?.side ?? row.event?.direction ?? row.event?.type ?? row.event?.action ?? null))]));
      console.log('MarginPad BTC SUMMARY: returned=' + (events || []).length + ' usable=' + rows.length + ' directional=' + directional.length + ' newest_age_sec=' + (newest?.ts ? Math.max(0, now - newest.ts) / 1000 : 'n/a'));
      if (rows.length === 0) {
        console.log('MarginPad BTC EMPTY: live + feed returned no usable BTC events on this poll');
        void logConvexRuntime('warn', 'MarginPad BTC poll returned 0 usable BTC events');
      } else {
        void logConvexRuntime('info', 'MarginPad BTC rows=' + rows.length + ' newest_ts=' + new Date(rows[0].ts).toISOString() + ' newest_side=' + JSON.stringify(rows[0].event?.side));
        if (!directional.length) console.log('MarginPad BTC NO_DIRECTION: BTC events received but side/direction was not recognized');
      }

      for (const row of directional) {
        const key = eventKey(row.event);
        if (seen.has(key)) continue;
        seen.add(key);
        console.log('MarginPad BTC NEW LIQUIDATION: ts=' + new Date(row.ts).toISOString() + ' side=' + JSON.stringify(row.event?.side) + ' direction=' + row.direction + ' period=' + new Date(bucketStart(row.ts)).toISOString());
        try {
          await sendFirstLiquidation(row.event, bucketStart(row.ts));
        } catch (error) {
          console.error('BTC liquidation alert send failed: ' + error.message);
        }
      }

      for (const row of rows) void saveLiquidationToConvex(row.event, row.direction);
    } catch (error) {
      console.warn('MarginPad poll failed: ' + error.message);
    }

    const remaining = RUN_MS - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(FEED_POLL_MS, remaining));
  }
  void logConvexRuntime('info', 'MarginPad BTC monitor finished');
  void convexRuntimeRequest('runtime.finish', { runId: RUNTIME_RUN_ID, finishedAt: Date.now(), status: 'completed', exitCode: null });
  setTimeout(() => process.exit(0), 250);

}

main().catch(async error => {
  void logConvexRuntime('error', 'MarginPad BTC monitor fatal error: ' + error.message);
  void convexRuntimeRequest('runtime.finish', { runId: RUNTIME_RUN_ID, finishedAt: Date.now(), status: 'failed', exitCode: 1 });
  console.error(error);
  process.exitCode = 1;
});
