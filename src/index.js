import { createServer } from 'node:http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PINAX_API_KEY = process.env.PINAX_API_KEY || process.env.PINAX_API_TOKEN;
const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_MS = 5 * 60 * 1000;
const HTTP_PORT = Number(process.env.PORT || 3000);
const alertedPeriods = new Set();
const fiveMinuteHistory = new Map();
let boundaryTimer = null;
let stopping = false;
let lastCheck = null;
let lastResult = null;
let lastProcessedStart = null;

function currentWindowStart() { return Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS; }
function fmtUsd(v) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function directionLabel(direction) {
  const d = String(direction || '').toUpperCase();
  return d.includes('LONG') ? '🔴 LONG LIQUIDATION' : d.includes('SHORT') ? '🟢 SHORT LIQUIDATION' : '⚪ LIQUIDATION';
}
function actionLabel(direction) {
  const d = String(direction || '').toUpperCase();
  return d.includes('LONG') ? 'BUY UP' : d.includes('SHORT') ? 'BUY DOWN' : '';
}
function polymarketUrl(asset, startMs, timeframeMinutes) { return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${timeframeMinutes}m-${Math.floor(startMs / 1000)}`; }

async function fetchCoinLiquidations(coin, startMs, endMs) {
  if (!PINAX_API_KEY) throw new Error('PINAX_API_KEY/PINAX_API_TOKEN is not configured');
  const url = new URL(PINAX_URL);
  url.searchParams.set('coin', coin);
  url.searchParams.set('dex', 'perps');
  url.searchParams.set('start_time', String(Math.floor(startMs / 1000)));
  url.searchParams.set('end_time', String(Math.floor(endMs / 1000)));
  url.searchParams.set('sort_by', 'notional');
  url.searchParams.set('limit', '1');
  url.searchParams.set('page', '1');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${PINAX_API_KEY}`, Accept: 'application/json' } });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${coin}: Pinax HTTP ${response.status}: ${raw}`);
  let body;
  try { body = JSON.parse(raw); } catch { throw new Error(`${coin}: Pinax returned non-JSON response: ${raw.slice(0, 300)}`); }
  return Array.isArray(body?.data) ? body.data : [];
}

async function fetchLiquidations(startMs, endMs) {
  const results = await Promise.all(ASSETS.map(async coin => {
    try {
      const events = await fetchCoinLiquidations(coin, startMs, endMs);
      const top = events[0];
      console.log(`[Pinax] ${coin}: ${events.length} events${top ? ` | top=${JSON.stringify({ coin: top.coin, notional: top.notional, direction: top.direction, liquidation_kind: top.liquidation_kind })}` : ''}`);
      return events;
    } catch (error) {
      console.error('[Pinax]', error?.message ?? error);
      return [];
    }
  }));
  const flat = results.flat();
  console.log(`[Pinax] TOTAL: ${flat.length} top events across ${ASSETS.length} assets`);
  return flat;
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Telegram is not configured');
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
}

function rememberFiveMinute(periodStart, events) {
  const byCoin = {};
  for (const asset of ASSETS) {
    const event = events.find(e => String(e?.coin) === asset);
    byCoin[asset] = event ? { notional: Number(event.notional) || 0, direction: event.direction || event.liquidation_kind || '', eventHash: event.event_hash || null } : { notional: 0, direction: '', eventHash: null };
  }
  fiveMinuteHistory.set(periodStart, byCoin);
  const cutoff = periodStart - (4 * WINDOW_MS);
  for (const ts of fiveMinuteHistory.keys()) if (ts < cutoff) fiveMinuteHistory.delete(ts);
  return byCoin;
}

function getLastThree(periodStart) {
  return [periodStart - (2 * WINDOW_MS), periodStart - WINDOW_MS, periodStart].map(ts => fiveMinuteHistory.get(ts)).filter(Boolean);
}

async function sendFiveMinuteAlert(periodStart, events) {
  const candidates = events.filter(e => ASSETS.includes(String(e?.coin))).filter(e => Number(e?.notional) > 0).sort((a, b) => Number(b.notional) - Number(a.notional));
  if (!candidates.length) return null;
  const winner = candidates[0];
  const asset = String(winner.coin);
  const notional = Number(winner.notional);
  const direction = winner.direction || winner.liquidation_kind;
  const nextStart = periodStart + WINDOW_MS;
  const text = [directionLabel(direction), '', `${asset} — 5M`, `Size: ${fmtUsd(notional)} USDT`, actionLabel(direction), '', '▶️ POLYMARKET', polymarketUrl(asset, nextStart, 5)].join('\n');
  await sendTelegram(text);
  return { asset, notional, direction, nextMarket: polymarketUrl(asset, nextStart, 5) };
}

async function sendFifteenMinuteAlert(periodStart) {
  const periods = getLastThree(periodStart);
  if (periods.length !== 3) return null;
  const totals = ASSETS.map(asset => {
    let total = 0, long = 0, short = 0;
    for (const period of periods) {
      const row = period[asset];
      const value = Number(row?.notional) || 0;
      total += value;
      const d = String(row?.direction || '').toUpperCase();
      if (d.includes('LONG')) long += value;
      if (d.includes('SHORT')) short += value;
    }
    return { asset, total, long, short };
  }).filter(x => x.total > 0).sort((a, b) => b.total - a.total);
  if (!totals.length) return null;
  const winner = totals[0];
  const direction = winner.long > winner.short ? 'LONG' : winner.short > winner.long ? 'SHORT' : '';
  const nextStart = periodStart + WINDOW_MS;
  const text = [directionLabel(direction), '', `${winner.asset} — 15M`, `Size: ${fmtUsd(winner.total)} USDT`, actionLabel(direction), '', '▶️ POLYMARKET', polymarketUrl(winner.asset, nextStart, 15)].join('\n');
  await sendTelegram(text);
  return { asset: winner.asset, total: winner.total, long: winner.long, short: winner.short, direction, nextMarket: polymarketUrl(winner.asset, nextStart, 15) };
}

async function processClosedWindow(startMs) {
  if (lastProcessedStart === startMs) return;
  const endMs = startMs + WINDOW_MS;
  try {
    const events = await fetchLiquidations(startMs, endMs);
    rememberFiveMinute(startMs, events);
    lastProcessedStart = startMs;
    lastCheck = new Date().toISOString();
    let fiveMinuteAlert = null;
    const fiveKey = `5m:${startMs}`;
    if (!alertedPeriods.has(fiveKey)) {
      fiveMinuteAlert = await sendFiveMinuteAlert(startMs, events);
      if (fiveMinuteAlert) alertedPeriods.add(fiveKey);
    }
    let fifteenMinuteAlert = null;
    const periodNumber = Math.floor(startMs / WINDOW_MS);
    if (periodNumber % 3 === 2) {
      const fifteenKey = `15m:${startMs}`;
      if (!alertedPeriods.has(fifteenKey)) {
        fifteenMinuteAlert = await sendFifteenMinuteAlert(startMs);
        if (fifteenMinuteAlert) alertedPeriods.add(fifteenKey);
      }
    }
    lastResult = { periodStart: startMs, periodEnd: endMs, events: events.length, alert5m: fiveMinuteAlert, alert15m: fifteenMinuteAlert };
    console.log('[RESULT]', JSON.stringify(lastResult));
  } catch (error) {
    lastCheck = new Date().toISOString();
    lastResult = { periodStart: startMs, periodEnd: endMs, alert: false, error: error?.message ?? String(error) };
    console.error('[Liquidations]', error?.message ?? error);
  }
}

function scheduleNextBoundary() {
  if (stopping) return;
  clearTimeout(boundaryTimer);
  const now = Date.now();
  const nextBoundary = currentWindowStart() + WINDOW_MS;
  const delay = Math.max(0, nextBoundary - now);
  console.log(`[SCHEDULER] next 5M boundary: ${new Date(nextBoundary).toISOString()} | delayMs=${delay}`);
  boundaryTimer = setTimeout(async () => {
    if (stopping) return;
    await processClosedWindow(nextBoundary - WINDOW_MS);
    scheduleNextBoundary();
  }, delay);
}

async function start() {
  console.log('=== POLYMARKET LIQUIDATION MONITOR ===');
  console.log('SOURCE: PINAX HYPERLIQUID MARKET LIQUIDATIONS');
  console.log('ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
  console.log('PERIODS: 5M + 15M');
  console.log('RULE 5M: ONE LARGEST LIQUIDATION BY NOTIONAL ACROSS ALL 7 ASSETS');
  console.log('RULE 15M: SUM THE THREE PREVIOUS 5M TOP LIQUIDATIONS PER ASSET, THEN SELECT LARGEST TOTAL');
  console.log('PINAX: ONE REQUEST PER COIN PER CLOSED 5M PERIOD');
  console.log('DIRECTION: SHORT=GREEN, LONG=RED');
  console.log('LINK: NEXT 5M/15M POLYMARKET MARKET');
  await processClosedWindow(currentWindowStart() - WINDOW_MS);
  scheduleNextBoundary();
}

function shutdown(signal) { stopping = true; clearTimeout(boundaryTimer); try { server.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/health' || url.pathname === '/liquidations') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'polymarket-liquidation-monitor', source: 'Pinax Hyperliquid market liquidations', assets: ASSETS, periods: ['5M', '15M'], rule5m: 'one largest liquidation by notional across all 7 assets', rule15m: 'sum three previous 5M top liquidations per asset and select largest total', pinax: 'one request per coin per closed 5M period', lastCheck, lastResult }));
    return;
  }
  res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/health', '/liquidations'] }));
});

server.listen(HTTP_PORT, () => {
  console.log(`HTTP diagnostics listening on ${HTTP_PORT}`);
  void start();
});