import { createServer } from 'node:http';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PINAX_API_KEY = process.env.PINAX_API_KEY || process.env.PINAX_API_TOKEN;
const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_MS = 5 * 60 * 1000;
const POLL_MS = 15000;
const HTTP_PORT = Number(process.env.PORT || 3000);
const alertedPeriods = new Set();
let pollTimer = null;
let stopping = false;
let lastCheck = null;
let lastResult = null;

function currentWindowStart() { return Math.floor(Date.now() / WINDOW_MS) * WINDOW_MS; }
function fmtUsd(v) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function directionLabel(direction) { return String(direction || '').toUpperCase().includes('LONG') ? '🟢 LONG LIQUIDATION' : '🔴 SHORT LIQUIDATION'; }
function polymarketUrl(asset, nextStartMs) { return `https://polymarket.com/event/${asset.toLowerCase()}-updown-5m-${Math.floor(nextStartMs / 1000)}`; }

async function fetchLiquidations(startMs, endMs) {
  if (!PINAX_API_KEY) throw new Error('PINAX_API_KEY/PINAX_API_TOKEN is not configured');
  const url = new URL(PINAX_URL);
  url.searchParams.set('coin', ASSETS.join(','));
  url.searchParams.set('dex', 'perps');
  url.searchParams.set('start_time', String(Math.floor(startMs / 1000)));
  url.searchParams.set('end_time', String(Math.floor(endMs / 1000)));
  url.searchParams.set('sort_by', 'notional');
  url.searchParams.set('limit', '10');
  const response = await fetch(url, { headers: { Authorization: `Bearer ${PINAX_API_KEY}`, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Pinax HTTP ${response.status}: ${await response.text()}`);
  const body = await response.json();
  return Array.isArray(body?.data) ? body.data : [];
}

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Telegram is not configured');
  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false }) });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${await response.text()}`);
}

async function processClosedWindow(startMs) {
  const key = String(startMs);
  if (alertedPeriods.has(key)) return;
  const endMs = startMs + WINDOW_MS;
  try {
    const events = await fetchLiquidations(startMs, endMs);
    const candidates = events.filter(e => ASSETS.includes(String(e?.coin))).filter(e => Number(e?.notional) > 0).sort((a, b) => Number(b.notional) - Number(a.notional));
    lastCheck = new Date().toISOString();
    if (!candidates.length) { lastResult = { periodStart: startMs, periodEnd: endMs, events: 0, alert: false }; return; }
    const winner = candidates[0];
    const asset = String(winner.coin);
    const notional = Number(winner.notional);
    const direction = directionLabel(winner.direction || winner.liquidation_kind);
    const nextStart = endMs;
    const text = [direction, '', `${asset} — 5M LIQUIDATION`, `Size: ${fmtUsd(notional)} USDT`, '', '▶️ POLYMARKET', polymarketUrl(asset, nextStart)].join('\n');
    await sendTelegram(text);
    alertedPeriods.add(key);
    lastResult = { periodStart: startMs, periodEnd: endMs, events: candidates.length, alert: true, asset, direction: winner.direction || winner.liquidation_kind, notional, eventHash: winner.event_hash || null, nextMarket: polymarketUrl(asset, nextStart) };
    console.log('[ALERT]', JSON.stringify(lastResult));
  } catch (error) {
    lastCheck = new Date().toISOString();
    lastResult = { periodStart: startMs, periodEnd: endMs, alert: false, error: error?.message ?? String(error) };
    console.error('[Liquidations]', error?.message ?? error);
  }
}

async function poll() { if (stopping) return; const current = currentWindowStart(); await processClosedWindow(current - WINDOW_MS); }

function start() {
  console.log('=== POLYMARKET LIQUIDATION MONITOR ===');
  console.log('SOURCE: PINAX HYPERLIQUID MARKET LIQUIDATIONS');
  console.log('ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
  console.log('PERIOD: 5M');
  console.log('RULE: ONE LARGEST LIQUIDATION BY NOTIONAL ACROSS ALL 7 ASSETS');
  console.log('DIRECTION: LONG OR SHORT');
  console.log('LINK: NEXT 5M POLYMARKET MARKET');
  void poll();
  pollTimer = setInterval(() => void poll(), POLL_MS);
}

function shutdown(signal) { stopping = true; clearInterval(pollTimer); try { server.close(); } catch {} console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  if (url.pathname === '/health' || url.pathname === '/liquidations') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'polymarket-liquidation-monitor', source: 'Pinax Hyperliquid market liquidations', assets: ASSETS, period: '5M', rule: 'one largest liquidation by notional across all 7 assets', lastCheck, lastResult }));
    return;
  }
  res.writeHead(404); res.end(JSON.stringify({ ok: false, error: 'Not found', endpoints: ['/health', '/liquidations'] }));
});
server.listen(HTTP_PORT, () => console.log(`HTTP diagnostics listening on ${HTTP_PORT}`));
start();
