const { fetchLiveSymbolFallback, normalizeTs, normalizeSymbol, bucketStart, POLL_MS } = require('../src/liquidation-monitor');
const { findCurrentMarket, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const SYMBOL = 'BTC';
const PERIOD_MS = 5 * 60 * 1000;
const RUN_MS = PERIOD_MS + 15 * 1000;
const FEED_POLL_MS = 1000;
const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL || 'https://brainy-canary-207.eu-west-1.convex.site';
const CONVEX_INGEST_TOKEN = process.env.CONVEX_INGEST_TOKEN || '';

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function directionOf(event) {
  const side = String(event?.side || event?.direction || '').toLowerCase();
  if (side.includes('long') || side === 'buy') return 'LONG';
  if (side.includes('short') || side === 'sell') return 'SHORT';
  return null;
}
function eventTime(event) { return normalizeTs(event?.ts); }
function eventKey(event) { return [eventTime(event), event?.exchange, normalizeSymbol(event?.symbol), event?.side, event?.price, event?.qty, event?.notional].join('|'); }
async function claimPeriod(periodStart) {
  if (!CONVEX_INGEST_TOKEN) return true;
  try {
    const response = await fetch(CONVEX_SITE_URL + '/claim-liquidation-alert', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + CONVEX_INGEST_TOKEN }, body: JSON.stringify({ symbol: SYMBOL, periodStart, sentAt: Date.now() }) });
    if (!response.ok) return true;
    const data = await response.json();
    return data.claimed === true;
  } catch (error) { console.warn('Convex liquidation claim failed: ' + error.message); return true; }
}
async function sendFirstLiquidation(event, periodStart) {
  const direction = directionOf(event);
  if (!direction) return false;
  let market = null;
  let marketUrl = 'https://polymarket.com/event/btc-updown-5m-' + Math.floor(periodStart / 1000);
  let upMid = null;
  let downMid = null;
  try {
    market = await findCurrentMarket(SYMBOL, Date.now(), '5m');
    marketUrl = market?.url || marketUrl;
    upMid = await findClobMidpoint(market, 'UP');
    downMid = await findClobMidpoint(market, 'DOWN');
  } catch (error) {
    console.warn('Polymarket lookup failed, sending liquidation alert without CLOB price: ' + error.message);
  }
  let cheaper = null;
  if (Number.isFinite(upMid) && Number.isFinite(downMid)) {
    cheaper = upMid <= downMid ? { outcome: 'UP', price: upMid } : { outcome: 'DOWN', price: downMid };
  } else if (Number.isFinite(upMid)) {
    cheaper = { outcome: 'UP', price: upMid };
  } else if (Number.isFinite(downMid)) {
    cheaper = { outcome: 'DOWN', price: downMid };
  }
  const clobLine = cheaper ? 'CLOB PRICE: ' + cheaper.outcome + ' ' + cheaper.price.toFixed(2) : 'CLOB PRICE: n/a';
  const text = ['🔥 BTC · LIQUIDATION', '', 'DIRECTION: ' + direction, clobLine, '', '➡️ CURRENT · Polymarket 5M', marketUrl].join('\n');
  await sendTelegramMessage(text);
  console.log('Alert sent: BTC ' + direction + ', period ' + new Date(periodStart).toISOString());
  return true;
}
async function main() {
  const startedAt = Date.now();
  const seen = new Set();
  let alertedPeriod = null;
  while (Date.now() - startedAt < RUN_MS) {
    const now = Date.now();
    const periodStart = bucketStart(now, '5m');
    try {
      const events = await fetchLiveSymbolFallback('BTC');
      const latest = [...(events || [])].sort((a, b) => (eventTime(b) || 0) - (eventTime(a) || 0))[0];
      console.log('MarginPad LIVE BTC: events=' + (events?.length || 0));
      console.log('MarginPad BTC CURRENT PERIOD: ' + new Date(periodStart).toISOString() + ' -> ' + new Date(periodStart + PERIOD_MS).toISOString());
      if (latest) {
        const latestTs = eventTime(latest);
        console.log('MarginPad BTC LATEST: ts=' + (latestTs ? new Date(latestTs).toISOString() : 'invalid') +
          ' side=' + JSON.stringify(latest?.side) +
          ' direction=' + (directionOf(latest) || 'UNKNOWN') +
          ' price=' + latest?.price +
          ' qty=' + latest?.qty +
          ' notional=' + latest?.notional +
          ' inCurrentPeriod=' + (latestTs ? bucketStart(latestTs, '5m') === periodStart : false));
      } else {
        console.log('MarginPad BTC LATEST: n/a');
      }

      const current = (events || [])
        .map(event => ({ event, ts: eventTime(event), direction: directionOf(event) }))
        .filter(row => row.ts && bucketStart(row.ts, '5m') === periodStart)
        .sort((a, b) => b.ts - a.ts);

      const directional = current.filter(row => row.direction);
      console.log('MarginPad BTC MATCH: currentPeriodEvents=' + current.length + ' directional=' + directional.length);

      if (current.length && alertedPeriod !== periodStart) {
        const row = directional[0];
        if (!row) {
          console.warn('MarginPad BTC: current-period liquidation found, but side/direction is UNKNOWN; alert not sent.');
        } else {
          const key = eventKey(row.event);
          if (!seen.has(key)) {
            seen.add(key);
            if (await sendFirstLiquidation(row.event, periodStart)) alertedPeriod = periodStart;
          }
        }
      }
    } catch (error) { console.warn('MarginPad poll failed: ' + error.message); }
    const remaining = RUN_MS - (Date.now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(FEED_POLL_MS, remaining));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
