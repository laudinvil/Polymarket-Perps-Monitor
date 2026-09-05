const { findCurrentMarket, findCurrentMarket15m } = require('./polymarket');

const OI_URL = 'https://marginpad.io/api/v1/open-interest';
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const SYMBOLS = new Set(['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE']);

// Completely separate strategy: this monitor does not use liquidation data or state.
// Only the seven configured coins are considered. At each exact 5m boundary it compares
// adjacent snapshots; 15m compares snapshots exactly 15 minutes apart.
// The winner is the coin with the largest absolute USD change in OI.

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bucketStart(ms, windowMs) {
  return Math.floor(ms / windowMs) * windowMs;
}

function formatUtcPlus3(ms) {
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

function formatUsd(value) {
  return value.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function normalizeSymbol(value) {
  const raw = String(value ?? '').trim().toUpperCase();
  if (SYMBOLS.has(raw)) return raw;

  // Accept common exchange/API variants such as BTCUSDT, BTC-USDT and BTC/USDT.
  const base = raw
    .replace(/[-_/]/g, '')
    .replace(/USDT$/, '')
    .replace(/USD$/, '');
  return SYMBOLS.has(base) ? base : '';
}

function numericOi(row) {
  if (typeof row === 'number' || typeof row === 'string') {
    const value = Number(row);
    return Number.isFinite(value) ? value : NaN;
  }

  if (!row || typeof row !== 'object') return NaN;

  // MarginPad documents OI as USD. Support the documented/common field variants
  // so a harmless API field-name change cannot make the monitor silently blind.
  const fields = [
    'openInterestUsd',
    'open_interest_usd',
    'openInterestUSD',
    'oiUsd',
    'oi_usd',
    'valueUsd',
    'value_usd',
    'notionalUsd',
    'notional_usd',
    'openInterest',
    'open_interest',
    'oi',
    'value',
  ];

  for (const field of fields) {
    if (row[field] === undefined || row[field] === null) continue;
    const value = Number(row[field]);
    if (Number.isFinite(value)) return value;
  }

  return NaN;
}

function collectRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];

  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.openInterest)) return payload.openInterest;
  if (Array.isArray(payload.open_interest)) return payload.open_interest;
  if (Array.isArray(payload.items)) return payload.items;

  // Some APIs return a symbol-keyed object instead of rows, e.g.
  // { BTC: {...}, ETH: {...} } or { BTC: 123456789, ETH: 987654321 }.
  return Object.entries(payload).map(([symbol, value]) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return { symbol, ...value };
    }
    return { symbol, value };
  });
}

async function fetchOpenInterest() {
  const response = await fetch(OI_URL, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`MarginPad OI returned non-JSON response: ${text.slice(0, 200)}`);
  }

  if (!response.ok) {
    throw new Error(`MarginPad OI HTTP ${response.status}: ${json?.error?.message || text.slice(0, 200)}`);
  }
  if (json?.ok === false) throw new Error(json?.error?.message || 'MarginPad OI returned an error');

  const payload = json?.data ?? json;
  const rows = collectRows(payload);
  const snapshot = new Map();

  for (const row of rows) {
    const symbol = normalizeSymbol(row?.symbol || row?.ticker || row?.base || row?.asset);
    const value = numericOi(row);
    if (!symbol || !Number.isFinite(value)) continue;
    snapshot.set(symbol, value);
  }

  if (!snapshot.size) {
    const sampleKeys = rows.slice(0, 3).map(row =>
      row && typeof row === 'object' ? Object.keys(row).slice(0, 12) : typeof row
    );
    throw new Error(`MarginPad OI response contained no configured symbols; rows=${rows.length}; sampleKeys=${JSON.stringify(sampleKeys)}`);
  }

  return snapshot;
}

function largestChange(previous, current) {
  const candidates = [];
  for (const [symbol, currentOi] of current) {
    const previousOi = previous.get(symbol);
    if (!Number.isFinite(previousOi)) continue;
    const delta = currentOi - previousOi;
    if (!Number.isFinite(delta) || delta === 0) continue;
    candidates.push({ symbol, previousOi, currentOi, delta, absDelta: Math.abs(delta) });
  }
  candidates.sort((a, b) => b.absDelta - a.absDelta);
  return candidates[0] || null;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Telegram secrets are missing');
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: false })
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
}

async function sendAlert(timeframe, previous, current, boundary) {
  const winner = largestChange(previous, current);
  if (!winner) {
    console.log(JSON.stringify({ type: `open_interest_${timeframe}_no_change`, boundary: new Date(boundary).toISOString(), symbols: [...SYMBOLS] }));
    return;
  }

  const market = timeframe === '5M'
    ? await findCurrentMarket(winner.symbol, boundary)
    : await findCurrentMarket15m(winner.symbol, boundary);

  const direction = winner.delta > 0 ? 'POSITIVE' : 'NEGATIVE';
  const emoji = winner.delta > 0 ? '🟢' : '🔴';
  const message = [
    `${emoji} OPEN INTEREST LEADER`,
    `${winner.symbol} · OI · ${timeframe} · ${formatUtcPlus3(boundary)} UTC+3`,
    '',
    `Change: ${direction}`,
    `OI change: ${winner.delta > 0 ? '+' : ''}${formatUsd(winner.delta)} USD`,
    `Previous OI: ${formatUsd(winner.previousOi)} USD`,
    `Current OI: ${formatUsd(winner.currentOi)} USD`,
    '',
    `➡️ NEXT Polymarket ${timeframe}`,
    market?.url || 'Market not found yet'
  ].join('\n');

  await sendTelegram(message);
  console.log(JSON.stringify({
    type: `open_interest_${timeframe.toLowerCase()}_alert`,
    boundary: new Date(boundary).toISOString(),
    symbol: winner.symbol,
    direction,
    delta: winner.delta,
    previousOi: winner.previousOi,
    currentOi: winner.currentOi,
    market: market?.url || null
  }));
}

async function main() {
  console.log('Open Interest monitor started; symbols=BTC,ETH,SOL,XRP,DOGE,BNB,HYPE; 5M + 15M; largest absolute OI change; exact boundary scheduling');

  const snapshots = new Map();
  let nextBoundary = bucketStart(Date.now(), WINDOW_5M) + WINDOW_5M;

  while (true) {
    await sleep(Math.max(0, nextBoundary - Date.now()));
    const boundary = nextBoundary;

    try {
      const currentSnapshot = await fetchOpenInterest();
      snapshots.set(boundary, currentSnapshot);

      const previous5m = snapshots.get(boundary - WINDOW_5M);
      if (previous5m) {
        await sendAlert('5M', previous5m, currentSnapshot, boundary);
      } else {
        console.log(JSON.stringify({ type: 'open_interest_5m_waiting_for_baseline', boundary: new Date(boundary).toISOString(), symbols: [...currentSnapshot.keys()] }));
      }

      const previous15m = snapshots.get(boundary - WINDOW_15M);
      if (previous15m) {
        await sendAlert('15M', previous15m, currentSnapshot, boundary);
      }

      for (const key of snapshots.keys()) {
        if (key < boundary - WINDOW_15M) snapshots.delete(key);
      }

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
