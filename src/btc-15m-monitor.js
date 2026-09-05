const { fetchSymbolFeed, normalizeTs, normalizeSymbol, eventKey } = require('./liquidation-monitor');
const { sendTelegramMessage } = require('./telegram');
const { findCurrentMarket15m } = require('./polymarket');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_MS_15M = 15 * 60 * 1000;
const processedBuckets15m = new Set();
const sentAlerts15m = new Set();

function bucketStart15m(ts) { return Math.floor(Number(ts) / WINDOW_MS_15M) * WINDOW_MS_15M; }
function formatUtcPlus3(ms) { return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16); }

async function check15mOnce(boundary) {
  const currentBucket = boundary;
  const closedBucket = currentBucket - WINDOW_MS_15M;
  const bucketKey = `15m:${closedBucket}`;
  if (processedBuckets15m.has(bucketKey)) return;

  const results = await Promise.all(SYMBOLS.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad 15m ${symbol}: ${error.message}`); return [symbol, []]; }
  }));

  const rows = new Map();
  const diagnostics = [];
  for (const [requestedSymbol, events] of results) {
    let longCount = 0;
    let shortCount = 0;
    let bucketEvents = 0;
    const seen = new Set();
    for (const event of events) {
      const ts = normalizeTs(event.ts);
      if (!ts || bucketStart15m(ts) !== closedBucket || normalizeSymbol(event.symbol) !== requestedSymbol) continue;
      const side = String(event.side || '').toLowerCase();
      if (!(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      bucketEvents++;
      if (side.includes('long') || side === 'buy') longCount++;
      else shortCount++;
    }
    rows.set(requestedSymbol, { longCount, shortCount, total: bucketEvents });
    diagnostics.push({ symbol: requestedSymbol, received: Array.isArray(events) ? events.length : 0, closed15m: bucketEvents, long: longCount, short: shortCount });
  }

  processedBuckets15m.add(bucketKey);
  console.log(JSON.stringify({ type: 'liquidation_15m_feed_diagnostics', boundary: new Date(currentBucket).toISOString(), closedBucket: new Date(closedBucket).toISOString(), symbols: diagnostics }));

  const candidates = SYMBOLS.map(symbol => {
    const row = rows.get(symbol) || { longCount: 0, shortCount: 0, total: 0 };
    return { symbol, ...row };
  }).filter(row => (row.longCount > 0 && row.shortCount === 0) || (row.shortCount > 0 && row.longCount === 0));

  if (!candidates.length) {
    console.log(JSON.stringify({ type: 'liquidation_15m_no_alert', closedBucket: new Date(closedBucket).toISOString(), condition: 'exactly_one_side_zero_and_other_side_positive', alertSent: false }));
    return;
  }

  // One alert per 15M bucket: select the strongest one-sided liquidation flow.
  const winner = candidates.sort((a, b) => b.total - a.total)[0];
  const winnerSide = winner.longCount > 0 ? 'long' : 'short';
  const winnerCount = winnerSide === 'long' ? winner.longCount : winner.shortCount;
  const alertKey = `15m:${closedBucket}`;
  if (sentAlerts15m.has(alertKey)) return;

  const market = await findCurrentMarket15m(winner.symbol, currentBucket);
  const emoji = winnerSide === 'long' ? '🔴' : '🟢';
  const message = [
    `${emoji} LIQUIDATION LEADER`,
    `${winner.symbol} · 15M · ${formatUtcPlus3(closedBucket)} UTC+3`, '',
    `Leader: ${winnerSide.toUpperCase()} · ${winnerCount} liquidations`,
    `Long: ${winner.longCount} · Short: ${winner.shortCount}`,
    `Total: ${winner.total}`,
    '',
    '➡️ NEXT Polymarket 15M',
    market?.url || 'Market not found yet',
  ].join('\n');

  await sendTelegramMessage(message);
  sentAlerts15m.add(alertKey);
  console.log(JSON.stringify({ type: 'liquidation_15m_direction_winner', closedBucket: new Date(closedBucket).toISOString(), symbol: winner.symbol, leaderSide: winnerSide, leaderCount: winnerCount, longCount: winner.longCount, shortCount: winner.shortCount, condition: 'exactly_one_side_zero_and_other_side_positive', alertSent: true, nextMarket: market?.url || null, delayMs: Date.now() - currentBucket }));
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function main15m() {
  console.log(`15M liquidation direction-leader monitor started; symbols=${SYMBOLS.join(',')}; no count thresholds; exactly one side must be zero`);
  while (true) {
    const now = Date.now();
    const nextBoundary = bucketStart15m(now) + WINDOW_MS_15M;
    await sleep(Math.max(0, nextBoundary - Date.now()));
    try { await check15mOnce(nextBoundary); }
    catch (error) { console.error(`15M liquidation monitor failed: ${error.stack || error.message}`); }
  }
}

main15m().catch(error => { console.error(`15M liquidation monitor fatal: ${error.stack || error.message}`); process.exitCode = 1; });
