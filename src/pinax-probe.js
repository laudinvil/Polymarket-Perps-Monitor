const PINAX_API_KEY = process.env.PINAX_API_KEY || process.env.PINAX_API_TOKEN;
const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];

if (!PINAX_API_KEY) throw new Error('PINAX_API_KEY/PINAX_API_TOKEN is not configured');

async function probe(coin) {
  const url = new URL(PINAX_URL);
  url.searchParams.set('coin', coin);
  url.searchParams.set('dex', 'perps');
  url.searchParams.set('sort_by', 'time');
  url.searchParams.set('limit', '10');
  url.searchParams.set('page', '1');
  console.log(`[PROBE][REQUEST] ${coin} ${url.toString().replace(PINAX_API_KEY, '***')}`);
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${PINAX_API_KEY}`, Accept: 'application/json' }
  });
  const raw = await response.text();
  console.log(`[PROBE][HTTP] ${coin} status=${response.status}`);
  if (!response.ok) {
    console.log(`[PROBE][ERROR] ${coin} ${raw.slice(0, 1000)}`);
    return;
  }
  let body;
  try { body = JSON.parse(raw); } catch {
    console.log(`[PROBE][NON_JSON] ${coin} ${raw.slice(0, 1000)}`);
    return;
  }
  const rows = Array.isArray(body?.data) ? body.data : [];
  console.log(`[PROBE][RESPONSE] ${coin} rows=${rows.length} keys=${rows[0] ? Object.keys(rows[0]).join(',') : 'none'}`);
  if (rows[0]) console.log(`[PROBE][SAMPLE] ${coin} ${JSON.stringify(rows[0]).slice(0, 2000)}`);
  else console.log(`[PROBE][BODY_KEYS] ${coin} ${Object.keys(body || {}).join(',')}`);
}

console.log('=== PINAX UNFILTERED LIQUIDATION PROBE ===');
console.log('Test: coin + dex + sort_by + limit=10 + page=1, WITHOUT start_time/end_time');
await Promise.all(ASSETS.map(probe));
console.log('=== PINAX PROBE COMPLETE ===');
