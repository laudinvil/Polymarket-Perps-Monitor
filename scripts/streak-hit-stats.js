const convexUrl = process.env.CONVEX_URL;
if (!convexUrl) throw new Error('CONVEX_URL is required');

const base = convexUrl.replace(/\/$/, '');
const url = `${base}/streak-hit/periods?symbol=BTC&limit=100`;

const response = await fetch(url);
if (!response.ok) throw new Error(`Convex HTTP ${response.status}`);
const payload = await response.json();
const periods = Array.isArray(payload) ? payload : (payload.periods || []);

const byTimeframe = new Map();
for (const row of periods) {
  const tf = row.timeframe || 'unknown';
  if (!byTimeframe.has(tf)) byTimeframe.set(tf, []);
  byTimeframe.get(tf).push(row);
}

const thresholds = { '5m': 8, '15m': 7, '1h': 6, '4h': 5, '24h': 4 };
console.log(JSON.stringify({
  fetchedAt: new Date().toISOString(),
  total: periods.length,
  periods: periods.slice(0, 50),
  streaks: Object.fromEntries([...byTimeframe.entries()].map(([tf, rows]) => ({
    [tf]: {
      threshold: thresholds[tf] ?? null,
      latest: rows.slice(0, 20).map(r => ({
        periodStart: r.periodStart,
        periodEnd: r.periodEnd,
        result: r.result,
        streak: r.streak,
        direction: r.direction,
        isHit: r.isHit,
        isContinuation: r.isContinuation
      }))
    }
  })))
}, null, 2));
