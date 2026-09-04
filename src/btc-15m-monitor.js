const { fetchSymbolFeed, normalizeTs, normalizeSymbol, eventKey } = require('./liquidation-monitor');
const { sendTelegramMessage } = require('./telegram');
const { findCurrentMarket15m } = require('./polymarket');

const SYMBOL = 'BTC';
const WINDOW_MS_15M = 15 * 60 * 1000;
const MIN_LIQUIDATIONS_15M = 75;
const processedBuckets15m = new Set();
const sentAlerts15m = new Set();
let lastAlertBucket15m = null;

function bucketStart15m(ts) { return Math.floor(Number(ts) / WINDOW_MS_15M) * WINDOW_MS_15M; }
function formatUtcPlus3(ms) { return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16); }

async function check15mOnce(boundary) {
  const currentBucket = boundary;
  const closedBucket = currentBucket - WINDOW_MS_15M;
  const bucketKey = `15m:${closedBucket}`;
  if (processedBuckets15m.has(bucketKey)) return;

  let events = [];
  try { events = await fetchSymbolFeed(SYMBOL, fetch); }
  catch (error) { console.warn(`MarginPad 15m BTC: ${error.message}`); return; }

  let longCount = 0;
  let shortCount = 0;
  const seen = new Set();
  for (const event of events) {
    const ts = normalizeTs(event.ts);
    if (!ts || bucketStart15m(ts) !== closedBucket || normalizeSymbol(event.symbol) !== SYMBOL) continue;
    const side = String(event.side || '').toLowerCase();
    if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    if (side.includes('long') || side === 'buy') longCount += 1;
    else shortCount += 1;
  }

  processedBuckets15m.add(bucketKey);
  console.log(JSON.stringify({ type: 'liquidation_15m_btc_bucket', closedBucket: new Date(closedBucket).toISOString(), bucketLabelUtcPlus3: formatUtcPlus3(closedBucket), longCount, shortCount, total: longCount + shortCount, minThreshold: MIN_LIQUIDATIONS_15M, consecutiveAlertBlocked: lastAlertBucket15m !== null && closedBucket === lastAlertBucket15m + WINDOW_MS_15M }));

  const best = Math.max(longCount, shortCount);
  if (best < MIN_LIQUIDATIONS_15M || longCount === shortCount) return;
  if (lastAlertBucket15m !== null && closedBucket === lastAlertBucket15m + WINDOW_MS_15M) return;

  const side = longCount > shortCount ? 'long' : 'short';
  const count = side === 'long' ? longCount : shortCount;
  const alertKey = bucketKey;
  if (sentAlerts15m.has(alertKey)) return;

  const market = await findCurrentMarket15m(SYMBOL, currentBucket);
  const emoji = side === 'long' ? '🔴' : '🟢';
  const message = [
    `${emoji} BTC LIQUIDATION LEADER`,
    `BTC · 15M · ${formatUtcPlus3(closedBucket)} UTC+3`, '',
    `Leader: ${side.toUpperCase()} · ${count} liquidations`,
    `Long: ${longCount} · Short: ${shortCount}`,
    `Total: ${longCount + shortCount}`,
    '',
    '➡️ NEXT Polymarket 15M',
    market?.url || 'Market not found yet',
  ].join('\n');

  await sendTelegramMessage(message);
  sentAlerts15m.add(alertKey);
  lastAlertBucket15m = closedBucket;
  console.log(JSON.stringify({ type: 'liquidation_15m_btc', closedBucket: new Date(closedBucket).toISOString(), longCount, shortCount, leader: side, leaderCount: count, min: MIN_LIQUIDATIONS_15M, consecutiveAlertBlocked: false, alertSent: true, nextMarket: market?.url || null, delayMs: Date.now()-currentBucket }));
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main15m() {
  console.log(`BTC 15M liquidation monitor started; min=${MIN_LIQUIDATIONS_15M}; exact boundary scheduling; consecutive alerts blocked`);
  while (true) {
    const now = Date.now();
    const nextBoundary = bucketStart15m(now) + WINDOW_MS_15M;
    await sleep(Math.max(0, nextBoundary - Date.now()));
    try { await check15mOnce(nextBoundary); } catch (error) { console.error(`15M BTC monitor failed: ${error.stack || error.message}`); }
  }
}

main15m().catch(error => { console.error(`15M BTC monitor fatal: ${error.stack || error.message}`); process.exitCode = 1; });
