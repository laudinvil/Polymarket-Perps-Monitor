const fs = require('fs');
const path = require('path');
const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { bucketStart, findMarketByEpoch, TIMEFRAMES } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// AUTHORITATIVE: individual LONG/SHORT liquidations only, 5M only.
// BNB: SHORT only. All other monitored coins: LONG + SHORT.
// ALERT TIMING: send immediately when a qualifying liquidation is detected.
// The 10-minute period is ONLY a duplicate-suppression period; it NEVER delays an alert.
// The ONLY time-dependent Polymarket logic is the NEXT market link.
// After a 29-minute quiet period, the first new liquidation is intentionally ignored.
// The previous alert's coin is blocked in the immediately following suppression period.
const SYMBOLS = ['ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const BNB_ALLOWED_SIDE = 'SHORT';
const TIMEFRAME = '5m';
const POLL_MS = 4000;
const FIVE_MINUTE_MS = 5 * 60 * 1000;
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const QUIET_PERIOD_MS = 29 * 60 * 1000;
const STATE_FILE = path.resolve('.liquidation-alert-state.json');

const seenLiquidations = new Set();
const startupTs = Date.now();
let initialized = false;
let alertWindowStart = null;
let lastAlertSymbol = null;
let hasAlerted = false;
let periodAlreadyAlerted = false;
let previousWindowBlockedSymbol = null;
let lastObservedLiquidationTs = null;
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;

function alignedWindowStart(ts) {
  return Math.floor(ts / FIVE_MINUTE_MS) * FIVE_MINUTE_MS;
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (Number.isFinite(Number(state.alertWindowStart)) && Number(state.alertWindowStart) > 0) {
      alertWindowStart = Number(state.alertWindowStart);
      lastAlertSymbol = state.lastAlertSymbol || null;
      hasAlerted = true;
      periodAlreadyAlerted = Date.now() < alertWindowStart + DEDUPE_WINDOW_MS;
      if (!periodAlreadyAlerted) previousWindowBlockedSymbol = lastAlertSymbol;
      console.log(`ALERT STATE RESTORED suppressionStart=${new Date(alertWindowStart).toISOString()} suppressionEnd=${new Date(alertWindowStart + DEDUPE_WINDOW_MS).toISOString()} active=${periodAlreadyAlerted} previousCoin=${lastAlertSymbol || 'none'}`);
    }
  } catch {}
}

async function persistState() {
  const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
  const token = String(process.env.GITHUB_TOKEN || '').trim();
  if (!repository || !token) return false;
  const api = `https://api.github.com/repos/${repository}/contents/.liquidation-alert-state.json`;
  const headers = { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Polymarket-Perps-Monitor' };
  try {
    let sha = null;
    const existing = await fetch(`${api}?ref=monitor-status`, { headers });
    if (existing.ok) sha = (await existing.json()).sha || null;
    const body = { message: 'Persist liquidation alert suppression period', content: Buffer.from(JSON.stringify({ alertWindowStart, lastAlertSymbol, hasAlerted }, null, 2) + '\n').toString('base64'), branch: 'monitor-status' };
    if (sha) body.sha = sha;
    const response = await fetch(api, { method: 'PUT', headers, body: JSON.stringify(body) });
    return response.ok;
  } catch { return false; }
}

function eventSide(event) {
  const value = String(event?.side || event?.direction || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 'LONG';
  if (value.includes('short') || value === 'sell') return 'SHORT';
  return null;
}

function liquidationKey(symbol, ts, side, event) {
  const id = event?.id ?? event?.liquidationId ?? event?.eventId ?? event?.tradeId ?? event?.txHash ?? event?.orderId;
  if (id !== undefined && id !== null && String(id) !== '') return `${symbol}:id:${String(id)}`;
  return [symbol, ts, side, event?.exchange ?? '', event?.price ?? '', event?.qty ?? event?.quantity ?? event?.size ?? '', event?.notional ?? event?.usd ?? event?.value ?? event?.amount ?? ''].join('|');
}

function numberValue(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function money(value) {
  return `$${Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

function price(value) {
  return Math.abs(numberValue(value)).toLocaleString('en-US', { maximumFractionDigits: 8 });
}

async function fetchAllFeeds() {
  const results = await Promise.all(SYMBOLS.map(async symbol => {
    try { return [symbol, await fetchSymbolFeed(symbol)]; }
    catch (error) { console.warn(`FEED ${symbol} FAILED: ${error.message}`); return [symbol, []]; }
  }));
  return new Map(results);
}

async function findNextPolymarket(symbol) {
  const now = Date.now();
  const currentBucket = bucketStart(now, TIMEFRAME);
  const nextEpoch = currentBucket + TIMEFRAMES[TIMEFRAME];
  return await findMarketByEpoch(symbol, nextEpoch, TIMEFRAME);
}

function enqueueAlert(message, symbol, side, key, alertDetectedAt) {
  alertSendChain = alertSendChain.then(async () => {
    try {
      const waitMs = Math.max(0, 5000 - (Date.now() - lastAlertSentAt));
      if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
      await sendTelegramMessage(message);
      lastAlertSentAt = Date.now();
      console.log(`5M ALERT SENT ${symbol} ${side} key=${key} detectedAt=${new Date(alertDetectedAt).toISOString()} sentAt=${new Date(lastAlertSentAt).toISOString()}`);
    } catch (error) { console.warn(`5M ALERT SEND FAILED ${symbol}: ${error.message}`); }
  }).catch(error => console.warn(`5M ALERT QUEUE FAILED: ${error.message}`));
}

async function processLiquidations(feeds, now) {
  if (!initialized) {
    initialized = true;
    for (const symbol of SYMBOLS) {
      for (const event of feeds.get(symbol) || []) {
        const ts = normalizeTs(event?.ts);
        if (ts && ts < now) {
          const side = eventSide(event);
          if (side) seenLiquidations.add(liquidationKey(symbol, ts, side, event));
          if (lastObservedLiquidationTs === null || ts > lastObservedLiquidationTs) lastObservedLiquidationTs = ts;
        }
      }
    }
    return;
  }

  if (alertWindowStart !== null && now >= alertWindowStart + DEDUPE_WINDOW_MS && periodAlreadyAlerted) {
    periodAlreadyAlerted = false;
    previousWindowBlockedSymbol = lastAlertSymbol;
    seenLiquidations.clear();
  }

  if (hasAlerted && alertWindowStart !== null && now < alertWindowStart + DEDUPE_WINDOW_MS) return;
  if (periodAlreadyAlerted) return;

  const previousLastObservedLiquidationTs = lastObservedLiquidationTs;
  const candidates = [];
  for (const symbol of SYMBOLS) {
    for (const event of feeds.get(symbol) || []) {
      const ts = normalizeTs(event?.ts);
      if (!ts || ts >= now || ts <= startupTs) continue;
      const side = eventSide(event);
      if (side !== 'LONG' && side !== 'SHORT') continue;
      if (symbol === 'BNB' && side !== BNB_ALLOWED_SIDE) continue;
      const key = liquidationKey(symbol, ts, side, event);
      if (seenLiquidations.has(key)) continue;
      seenLiquidations.add(key);
      if (lastObservedLiquidationTs === null || ts > lastObservedLiquidationTs) lastObservedLiquidationTs = ts;
      if (symbol === previousWindowBlockedSymbol) continue;
      candidates.push({ symbol, side, key, event, ts });
    }
  }

  if (!candidates.length) return;

  const quietMs = previousLastObservedLiquidationTs === null ? 0 : now - previousLastObservedLiquidationTs;
  if (hasAlerted && previousLastObservedLiquidationTs !== null && quietMs >= QUIET_PERIOD_MS) {
    candidates.sort((a, b) => a.ts - b.ts);
    console.log(`QUIET PERIOD EXIT; first liquidation suppressed symbol=${candidates[0].symbol} side=${candidates[0].side}`);
    return;
  }

  candidates.sort((a, b) => a.ts - b.ts);
  const { symbol, side, key, event, ts } = candidates[0];
  alertWindowStart = alignedWindowStart(now);
  periodAlreadyAlerted = true;
  lastAlertSymbol = symbol;
  previousWindowBlockedSymbol = null;
  hasAlerted = true;

  await persistState();

  const eventPrice = numberValue(event?.price, event?.markPrice, event?.executionPrice);
  const eventQty = numberValue(event?.qty, event?.quantity, event?.size);
  const eventNotional = Math.abs(eventPrice * eventQty);

  let market = null;
  try { market = await findNextPolymarket(symbol); }
  catch (error) { console.warn(`POLYMARKET LOOKUP FAILED 5m ${symbol}: ${error.message}`); }

  const message = [
    `🔥 ${symbol} · 5M · ${side}`,
    `Volume: ${money(eventNotional)}`,
    `Price: ${price(eventPrice)}`,
    market?.url ? '' : null,
    market?.url ? `➡️ NEXT · Polymarket 5M\n${market.url}` : null
  ].filter(value => value !== null).join('\n');

  enqueueAlert(message, symbol, side, key, now);
}

async function main() {
  loadState();
  console.log(`SINGLE LONG/SHORT LIQUIDATION MONITOR STARTED; coins=${SYMBOLS.join(',')}; BNB=SHORT ONLY; ONLY 5M; ALERTS IMMEDIATE; 10M SUPPRESSION ONLY; NEXT MARKET LINK ONLY; previous-period coin blocked; 29M quiet-period after which first liquidation is ignored; no imbalance; no streaks`);
  while (true) {
    const now = Date.now();
    try { await processLiquidations(await fetchAllFeeds(), now); }
    catch (error) { console.warn(`MONITOR LOOP FAILED: ${error.message}`); }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => { console.error(`MONITOR FATAL: ${error.stack || error.message}`); process.exitCode = 1; });
