const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_OI_URL = 'https://fapi.binance.com/fapi/v1/openInterest';

const ENABLE_5M = true;
const ENABLE_15M = true;
const ASSETS = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTE = 'USDT';
const OI_THRESHOLD_PCT = 0.1;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const POLL_MS = 15000;
const RECONNECT_MS = 3000;

let windowStart5m = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
let windowStart15m = Math.floor(Date.now() / WINDOW_15M) * WINDOW_15M;
let baseline5m = new Map();
let baseline15m = new Map();
let alerted5m = new Set();
let alerted15m = new Set();
let pollTimer = null;
let boundaryTimer = null;
let stopping = false;
let advancing = Promise.resolve();

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function symbol(asset) { return `${asset}USDT`; }
function marketLink(asset, start, windowMs) {
  const period = windowMs === WINDOW_15M ? '15m' : '5m';
  return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${period}-${Math.floor(start / 1000)}`;
}
function formatPct(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`; }
function formatOi(v) { return Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: false })
    });
    if (!response.ok) console.error('[Telegram] HTTP', response.status, await response.text());
    return response.ok;
  } catch (error) {
    console.error('[Telegram]', error?.message ?? error);
    return false;
  }
}

async function getOpenInterest(asset) {
  const response = await fetch(`${BINANCE_OI_URL}?symbol=${symbol(asset)}`);
  if (!response.ok) throw new Error(`Binance OI HTTP ${response.status}`);
  const data = await response.json();
  const oi = num(data?.openInterest);
  if (!(oi > 0)) throw new Error(`Invalid OI for ${asset}`);
  return oi;
}

async function getAllOi() {
  const entries = await Promise.all([...ASSETS].map(async asset => {
    try { return [asset, await getOpenInterest(asset)]; }
    catch (error) { console.error(`[OI ${asset}]`, error?.message ?? error); return null; }
  }));
  return new Map(entries.filter(Boolean));
}

function pctChange(base, current) {
  if (!(base > 0) || !(current > 0)) return 0;
  return ((current - base) / base) * 100;
}

async function sendOiAlert(asset, direction, changePct, currentOi, start, windowMs, nextMarket) {
  const label = windowMs === WINDOW_15M ? '15M' : '5M';
  const marketStart = nextMarket ? start + windowMs : start;
  const title = nextMarket ? `▶️ NEXT ${asset} ${label} UP/DOWN` : `▶️ ${asset} ${label} UP/DOWN`;
  const text = [
    `🚨 OI ${direction} — ${label}`,
    '',
    `${asset} — OPEN INTEREST`,
    `📊 Change: ${formatPct(changePct)}`,
    `💥 OI: ${formatOi(currentOi)}`,
    '',
    title,
    marketLink(asset, marketStart, windowMs)
  ].join('\n');
  return sendTelegram(text);
}

async function advanceWindows(now) {
  const target5 = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const target15 = Math.floor(now / WINDOW_15M) * WINDOW_15M;
  if (target5 > windowStart5m) {
    windowStart5m = target5;
    baseline5m = new Map();
    alerted5m = new Set();
  }
  if (target15 > windowStart15m) {
    windowStart15m = target15;
    baseline15m = new Map();
    alerted15m = new Set();
  }
}
function requestAdvance(now) {
  advancing = advancing.then(() => advanceWindows(now)).catch(error => console.error('[Window]', error?.message ?? error));
  return advancing;
}

async function pollOi() {
  if (stopping) return;
  const now = Date.now();
  await requestAdvance(now);
  const oiMap = await getAllOi();
  if (!oiMap.size) return;

  for (const [asset, currentOi] of oiMap) {
    if (ENABLE_5M) {
      if (!baseline5m.has(asset)) baseline5m.set(asset, currentOi);
      const change5 = pctChange(baseline5m.get(asset), currentOi);
      if (Math.abs(change5) >= OI_THRESHOLD_PCT && !alerted5m.has(asset)) {
        alerted5m.add(asset);
        const direction = change5 > 0 ? 'INCREASE' : 'DECREASE';
        const sent = await sendOiAlert(asset, direction, change5, currentOi, windowStart5m, WINDOW_5M, true);
        if (!sent) console.error(`[5M OI Alert] Telegram send failed for ${asset}`);
      }
    }

    if (ENABLE_15M) {
      if (!baseline15m.has(asset)) baseline15m.set(asset, currentOi);
      const change15 = pctChange(baseline15m.get(asset), currentOi);
      if (Math.abs(change15) >= OI_THRESHOLD_PCT && !alerted15m.has(asset)) {
        alerted15m.add(asset);
        const direction = change15 > 0 ? 'INCREASE' : 'DECREASE';
        const sent = await sendOiAlert(asset, direction, change15, currentOi, windowStart15m, WINDOW_15M, false);
        if (!sent) console.error(`[15M OI Alert] Telegram send failed for ${asset}`);
      }
    }
  }
}

function schedule() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    try { await pollOi(); }
    finally { if (!stopping) schedule(); }
  }, POLL_MS);
}

function scheduleBoundary() {
  clearTimeout(boundaryTimer);
  const next5 = windowStart5m + WINDOW_5M;
  const next15 = windowStart15m + WINDOW_15M;
  const next = Math.min(next5, next15);
  boundaryTimer = setTimeout(async () => {
    await requestAdvance(Date.now());
    if (!stopping) scheduleBoundary();
  }, Math.max(100, next - Date.now() + 50));
}

function shutdown(signal) {
  stopping = true;
  clearTimeout(pollTimer);
  clearTimeout(boundaryTimer);
  console.log(`Shutdown: ${signal}`);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

console.log('=== POLYMARKET OI MONITOR ===');
console.log('SOURCE: BINANCE FUTURES OPEN INTEREST REST API');
console.log('LIQUIDATION LOGIC: DISABLED');
console.log('5M: ENABLED | threshold: ±0.1% | alert on NEXT 5M market');
console.log('15M: ENABLED | threshold: ±0.1% | alert on CURRENT 15M market');
console.log('ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
console.log('ONE OI ALERT PER COIN PER PERIOD');

void pollOi().catch(error => console.error('[Initial OI]', error?.message ?? error));
schedule();
scheduleBoundary();
