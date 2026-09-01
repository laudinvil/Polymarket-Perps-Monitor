import { createServer } from 'node:http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PINAX_API_KEY = process.env.PINAX_API_KEY || process.env.PINAX_API_TOKEN;
const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const MIN_SIZE_USDT = 1000;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const HTTP_PORT = Number(process.env.PORT || 3000);
const alertedPeriods = new Set();
let lastAlertAsset = null;
let boundaryTimer = null;
let stopping = false;
let lastCheck = null;
let lastResult = null;
let lastProcessed5m = null;
let lastProcessed15m = null;

function windowStart(ms, size) { return Math.floor(ms / size) * size; }
function fmtUsd(v) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function directionLabel(direction) {
  const d = String(direction || '').toUpperCase();
  return d.includes('LONG') ? '🔴 LONG LIQUIDATION' : d.includes('SHORT') ? '🟢 SHORT LIQUIDATION' : '⚪ LIQUIDATION';
}
function actionLabel(direction) {
  const d = String(direction || '').toUpperCase();
  return d.includes('LONG') ? 'BUY UP' : d.includes('SHORT') ? 'BUY DOWN' : '';
}
function polymarketUrl(asset, startMs, minutes) { return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${minutes}m-${Math.floor(startMs / 1000)}`; }

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

async function sendAlert(periodStart, events, minutes) {
  const candidates = events
    .filter(e => ASSETS.includes(String(e?.coin)))
    .filter(e => Number(e?.notional) >= MIN_SIZE_USDT)
    .sort((a, b) => Number(b.notional) - Number(a.notional));
  if (!candidates.length) return null;
  const winner = candidates.find(e => String(e.coin) !== lastAlertAsset);
  if (!winner) {
    console.log(`[ALERT] skipped ${minutes}M: all qualifying candidates are ${lastAlertAsset}; waiting for a different asset`);
    return null;
  }
  const asset = String(winner.coin);
  const notional = Number(winner.notional);
  const direction = winner.direction || winner.liquidation_kind;
  const marketStart = periodStart + minutes * 60 * 1000;
  const text = [directionLabel(direction), '', `${asset} — ${minutes}M`, `Size: ${fmtUsd(notional)} USDT`, actionLabel(direction), '', '▶️ POLYMARKET', polymarketUrl(asset, marketStart, minutes)].join('\n');
  await sendTelegram(text);
  lastAlertAsset = asset;
  return { asset, notional, direction, timeframe: minutes, nextMarket: polymarketUrl(asset, marketStart, minutes) };
}

async function process5m(startMs) {
  if (lastProcessed5m === startMs) return;
  const endMs = startMs + WINDOW_5M;
  const events = await fetchLiquidations(startMs, endMs);
  lastProcessed5m = startMs;
  const key = `5m:${startMs}`;
  let alert5m = null;
  if (!alertedPeriods.has(key)) {
    alert5m = await sendAlert(startMs, events, 5);
    if (alert5m) alertedPeriods.add(key);
  }
  return { periodStart: startMs, periodEnd: endMs, events: events.length, alert5m };
}

async function process15m(startMs) {
  if (lastProcessed15m === startMs) return;
  const endMs = startMs + WINDOW_15M;
  const events = await fetchLiquidations(startMs, endMs);
  lastProcessed15m = startMs;
  const key = `15m:${startMs}`;
  let alert15m = null;
  if (!alertedPeriods.has(key)) {
    alert15m = await sendAlert(startMs, events, 15);
    if (alert15m) alertedPeriods.add(key);
  }
  return { periodStart: startMs, periodEnd: endMs, events: events.length, alert15m };
}

async function processDueWindows() {
  const now = Date.now();
  const closed5m = windowStart(now, WINDOW_5M) - WINDOW_5M;
  const closed15m = windowStart(now, WINDOW_15M) - WINDOW_15M;
  const five = await process5m(closed5m);
  let fifteen = null;
  if (lastProcessed15m !== closed15m) fifteen = await process15m(closed15m);
  lastCheck = new Date().toISOString();
  lastResult = { five, fifteen };
  console.log('[RESULT]', JSON.stringify(lastResult));
}

function scheduleNextBoundary() {
  if (stopping) return;
  clearTimeout(boundaryTimer);
  const now = Date.now();
  const next5m = windowStart(now, WINDOW_5M) + WINDOW_5M;
  const next15m = windowStart(now, WINDOW_15M) + WINDOW_15M;
  const nextBoundary = Math.min(next5m, next15m);
  const delay = Math.max(0, nextBoundary - now);
  console.log(`[SCHEDULER] next boundary: ${new Date(nextBoundary).toISOString()} | delayMs=${delay}`);
  boundaryTimer = setTimeout(async () => {
    if (stopping) return;
    try { await processDueWindows(); } catch (error) { console.error('[Liquidations]', error?.message ?? error); }
    scheduleNextBoundary();
  }, delay);
}

async function start() {
  console.log('=== POLYMARKET LIQUIDATION MONITOR ===');
  console.log('SOURCE: PINAX HYPERLIQUID MARKET LIQUIDATIONS');
  console.log('ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
  console.log('PERIODS: 5M + 15M');
  console.log(`MIN SIZE: ${MIN_SIZE_USDT} USDT`);
  console.log('RULE: LARGEST QUALIFYING LIQUIDATION BY NOTIONAL ACROSS ALL 7 ASSETS');
  console.log('REPEAT RULE: CROSS-TIMEFRAME — SAME ASSET CANNOT ALERT TWICE IN A ROW; NEXT QUALIFYING ASSET MUST BE DIFFERENT');
  console.log('PINAX: ONE REQUEST PER COIN PER CLOSED PERIOD');
  await processDueWindows();
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
    res.end(JSON.stringify({ ok: true, service: 'polymarket-liquidation-monitor', source: 'Pinax Hyperliquid market liquidations', assets: ASSETS, periods: ['5M', '15M'], minSizeUsdt: MIN_SIZE_USDT, rule: 'largest qualifying liquidation by notional across all 7 assets', repeatRule: 'cross-timeframe same asset cannot alert twice in a row', lastCheck, lastResult }));
    return;
  }
  res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/health', '/liquidations'] }));
});

server.listen(HTTP_PORT, () => {
  console.log(`HTTP diagnostics listening on ${HTTP_PORT}`);
  void start();
});
