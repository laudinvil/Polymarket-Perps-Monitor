const BINANCE_OI_URL = 'https://fapi.binance.com/fapi/v1/openInterest';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];

export async function getOIStatus() {
  const checkedAt = new Date().toISOString();
  const results = await Promise.all(ASSETS.map(async asset => {
    const symbol = `${asset}USDT`;
    const started = Date.now();
    try {
      const response = await fetch(`${BINANCE_OI_URL}?symbol=${symbol}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const oi = Number(data.openInterest);
      if (!Number.isFinite(oi)) throw new Error('invalid openInterest');
      return { asset, symbol, oi, timestamp: data.time ?? null, ageMs: data.time ? Math.max(0, Date.now() - Number(data.time)) : null, latencyMs: Date.now() - started, status: 'OK' };
    } catch (error) {
      return { asset, symbol, oi: null, timestamp: null, ageMs: null, latencyMs: Date.now() - started, status: 'ERROR', error: error?.message ?? String(error) };
    }
  }));
  return { ok: results.every(x => x.status === 'OK'), source: 'Binance Futures Open Interest', checkedAt, thresholdPct: 0.05, count: results.length, results };
}
