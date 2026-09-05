const { fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey, WINDOW_MS } = require('./liquidation-monitor');
const { findCurrentMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

// 5M LIQUIDATION LEADER: all supported coins.
// Alert only when exactly 1 LONG and 0 SHORT, or exactly 1 SHORT and 0 LONG.
const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_MS_5M = WINDOW_MS;
const sentAlerts = new Set();

function formatUtcPlus3(ms) { return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function checkOnce(boundary) {
  const currentBucket = boundary;
  const closedBucket = currentBucket - WINDOW_MS_5M;
  const results = await Promise.all(symbols.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol, fetch)]; }
    catch (error) { console.warn(`MarginPad live ${symbol}: ${error.message}`); return [symbol, []]; }
  }));

  const allowed = new Set(symbols.map(normalizeSymbol));
  const rows = new Map();
  const diagnostics = [];

  for (const [requestedSymbol, events] of results) {
    const normalizedRequested = normalizeSymbol(requestedSymbol);
    const seen = new Set();
    let bucketValid = 0;
    let longBucket = 0;
    let shortBucket = 0;

    for (const event of events) {
      const ts = normalizeTs(event.ts);
      const symbol = normalizeSymbol(event.symbol);
      const side = String(event.side || '').toLowerCase();
      if (!ts || !allowed.has(symbol) || !(side.includes('long') || side.includes('short') || side === 'buy' || side === 'sell')) continue;
      if (bucketStart(ts) !== closedBucket) continue;
      const key = eventKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      bucketValid++;
      if (side.includes('long') || side === 'buy') longBucket++;
      else shortBucket++;
    }

    rows.set(normalizedRequested, { long: longBucket, short: shortBucket, total: bucketValid });
    diagnostics.push({ symbol: normalizedRequested, received: Array.isArray(events) ? events.length : 0, closed5m: bucketValid, long: longBucket, short: shortBucket });
  }

  console.log(JSON.stringify({ type: 'liquidation_5m_feed_diagnostics', boundary: new Date(currentBucket).toISOString(), closedBucket: new Date(closedBucket).toISOString(), symbols: diagnostics }));

  const candidates = symbols.map(normalizeSymbol).map(symbol => {
    const row = rows.get(symbol) || { long: 0, short: 0, total: 0 };
    return { symbol, ...row };
  }).filter(row =>
    (row.long === 1 && row.short === 0) ||
    (row.short === 1 && row.long === 0)
  );

  if (!candidates.length) {
    console.log(JSON.stringify({ type: 'liquidation_5m_no_alert', closedBucket: new Date(closedBucket).toISOString(), condition: 'exactly_1_LONG_or_exactly_1_SHORT_with_opposite_0', alertSent: false }));
    return;
  }

  for (const candidate of candidates) {
    const winnerSide = candidate.long === 1 ? 'long' : 'short';
    const winnerCount = 1;
    const alertKey = `5m:${closedBucket}:${candidate.symbol}:${winnerSide}`;
    if (sentAlerts.has(alertKey)) continue;

    const currentMarket = await findCurrentMarket(candidate.symbol, currentBucket);
    const directionEmoji = winnerSide === 'long' ? '🔴' : '🟢';
    const message = [
      `${directionEmoji} LIQUIDATION LEADER`,
      `${candidate.symbol} · 5M · ${formatUtcPlus3(closedBucket)} UTC+3`, '',
      `Leader: ${winnerSide.toUpperCase()} · ${winnerCount} liquidation`,
      `Long: ${candidate.long} · Short: ${candidate.short}`,
      `Total: ${candidate.total}`,
      '',
      '➡️ NEXT Polymarket 5M',
      currentMarket?.url || 'Market not found yet',
    ].join('\n');

    await sendTelegramMessage(message);
    sentAlerts.add(alertKey);
    console.log(JSON.stringify({ type: 'liquidation_5m_direction_winner', boundary: new Date(currentBucket).toISOString(), closedBucket: new Date(closedBucket).toISOString(), symbol: candidate.symbol, leaderSide: winnerSide, leaderCount: winnerCount, liquidations: candidate.total, longCount: candidate.long, shortCount: candidate.short, condition: 'exactly_1_LONG_or_exactly_1_SHORT_with_opposite_0', alertSent: true, nextMarket: currentMarket?.url || null, delayMs: Date.now() - currentBucket }));
  }
}

async function main() {
  console.log(`5M liquidation direction-leader monitor started; symbols=${symbols.join(',')}; EXACTLY 1 LONG or EXACTLY 1 SHORT; opposite=0; no period blocking; 15M disabled`);

  while (true) {
    const now = Date.now();
    const nextBoundary = bucketStart(now) + WINDOW_MS_5M;
    await sleep(Math.max(0, nextBoundary - Date.now()));
    try { await checkOnce(nextBoundary); }
    catch (error) { console.error(`MONITOR CYCLE FAILED: ${error.stack || error.message}`); }
  }
}

main().catch(error => { console.error(`MONITOR FAILED: ${error.stack || error.message}`); process.exitCode = 1; });
