const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const BASE = 'https://marginpad.io/api/v1/clusters';

function summarizeClusters(payload) {
  const clusters = payload?.data?.clusters ?? payload?.clusters ?? [];
  const arr = Array.isArray(clusters) ? clusters : [];
  const notionals = arr
    .map((x) => Number(x?.est_notional))
    .filter(Number.isFinite);
  const longCount = arr.filter((x) => String(x?.side || '').toLowerCase() === 'long').length;
  const shortCount = arr.filter((x) => String(x?.side || '').toLowerCase() === 'short').length;
  return {
    count: arr.length,
    longCount,
    shortCount,
    minEstNotional: notionals.length ? Math.min(...notionals) : null,
    maxEstNotional: notionals.length ? Math.max(...notionals) : null,
    keys: arr[0] ? Object.keys(arr[0]) : [],
  };
}

async function fetchOne(symbol) {
  const url = `${BASE}?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Polymarket-Perps-Monitor/1.0',
    },
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${symbol}: HTTP ${res.status}; non-JSON body: ${text.slice(0, 500)}`);
  }

  return { symbol, url, status: res.status, ok: res.ok, json };
}

async function main() {
  console.log(`MarginPad clusters diagnostic`);
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Time: ${new Date().toISOString()}`);

  for (const symbol of SYMBOLS) {
    console.log(`\n===== ${symbol} =====`);
    try {
      const result = await fetchOne(symbol);
      const summary = summarizeClusters(result.json);
      console.log(`HTTP: ${result.status}`);
      console.log(`Cluster count: ${summary.count}`);
      console.log(`Long clusters: ${summary.longCount}`);
      console.log(`Short clusters: ${summary.shortCount}`);
      console.log(`Cluster object keys: ${summary.keys.join(', ') || 'NONE'}`);
      console.log(`Min est_notional: ${summary.minEstNotional ?? 'N/A'}`);
      console.log(`Max est_notional: ${summary.maxEstNotional ?? 'N/A'}`);
      console.log('RAW JSON:');
      console.log(JSON.stringify(result.json, null, 2));
    } catch (error) {
      console.error(`FAILED: ${error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(`CLUSTERS DIAGNOSTIC FAILED: ${error.stack || error.message}`);
  process.exit(1);
});
