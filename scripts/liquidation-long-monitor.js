const fs = require('fs');
const path = require('path');
const { fetchFeed, eventKey, normalizeTs, DEFAULT_SYMBOLS, POLL_MS } = require('../src/liquidation-monitor');
const { findNextMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

const STATE_PATH = path.join(process.cwd(), '.liquidation-state.json');
const TZ = 'Europe/Kyiv';
const PERIOD_MS = 10 * 60 * 1000;

function periodStart(ts) { return Math.floor(Number(ts) / PERIOD_MS) * PERIOD_MS; }

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { lastAlertPeriod: null };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function formatTime(epoch) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(epoch)).replace(',', '');
}

function formatUsd(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function liquidationSide(event) {
  const side = String(event?.side || event?.direction || '').toLowerCase();
  if (side.includes('long') || side === 'buy' || side.includes('short')) return side.toUpperCase();
  return side || 'UNKNOWN';
}

function isFreshEvent(event, startedAt, currentPeriod, seenEvents) {
  const ts = normalizeTs(event?.ts);
  if (!ts || ts < startedAt || periodStart(ts) !== currentPeriod) return false;
  const key = eventKey(event);
  if (seenEvents.has(key)) return false;
  seenEvents.add(key);
  return true;
}

async function alertForEvent(event, state) {
  const ts = normalizeTs(event.ts);
  const symbol = String(event.symbol || '').toUpperCase();
  const currentPeriod = periodStart(ts);
  if (state.lastAlertPeriod !== null && Number(state.lastAlertPeriod) === currentPeriod) return false;

  const nextMarket = await findNextMarket(symbol, ts, '5m');
  const nextUrl = nextMarket?.url || `https://polymarket.com/event/${symbol.toLowerCase()}-updown-5m-${Math.floor((Math.floor(ts / 300000) * 300000 + 300000) / 1000)}`;
  const message = [
    `🔥 ${symbol} · LIQUIDATION`,
    `Side: ${liquidationSide(event)}`,
    `Size: ${formatUsd(event.notional)}`,
    `Price: ${event.price ?? 'n/a'}`,
    `Time: ${formatTime(ts)} UTC+3`,
    `10M period: ${formatTime(currentPeriod)} → ${formatTime(currentPeriod + PERIOD_MS)} UTC+3`,
    `➡️ NEXT · Polymarket 5M`,
    nextUrl,
  ].join('\n');

  await sendTelegramMessage(message);
  state.lastAlertPeriod = currentPeriod;
  saveState(state);
  console.log(`[10M] ALERT ${symbol} side=${liquidationSide(event)} notional=${formatUsd(event.notional)} liquidation=${formatTime(ts)} period=${formatTime(currentPeriod)}`);
  return true;
}

async function main() {
  console.log(`MarginPad liquidation monitor started; symbols=${DEFAULT_SYMBOLS.join(',')}; timeframe=10m; all liquidation sides; first liquidation alerts immediately; remaining liquidations suppressed until next 10m period; poll=${POLL_MS}ms`);
  const state = loadState();
  const startedAt = Date.now();
  const seenEvents = new Set();

  while (true) {
    try {
      const events = await fetchFeed(DEFAULT_SYMBOLS);
      const now = Date.now();
      const currentPeriod = periodStart(now);
      const fresh = events
        .filter(event => isFreshEvent(event, startedAt, currentPeriod, seenEvents))
        .sort((a, b) => normalizeTs(a.ts) - normalizeTs(b.ts));

      if (state.lastAlertPeriod !== null && Number(state.lastAlertPeriod) < currentPeriod) {
        state.lastAlertPeriod = null;
        saveState(state);
      }

      for (const event of fresh) {
        if (await alertForEvent(event, state)) break;
      }

      const totalCurrent = events.filter(event => {
        const ts = normalizeTs(event?.ts);
        return ts && periodStart(ts) === currentPeriod;
      }).length;
      console.log(`[10M] current=${formatTime(currentPeriod)} total_liquidations=${totalCurrent} alert=${state.lastAlertPeriod === currentPeriod ? 'SUPPRESSED_AFTER_FIRST' : 'WAITING_FOR_FIRST'}`);
    } catch (error) {
      console.error(`[10M] monitor error: ${error.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, POLL_MS));
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
