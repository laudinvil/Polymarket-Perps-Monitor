const { findCurrentMarket, findCurrentMarket15m } = require('./polymarket');

const OI_URL = 'https://marginpad.io/api/v1/open-interest';
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;

// Completely separate strategy: this monitor does not use liquidation data or state.
// At each exact 5m boundary it compares OI snapshots. 15m compares snapshots exactly
// 15 minutes apart. The winner is the coin with the largest absolute USD change.

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

async function sendAlert(timeframe, previous, current, boundary) {
  const winner = largestChange(previous, current);
  if (!winner) {
    console.log(JSON.stringify({ type: `open_interest_${timeframe}_no_change`, boundary: new Date(boundary).toISOString() }));
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
  console.log('Open Interest monitor started; separate strategy; 5M + 15M; largest absolute OI change; exact boundary scheduling');

  const snapshots = new Map();
  let nextBoundary = bucketStart(Date.now(), WINDOW_5M) + WINDOW_5M;

  while (true) {
    await sleep(Math.max(0, nextBoundary - Date.now()));
    const boundary = nextBoundary;

    try {
      const currentSnapshot = await fetchOpenInterest();
      snapshots.set(boundary, currentSnapshot);

      // 5M: compare exactly adjacent 5-minute boundary snapshots.
      const previous5m = snapshots.get(boundary - WINDOW_5M);
      if (previous5m) {
        await sendAlert('5M', previous5m, currentSnapshot, boundary);
      } else {
        console.log(JSON.stringify({ type: 'open_interest_5m_waiting_for_baseline', boundary: new Date(boundary).toISOString(), symbols: currentSnapshot.size }));
      }

      // 15M: compare exactly 15 minutes apart, never the immediately preceding 5m snapshot.
      const previous15m = snapshots.get(boundary - WINDOW_15M);
      if (previous15m) {
        await sendAlert('15M', previous15m, currentSnapshot, boundary);
      }

      // Keep only the recent snapshots needed for 15m comparison.
      for (const key of snapshots.keys()) {
        if (key < boundary - WINDOW_15M) snapshots.delete(key);
      }

      console.log(JSON.stringify({ type: 'open_interest_cycle', boundary: new Date(boundary).toISOString(), symbols: currentSnapshot.size }));
    } catch (error) {
      console.error(`OPEN INTEREST CYCLE FAILED: ${error.stack || error.message}`);
    }

    nextBoundary += WINDOW_5M;
    // If the runner was paused past one or more boundaries, skip stale periods and
    // wait for the next real boundary instead of generating catch-up alerts.
    if (nextBoundary <= Date.now()) nextBoundary = bucketStart(Date.now(), WINDOW_5M) + WINDOW_5M;
  }
}

main().catch(error => {
  console.error(`OPEN INTEREST MONITOR FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
