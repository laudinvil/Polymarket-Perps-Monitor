const { findCurrentMarket, findCurrentMarket15m } = require('./polymarket');

// Bybit is blocked from the GitHub Actions runner's region. Use OKX public
// perpetual-swap OI instead. One request covers all 7 configured symbols.
const OI_URL = 'https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=BTC-USDT-SWAP,ETH-USDT-SWAP,SOL-USDT-SWAP,XRP-USDT-SWAP,DOGE-USDT-SWAP,BNB-USDT-SWAP,HYPE-USDT-SWAP';
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE']);

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function bucketStart(ms, windowMs) { return Math.floor(ms / windowMs) * windowMs; }
function formatUtcPlus3(ms) { return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16); }
function formatPct(value) { return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`; }
function formatUsd(value) { return value.toLocaleString('en-US', { maximumFractionDigits: 0 }); }

function normalizeSymbol(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (SYMBOLS.has(raw)) return raw;
  const base = raw.replace(/[-_/]/g, '').replace(/USDT$/, '').replace(/USD$/, '').replace(/SWAP$/, '');
  return SYMBOLS.has(base) ? base : '';
}

async function fetchOpenInterest() {
  const response = await fetch(OI_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error(`OKX OI returned non-JSON response: ${text.slice(0, 300)}`);
  }
  if (!response.ok) throw new Error(`OKX OI HTTP ${response.status}: ${text.slice(0, 300)}`);
  if (json?.code !== '0') throw new Error(`OKX OI code ${json?.code}: ${json?.msg || 'unknown error'}`);

  const rows = json?.data;
  if (!Array.isArray(rows)) throw new Error(`OKX OI response has no data array: ${JSON.stringify(json).slice(0, 500)}`);

  const snapshot = new Map();
  for (const row of rows) {
    const symbol = normalizeSymbol(row?.instId);
    const value = Number(row?.oiUsd);
    if (!symbol || !Number.isFinite(value)) continue;
    snapshot.set(symbol, value);
  }

  const missing = [...SYMBOLS].filter(symbol => !snapshot.has(symbol));
  if (missing.length) throw new Error(`OKX OI missing configured symbols: ${missing.join(',')}; received=${[...snapshot.keys()].join(',')}`);

  console.log(`OI snapshot received from OKX: ${[...snapshot.keys()].join(',')}`);
  return snapshot;
}

function largestChange(previous, current) {
  const candidates = [];
  for (const [symbol, currentOi] of current) {
    const previousOi = previous.get(symbol);
    if (!Number.isFinite(previousOi) || previousOi === 0) continue;
    const delta = currentOi - previousOi;
    const pct = (delta / previousOi) * 100;
    if (!Number.isFinite(pct) || pct === 0) continue;
    candidates.push({ symbol, previousOi, currentOi, delta, pct, absPct: Math.abs(pct) });
  }
  candidates.sort((a, b) => b.absPct - a.absPct);
  return candidates[0] || null;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Telegram secrets are missing');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: false }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
}

async function sendAlert(timeframe, previous, current, boundary) {
  const winner = largestChange(previous, current);
  if (!winner) {
    return console.log(JSON.stringify({ type: `open_interest_${timeframe}_no_change`, boundary: new Date(boundary).toISOString() }));
  }
  const market = timeframe === '5M'
    ? await findCurrentMarket(winner.symbol, boundary)
    : await findCurrentMarket15m(winner.symbol, boundary);
  const direction = winner.pct > 0 ? 'POSITIVE' : 'NEGATIVE';
  const emoji = winner.pct > 0 ? '🟢' : '🔴';
  const message = [
    `${emoji} OPEN INTEREST LEADER`,
    `${winner.symbol} · OI · ${timeframe} · ${formatUtcPlus3(boundary)} UTC+3`,
    '',
    `Change: ${direction}`,
    `OI change: ${formatPct(winner.pct)}`,
    `OI delta: ${winner.delta > 0 ? '+' : ''}${formatUsd(winner.delta)} USD`,
    `Previous OI: ${formatUsd(winner.previousOi)} USD`,
    `Current OI: ${formatUsd(winner.currentOi)} USD`,
    '',
    `➡️ NEXT Polymarket ${timeframe}`,
    market?.url || 'Market not found yet',
  ].join('\n');
  await sendTelegram(message);
  console.log(JSON.stringify({
    type: `open_interest_${timeframe.toLowerCase()}_alert`,
    boundary: new Date(boundary).toISOString(),
    symbol: winner.symbol,
    direction,
    pct: winner.pct,
    delta: winner.delta,
    previousOi: winner.previousOi,
    currentOi: winner.currentOi,
    market: market?.url || null,
  }));
}

async function main() {
  console.log('Open Interest monitor started; source=OKX USDT perpetual swaps; symbols=BTC,ETH,SOL,XRP,DOGE,BNB,HYPE; 5M + 15M; largest absolute OI percentage change; exact boundary scheduling');
  const snapshots = new Map();
  let nextBoundary = bucketStart(Date.now(), WINDOW_5M) + WINDOW_5M;

  while (true) {
    await sleep(Math.max(0, nextBoundary - Date.now()));
    const boundary = nextBoundary;
    try {
      const currentSnapshot = await fetchOpenInterest();
      snapshots.set(boundary, currentSnapshot);

      const previous5m = snapshots.get(boundary - WINDOW_5M);
      if (previous5m) await sendAlert('5M', previous5m, currentSnapshot, boundary);
      else console.log(JSON.stringify({ type: 'open_interest_5m_waiting_for_baseline', boundary: new Date(boundary).toISOString(), symbols: [...currentSnapshot.keys()] }));

      const previous15m = snapshots.get(boundary - WINDOW_15M);
      if (previous15m) await sendAlert('15M', previous15m, currentSnapshot, boundary);

      for (const key of snapshots.keys()) if (key < boundary - WINDOW_15M) snapshots.delete(key);
      console.log(JSON.stringify({ type: 'open_interest_cycle', boundary: new Date(boundary).toISOString(), symbols: [...currentSnapshot.keys()] }));
    } catch (error) {
      console.error(`OPEN INTEREST CYCLE FAILED: ${error.stack || error.message}`);
    }

    nextBoundary += WINDOW_5M;
    if (nextBoundary <= Date.now()) nextBoundary = bucketStart(Date.now(), WINDOW_5M) + WINDOW_5M;
  }
}

main().catch(error => {
  console.error(`OPEN INTEREST MONITOR FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
