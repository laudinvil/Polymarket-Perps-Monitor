const configuredUrl = String(process.env.CONVEX_URL || '').trim().replace(/\/$/, '');
const baseUrl = configuredUrl.replace(/\.convex\.cloud$/i, '.convex.site');
const token = String(process.env.CONVEX_INGEST_TOKEN || '').trim();
const timeframe = String(process.argv[2] || '').trim();

if (!baseUrl || !token) {
  console.error('CONVEX_URL or CONVEX_INGEST_TOKEN is missing');
  process.exit(1);
}

if (!['5m', '15m', '1h', '4h'].includes(timeframe)) {
  console.error('Usage: node scripts/convex-stats.js 5m|15m|1h|4h');
  process.exit(1);
}

async function main() {
  const response = await fetch(`${baseUrl}/latest-stats?timeframe=${encodeURIComponent(timeframe)}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Convex stats failed: ${response.status}${body ? ` ${body.slice(0, 300)}` : ''}`);
  }

  const rows = await response.json();
  const money = value => `${Number(value) >= 0 ? '+' : '-'}$${Math.round(Math.abs(Number(value) || 0)).toLocaleString('en-US')}`;
  const plainMoney = value => `$${Math.round(Math.abs(Number(value) || 0)).toLocaleString('en-US')}`;
  const signal = value => Number(value) > 0 ? 'BUY UP' : Number(value) < 0 ? 'BUY DOWN' : 'NEUTRAL';

  console.log(`CONVEX STATS ${timeframe}`);
  console.log('Symbol | Imbalance | Long | Short | Long events | Short events | Signal');
  console.log('---|---:|---:|---:|---:|---:|---');
  for (const row of rows) {
    console.log(`${row.symbol} | ${money(row.imbalanceUsd)} | ${plainMoney(row.longUsd)} | ${plainMoney(row.shortUsd)} | ${row.longEvents} | ${row.shortEvents} | ${signal(row.imbalanceUsd)}`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
