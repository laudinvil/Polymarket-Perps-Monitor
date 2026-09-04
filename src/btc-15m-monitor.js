const { fetchSymbolFeed, normalizeTs, normalizeSymbol, eventKey } = require('./liquidation-monitor');
const { sendTelegramMessage } = require('./telegram');
const { findCurrentMarket15m } = require('./polymarket');

const SYMBOL = 'BTC';
const WINDOW_MS_15M = 15 * 60 * 1000;
const MIN_LIQUIDATIONS_15M = 10;
const MAX_LIQUIDATIONS_15M = 200;
const POLL_MS_15M = 15000;
const processedBuckets15m = new Set();
const sentAlerts15m = new Set();

function bucketStart15m(ts) { return Math.floor(Number(ts) / WINDOW_MS_15M) * WINDOW_MS_15M; }
function formatUtcPlus3(ms) { return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16); }

async function check15mOnce() {
  const now = Date.now();
  const currentBucket = bucketStart15m(now);
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
  const best = Math.max(longCount, shortCount);
  if (best < MIN_LIQUIDATIONS_15M || best > MAX_LIQUIDATIONS_15M || longCount === shortCount) return;

  const side = longCount > shortCount ? 'long' : 'short';
  const count = side === 'long' ? longCount : shortCount;
  const alertKey = bucketKey;
  if (sentAlerts15m.has(alertKey)) return;

  const market = await findCurrentMarket15m(SYMBOL, now);
  const emoji = side === 'long' ? '🔴' : '🟢';
  const message = [
    `${emoji} BTC LIQUIDATION LEADER`,
    `BTC · 15M · ${formatUtcPlus3(closedBucket)} UTC+3`, '',
    `Leader: ${side.toUpperCase()} · ${count} liquidations`,
    `Long: ${longCount} · Short: ${shortCount}`,
    `Total: ${longCount + shortCount}`,
    '',
    '➡️ Current Polymarket 15M',
    market?.url || 'Market not found yet',
  ].join('\n');

  await sendTelegramMessage(message);
  sentAlerts15m.add(alertKey);
  console.log(JSON.stringify({ type: 'liquidation_15m_btc', closedBucket: new Date(closedBucket).toISOString(), longCount, shortCount, leader: side, leaderCount: count, min: MIN_LIQUIDATIONS_15M, max: MAX_LIQUIDATIONS_15M, alertSent: true, currentMarket: market?.url || null }));
}

async function main15m() {
  console.log(`BTC 15M liquidation monitor started; min=${MIN_LIQUIDATIONS_15M}; max=${MAX_LIQUIDATIONS_15M}`);
  while (true) {
    try { await check15mOnce(); } catch (error) { console.error(`15M BTC monitor failed: ${error.stack || error.message}`); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS_15M));
  }
}

main15m().catch(error => { console.error(`15M BTC monitor fatal: ${error.stack || error.message}`); process.exitCode = 1; });
