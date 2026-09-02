import fs from 'node:fs';

const PINAX_API_KEY = process.env.PINAX_API_KEY || process.env.PINAX_API_TOKEN;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ASSETS = ['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB'];
const PINAX_ACTIVITY_URL = 'https://api.pinax.network/v1/hyperliquid/markets/activity';
const HL_INFO_URL = 'https://api.hyperliquid.xyz/info';
const THRESHOLD_PCT = Number(process.env.IMMINENT_LIQUIDATION_PCT || 2);
const SCAN_INTERVAL_MS = Number(process.env.IMMINENT_LIQUIDATION_INTERVAL_MS || 300000);
const CANDIDATE_LOOKBACK_MS = Number(process.env.IMMINENT_LIQUIDATION_LOOKBACK_MS || 30 * 60 * 1000);
const ACTIVITY_LIMIT = 10;
const LEADERBOARD_LIMIT = 10;
const RUN_ONCE = process.env.RUN_ONCE === 'true';
const STATE_FILE = process.env.IMMINENT_STATE_FILE || 'src/imminent-alerted-positions.json';
const alertedPositions = new Set();
let stopping = false;

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const key of Object.keys(parsed?.positions || {})) alertedPositions.add(key);
    console.log(`[IMMINENT][STATE] loaded=${alertedPositions.size} permanent positions from ${STATE_FILE}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error(`[IMMINENT][STATE] load error: ${error?.message ?? error}`);
    else console.log('[IMMINENT][STATE] no existing state file; starting empty');
  }
}
function saveState() {
  const positions = {};
  for (const key of alertedPositions) positions[key] = { alertedAt: new Date().toISOString() };
  fs.mkdirSync('src', { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify({ version: 2, rule: 'one position = one alert permanently', positions }, null, 2) + '\n');
  console.log(`[IMMINENT][STATE] saved=${alertedPositions.size}`);
}
function positionKey(user, position) {
  const coin = String(position?.coin || '').toUpperCase();
  const side = Number(position?.szi) > 0 ? 'Long' : 'Short';
  const entryPx = Number(position?.entryPx);
  // Hyperliquid does not expose a stable position-id in clearinghouseState.
  // Entry price is therefore included to distinguish a later re-opened position.
  const entry = Number.isFinite(entryPx) ? entryPx.toFixed(8) : 'unknown-entry';
  return `${user}|${coin}|${side}|entry:${entry}`;
}
function assertConfig() {
  if (!PINAX_API_KEY) throw new Error('PINAX_API_KEY/PINAX_API_TOKEN is not configured');
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) throw new Error('Telegram is not configured');
  if (!Number.isFinite(THRESHOLD_PCT) || THRESHOLD_PCT <= 0) throw new Error('IMMINENT_LIQUIDATION_PCT must be > 0');
}
async function pinaxGet(url) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${PINAX_API_KEY}`, Accept: 'application/json' } });
  const raw = await response.text(); if (!response.ok) throw new Error(`Pinax HTTP ${response.status}: ${raw.slice(0, 500)}`); return JSON.parse(raw);
}
async function discoverRecentUsers(coin) {
  const url = new URL(PINAX_ACTIVITY_URL); const now = Date.now();
  url.searchParams.set('coin', coin); url.searchParams.set('dex', 'perps'); url.searchParams.set('start_time', new Date(now - CANDIDATE_LOOKBACK_MS).toISOString()); url.searchParams.set('end_time', new Date(now).toISOString()); url.searchParams.set('limit', String(ACTIVITY_LIMIT)); url.searchParams.set('page', '1');
  const body = await pinaxGet(url); const rows = Array.isArray(body?.data) ? body.data : []; return rows.map(x => String(x?.user || '').toLowerCase()).filter(Boolean);
}
async function discoverTopUsers(coin) {
  const url = new URL('https://api.pinax.network/v1/hyperliquid/users'); url.searchParams.set('coin', coin); url.searchParams.set('dex', 'perps'); url.searchParams.set('interval', '1h'); url.searchParams.set('sort_by', 'total_volume'); url.searchParams.set('limit', String(LEADERBOARD_LIMIT)); url.searchParams.set('page', '1');
  const body = await pinaxGet(url); const rows = Array.isArray(body?.data) ? body.data : []; return rows.map(x => String(x?.user || '').toLowerCase()).filter(Boolean);
}
async function discoverCandidates() { const byCoin = new Map(); await Promise.all(ASSETS.map(async coin => { const [recent, top] = await Promise.all([discoverRecentUsers(coin), discoverTopUsers(coin)]); byCoin.set(coin, [...new Set([...recent, ...top])]); console.log(`[IMMINENT][CANDIDATES] ${coin} recent=${recent.length} top=${top.length} unique=${byCoin.get(coin).length}`); })); return byCoin; }
async function getMarketContexts() { const response = await fetch(HL_INFO_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs', dex: '' }) }); if (!response.ok) throw new Error(`Hyperliquid metaAndAssetCtxs HTTP ${response.status}`); const body = await response.json(); const meta = body?.[0]; const contexts = body?.[1]; const map = new Map(); if (!meta?.universe || !Array.isArray(contexts)) return map; for (let i = 0; i < meta.universe.length; i++) { const coin = meta.universe[i]?.name; const mark = Number(contexts[i]?.markPx); if (coin && Number.isFinite(mark) && mark > 0) map.set(coin, mark); } return map; }
async function getUserState(user) { const response = await fetch(HL_INFO_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'clearinghouseState', user, dex: '' }) }); if (!response.ok) throw new Error(`Hyperliquid clearinghouseState HTTP ${response.status}`); return response.json(); }
function parsePosition(position, markPx) { const size = Number(position?.szi); const liqPx = Number(position?.liquidationPx); const positionValue = Math.abs(Number(position?.positionValue)); if (!Number.isFinite(size) || size === 0 || !Number.isFinite(liqPx) || liqPx <= 0 || !Number.isFinite(markPx) || markPx <= 0) return null; const side = size > 0 ? 'Long' : 'Short'; const distancePct = side === 'Long' ? ((markPx - liqPx) / markPx) * 100 : ((liqPx - markPx) / markPx) * 100; if (!Number.isFinite(distancePct) || distancePct < 0 || distancePct > THRESHOLD_PCT) return null; return { side, coin: position?.coin, markPx, liqPx, distancePct, positionValue, size, entryPx: Number(position?.entryPx) }; }
async function scan() { console.log(`[IMMINENT][SCAN] threshold=${THRESHOLD_PCT}% interval=${SCAN_INTERVAL_MS}ms`); const [candidates, marks] = await Promise.all([discoverCandidates(), getMarketContexts()]); const alerts = []; for (const coin of ASSETS) { const users = candidates.get(coin) || []; const states = await Promise.all(users.map(async user => { try { return { user, state: await getUserState(user) }; } catch (error) { console.error(`[IMMINENT][USER_ERROR] ${coin} ${user}: ${error?.message ?? error}`); return null; } })); for (const item of states) { if (!item) continue; const positions = Array.isArray(item.state?.assetPositions) ? item.state.assetPositions : []; for (const wrapper of positions) { const position = wrapper?.position; if (!position || position.coin !== coin) continue; const parsed = parsePosition(position, marks.get(coin)); if (parsed) alerts.push({ user: item.user, key: positionKey(item.user, position), ...parsed }); } } } alerts.sort((a, b) => a.distancePct - b.distancePct || b.positionValue - a.positionValue); const unseen = alerts.filter(x => !alertedPositions.has(x.key)); console.log(`[IMMINENT][FOUND] qualifying=${alerts.length} unseen=${unseen.length} permanentlyAlerted=${alertedPositions.size}`); if (!unseen.length) return alerts; const item = unseen[0]; await sendAlert(item); alertedPositions.add(item.key); saveState(); console.log(`[IMMINENT][PERMANENT_FILTER] recorded=${item.key}`); return alerts; }
function fmtUsd(value) { return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function nextPolymarket5mUrl(coin) { const now = Date.now(); const nextStart = Math.floor(now / 300000) * 300000 + 300000; return `https://polymarket.com/event/${coin.toLowerCase()}-updown-5m-${Math.floor(nextStart / 1000)}`; }
async function sendAlert(item) { const emoji = item.side === 'Long' ? '🔴' : '🟢'; const text = `${emoji} #${item.coin} Imminent ${item.side} Liquidation: ${fmtUsd(item.positionValue)} @ ${item.distancePct.toFixed(2)}% away (liq: ${fmtUsd(item.liqPx)})\n\n▶️ NEXT POLYMARKET 5M\n${nextPolymarket5mUrl(item.coin)}`; console.log(`[IMMINENT][ALERT] ${text} user=${item.user} key=${item.key}`); const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }) }); const raw = await response.text(); console.log(`[IMMINENT][TELEGRAM] HTTP ${response.status}: ${raw.slice(0, 300)}`); if (!response.ok) throw new Error(`Telegram HTTP ${response.status}: ${raw}`); }
async function main() { assertConfig(); loadState(); console.log('=== IMMINENT LIQUIDATION MONITOR ==='); console.log(`THRESHOLD: ${THRESHOLD_PCT}%`); console.log('RULE: ONE POSITION = ONE ALERT, PERMANENTLY'); console.log('POSITION KEY: wallet + coin + side + entry price'); console.log('MARKET: next Polymarket 5M'); await scan(); if (RUN_ONCE) return; while (!stopping) { const now = Date.now(); const nextBoundary = Math.floor(now / 300000) * 300000 + 300000; const delay = Math.max(1000, nextBoundary - now); console.log(`[IMMINENT][SCHEDULER] next 5M boundary=${new Date(nextBoundary).toISOString()} delay=${delay}ms`); await new Promise(resolve => setTimeout(resolve, delay)); if (stopping) break; try { await scan(); } catch (error) { console.error('[IMMINENT][SCAN_ERROR]', error?.stack ?? error); } } }
process.on('SIGINT', () => { stopping = true; }); process.on('SIGTERM', () => { stopping = true; });
main().catch(error => { console.error('[IMMINENT][FATAL]', error?.stack ?? error); process.exitCode = 1; });
