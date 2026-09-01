const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_OI_URL = 'https://fapi.binance.com/fapi/v1/openInterest';
const ENABLE_5M = true;
const ENABLE_15M = true;
const OI_THRESHOLD_PCT = 0.05;
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const POLL_MS = 15000;

const state = new Map();
let timer = null;
let stopping = false;

function num(v) { return Number.isFinite(Number(v)) ? Number(v) : 0; }
function symbol(asset) { return `${asset}USDT`; }
function marketLink(asset, start, windowMs) {
  const period = windowMs === WINDOW_15M ? '15m' : '5m';
  return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${period}-${Math.floor(start / 1000)}`;
}
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST', headers: {'content-type':'application/json'},
      body: JSON.stringify({chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview:false})
    });
    return r.ok;
  } catch (e) { console.error('[Telegram]', e?.message ?? e); return false; }
}
async function getOI(asset) {
  const r = await fetch(`${BINANCE_OI_URL}?symbol=${symbol(asset)}`);
  if (!r.ok) throw new Error(`OI HTTP ${r.status}`);
  const data = await r.json();
  return num(data.openInterest);
}
async function checkPeriod(asset, windowMs, now) {
  const key = `${asset}:${windowMs}`;
  const period = Math.floor(now / windowMs) * windowMs;
  const s = state.get(key) || { period, previousOI: null, alerted: false };
  if (s.period !== period) { s.period = period; s.previousOI = null; s.alerted = false; }
  const oi = await getOI(asset);
  if (s.previousOI === null) { s.previousOI = oi; state.set(key, s); return; }
  if (s.alerted || s.previousOI <= 0) { s.previousOI = oi; state.set(key, s); return; }
  const changePct = ((oi - s.previousOI) / s.previousOI) * 100;
  s.previousOI = oi;
  if (Math.abs(changePct) < OI_THRESHOLD_PCT) { state.set(key, s); return; }
  s.alerted = true;
  const direction = changePct > 0 ? 'INCREASE' : 'DECREASE';
  const linkStart = windowMs === WINDOW_5M ? period + WINDOW_5M : period;
  const label = windowMs === WINDOW_5M ? '5M' : '15M';
  const text = [
    `🚨 OI ${direction} — ${label}`,'',
    `${asset} — OPEN INTEREST ${direction}`,
    `📊 Change: ${changePct > 0 ? '+' : ''}${changePct.toFixed(2)}%`,
    `💠 OI: ${oi.toLocaleString('en-US', {maximumFractionDigits:2})}`,'',
    `▶️ ${windowMs === WINDOW_5M ? 'NEXT' : 'CURRENT'} ${asset} ${label} UP/DOWN`,
    marketLink(asset, linkStart, windowMs)
  ].join('\n');
  await sendTelegram(text);
  state.set(key, s);
}
async function poll() {
  const now = Date.now();
  for (const asset of ASSETS) {
    if (ENABLE_5M) await checkPeriod(asset, WINDOW_5M, now);
    if (ENABLE_15M) await checkPeriod(asset, WINDOW_15M, now);
  }
}
async function loop() {
  if (stopping) return;
  try { await poll(); } catch (e) { console.error('[OI]', e?.message ?? e); }
  if (!stopping) timer = setTimeout(loop, POLL_MS);
}
function shutdown(signal) { stopping = true; clearTimeout(timer); console.log(`Shutdown: ${signal}`); }
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
console.log('=== POLYMARKET OI MONITOR ===');
console.log('SOURCE: BINANCE FUTURES OPEN INTEREST API');
console.log('5M: ON | 15M: ON | OI threshold: ±0.05%');
console.log('ASSETS: BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
console.log('LIQUIDATIONS: DISABLED');
console.log('OI CHANGE: COMPARE EACH POLL WITH THE PREVIOUS OI VALUE');
console.log('5M ALERT: NEXT MARKET | 15M ALERT: CURRENT MARKET');
loop();
