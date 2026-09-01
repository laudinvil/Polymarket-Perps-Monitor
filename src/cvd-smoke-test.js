const WebSocket = globalThis.WebSocket;
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const SAMPLE_MS = 30000;
const WS_URL = 'wss://api.hyperliquid.xyz/ws';

const totals = new Map(ASSETS.map(asset => [asset, { buyVolume: 0, sellVolume: 0, trades: 0 }]));
let ws;
let timer;
let received = false;
let finished = false;

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function printResults() {
  if (finished) return;
  finished = true;
  let failed = false;
  console.log('=== CVD SMOKE TEST ===');
  console.log(`sampleMs=${SAMPLE_MS}`);
  for (const asset of ASSETS) {
    const row = totals.get(asset);
    const cvd = row.buyVolume - row.sellVolume;
    const ok = row.trades > 0 && Number.isFinite(cvd);
    if (!ok) failed = true;
    console.log(JSON.stringify({ asset, buyVolume: row.buyVolume, sellVolume: row.sellVolume, cvd, trades: row.trades, check: ok ? 'PASS' : 'FAIL' }));
  }
  if (!received) {
    console.error('FAIL: no Hyperliquid trades received');
    process.exitCode = 1;
  } else if (failed) {
    process.exitCode = 1;
  } else {
    console.log('RESULT: PASS — buyVolume - sellVolume equals cvd for every active asset');
  }
  try { ws?.close(); } catch {}
}

ws = new WebSocket(WS_URL);
ws.addEventListener('open', () => {
  for (const coin of ASSETS) {
    ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
  }
  timer = setTimeout(printResults, SAMPLE_MS);
});
ws.addEventListener('message', event => {
  if (finished) return;
  try {
    const message = JSON.parse(String(event.data));
    if (message?.channel !== 'trades' || !Array.isArray(message?.data)) return;
    received = true;
    for (const trade of message.data) {
      const asset = String(trade?.coin || '');
      const row = totals.get(asset);
      if (!row) continue;
      const usd = num(trade?.px) * num(trade?.sz);
      if (usd <= 0) continue;
      if (String(trade?.side).toUpperCase() === 'B') row.buyVolume += usd;
      else row.sellVolume += usd;
      row.trades += 1;
    }
  } catch (error) {
    console.error('Parse error:', error?.message ?? error);
    process.exitCode = 1;
  }
});
ws.addEventListener('error', error => {
  if (finished) return;
  console.error('WebSocket error:', error?.message ?? error);
  clearTimeout(timer);
  process.exitCode = 1;
});
ws.addEventListener('close', () => {
  if (finished) return;
  if (timer) return;
  process.exitCode = 1;
});
