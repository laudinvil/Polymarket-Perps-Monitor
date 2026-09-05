const { findCurrentMarket, findCurrentMarket15m } = require('./polymarket');

const OI_URL = 'https://marginpad.io/api/v1/open-interest';
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const POLL_MS = 10 * 1000;

// Separate strategy: this monitor is independent from liquidation monitoring.
// It scans every symbol returned by MarginPad's open-interest endpoint.

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function bucketStart(ms, windowMs) {
  return Math.floor(ms / windowMs) * windowMs;
}

function formatUtcPlus3(ms) {
  return new Date(ms + 3 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

async function fetchOpenInterest() {
  const response = await fetch(OI_URL, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`MarginPad OI HTTP ${response.status}`);
  const json = await response.json();
  if (json?.ok === false) throw new Error(json?.error?.message || 'MarginPad OI returned an error');

  const payload = json?.data ?? json;
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.rows)
      ? payload.rows
      : Array.isArray(payload?.openInterest)
        ? payload.openInterest
        : Array.isArray(payload?.items)
          ? payload.items
          : [];

  const snapshot = new Map();
  for (const row of rows) {
    const symbol = String(row?.symbol || row?.ticker || '').trim().toUpperCase();
    const value = Number(row?.openInterest ?? row?.open_interest ?? row?.oi ?? row?.value);
    if (!symbol || !Number.isFinite(value)) continue;
    snapshot.set(symbol, value);
  }
  if (!snapshot.size) throw new Error('MarginPad OI response contained no usable symbols');
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

async function send5m(previous, current, boundary) {
  const winner = largestChange(previous, current);
  if (!winner) return;

  const market = await findCurrentMarket(winner.symbol, boundary);
  const direction = winner.delta > 0 ? 'POSITIVE' : 'NEGATIVE';
  const emoji = winner.delta > 0 ? '🟢' : '🔴';
  const message = [
    `${emoji} OPEN INTEREST LEADER`,
    `${winner.symbol} · OI · 5M · ${formatUtcPlus3(boundary)} UTC+3`,
    '',
    `Change: ${direction}`,
    `OI change: ${winner.delta > 0 ? '+' : ''}${winner.delta.toLocaleString('en-US', { maximumFractionDigits: 0 })} USD`,
    `Previous OI: ${winner.previousOi.toLocaleString('en-US', { maximumFractionDigits: 0 })} USD`,
    `Current OI: ${winner.currentOi.toLocaleString('en-US', { maximumFractionDigits: 0 })} USD`,
    '',
    '➡️ NEXT Polymarket 5M',
    market?.url || 'Market not found yet'
  ].join('\n');
  await sendTelegram(message);
  console.log(JSON.stringify({ type: 'open_interest_5m_alert', boundary: new Date(boundary).toISOString(), symbol: winner.symbol, direction, delta: winner.delta, previousOi: winner.previousOi, currentOi: winner.currentOi, market: market?.url || null }));
}

async function send15m(previous, current, boundary) {
  const winner = largestChange(previous, current);
  if (!winner) return;

  const market = await findCurrentMarket15m(winner.symbol, boundary);
  const direction = winner.delta > 0 ? 'POSITIVE' : 'NEGATIVE';
  const emoji = winner.delta > 0 ? '🟢' : '🔴';
  const message = [
    `${emoji} OPEN INTEREST LEADER`,
    `${winner.symbol} · OI · 15M · ${formatUtcPlus3(boundary)} UTC+3`,
    '',
    `Change: ${direction}`,
    `OI change: ${winner.delta > 0 ? '+' : ''}${winner.delta.toLocaleString('en-US', { maximumFractionDigits: 0 })} USD`,
    `Previous OI: ${winner.previousOi.toLocaleString('en-US', { maximumFractionDigits: 0 })} USD`,
    `Current OI: ${winner.currentOi.toLocaleString('en-US', { maximumFractionDigits: 0 })} USD`,
    '',
    '➡️ NEXT Polymarket 15M',
    market?.url || 'Market not found yet'
  ].join('\n');
  await sendTelegram(message);
  console.log(JSON.stringify({ type: 'open_interest_15m_alert', boundary: new Date(boundary).toISOString(), symbol: winner.symbol, direction, delta: winner.delta, previousOi: winner.previousOi, currentOi: winner.currentOi, market: market?.url || null }));
}

async function main() {
  console.log('Open Interest monitor started; separate strategy; 5M + 15M; largest absolute OI change; exact boundary scheduling');

  let previousSnapshot = await fetchOpenInterest();
  let previousBoundary = bucketStart(Date.now(), WINDOW_5M);
  console.log(JSON.stringify({ type: 'open_interest_initial_snapshot', boundary: new Date(previousBoundary).toISOString(), symbols: previousSnapshot.size }));

  while (true) {
    const now = Date.now();
    const nextBoundary = bucketStart(now, WINDOW_5M) + WINDOW_5M;
    await sleep(Math.max(0, nextBoundary - Date.now()));

    try {
      const currentSnapshot = await fetchOpenInterest();
      const boundary = nextBoundary;
      const previous5m = previousSnapshot;
      const previous5mBoundary = previousBoundary;

      await send5m(previous5m, currentSnapshot, boundary);

      if (Math.floor(boundary / WINDOW_15M) !== Math.floor(previous5mBoundary / WINDOW_15M)) {
        await send15m(previous5m, currentSnapshot, boundary);
      }

      console.log(JSON.stringify({
        type: 'open_interest_cycle',
        boundary: new Date(boundary).toISOString(),
        symbols: currentSnapshot.size,
        previousBoundary: new Date(previous5mBoundary).toISOString()
      }));

      previousSnapshot = currentSnapshot;
      previousBoundary = boundary;
    } catch (error) {
      console.error(`OPEN INTEREST CYCLE FAILED: ${error.stack || error.message}`);
    }
  }
}

main().catch(error => {
  console.error(`OPEN INTEREST MONITOR FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
