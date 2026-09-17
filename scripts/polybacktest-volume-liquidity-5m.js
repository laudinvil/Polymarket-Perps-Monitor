const { env } = require('node:process');

const API = 'https://api.polybacktest.com/v4';
const COIN = 'BTC';
const TYPE = '5m';
const POLL_MS = 3000;
const DETAIL_RETRY_MS = 2500;

const apiKey = env.POLYBACKTEST_API_KEY;
const tgToken = env.TELEGRAM_BOT_TOKEN;
const tgChatId = env.TELEGRAM_CHAT_ID;
if (!apiKey) throw new Error('POLYBACKTEST_API_KEY is required');
if (!tgToken || !tgChatId) throw new Error('TELEGRAM secrets are required');

const sleep = ms => new Promise(r => setTimeout(r, ms));
let lastRequest = 0;
async function api(path) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const wait = Math.max(0, 1600 - (Date.now() - lastRequest));
    if (wait) await sleep(wait);
    lastRequest = Date.now();
    const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (res.status === 429 && attempt < 4) {
      let retry = 1900;
      try { retry = Math.max(1900, Number(JSON.parse(text)?.details?.retry_after || 1) * 1000 + 300); } catch {}
      console.log(`[polybacktest] rate limited; retrying in ${retry}ms`);
      await sleep(retry);
      continue;
    }
    throw new Error(`PolyBackTest ${res.status}: ${text.slice(0, 500)}`);
  }
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: tgChatId, text, disable_web_page_preview: false }),
  });
  if (!res.ok) throw new Error(`Telegram ${res.status}: ${(await res.text()).slice(0, 500)}`);
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function pct(a, b) { return a ? ((b - a) / a) * 100 : 0; }
function fmtPct(v) { return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`; }
function fmtUsd(v) { return `$${Math.round(v).toLocaleString('en-US')}`; }
function endMs(m) {
  const n = Number(m?.end);
  if (Number.isFinite(n) && n > 0) return n < 1e12 ? n * 1000 : n;
  const p = Date.parse(String(m?.end || ''));
  return Number.isFinite(p) ? p : 0;
}
function nextBoundary(now = Date.now()) {
  const d = new Date(now); d.setSeconds(0, 0);
  const minute = d.getMinutes();
  d.setMinutes(minute + (5 - (minute % 5 || 5)));
  return d.getTime();
}
function mapMarkets(data) {
  const list = Array.isArray(data) ? data : data.markets || data.data?.markets || data.data || data.results || [];
  return list.map(m => ({
    id: m.id ?? m.market_id ?? m.slug,
    slug: m.slug ?? m.event_slug ?? m.polymarket_slug,
    start: m.start_time ?? m.startTime ?? m.start ?? 0,
    end: m.end_time ?? m.endTime ?? m.end ?? m.resolved_at ?? 0,
    raw: m,
  })).filter(m => m.id != null).sort((a,b) => endMs(a) - endMs(b));
}
async function getMarkets() {
  const path = `/markets?coin=${COIN.toLowerCase()}&market_type=${TYPE}`;
  console.log(`[polybacktest] GET ${path}`);
  return mapMarkets(await api(path));
}
async function getDetails(market) {
  const d = await api(`/markets/${encodeURIComponent(market.id)}?coin=${COIN.toLowerCase()}`);
  const x = d.market || d.data?.market || d.data || d;
  const volume = x.final_volume;
  console.log(`[polybacktest] detail ${market.id} volume=${volume ?? 'missing'} liquidity=${x.final_liquidity ?? 'missing'}`);
  if (volume == null) return null;
  return { ...market, slug: x.slug ?? x.event_slug ?? x.polymarket_slug ?? market.slug, volume: num(volume), liquidity: num(x.final_liquidity), period: x.period ?? x.end_time ?? x.endTime ?? x.end ?? market.end };
}
function sumBook(book) {
  if (!book || typeof book !== 'object') return 0;
  return [...(book.bids || []), ...(book.asks || [])].reduce((s,l) => s + num(l.price) * num(l.size), 0);
}
async function getLiquidity(market) {
  const d = await api(`/markets/${encodeURIComponent(market.id)}/snapshots?coin=${COIN.toLowerCase()}&limit=1&include_orderbook=true`);
  const snapshots = Array.isArray(d?.snapshots) ? d.snapshots : [];
  if (!snapshots.length) throw new Error(`No snapshots for ${market.id}`);
  const liq = sumBook(snapshots[0].orderbook_up) + sumBook(snapshots[0].orderbook_down);
  console.log(`[polybacktest] orderbook ${market.id} liquidity=${liq.toFixed(2)}`);
  if (!liq) throw new Error(`Zero orderbook liquidity for ${market.id}`);
  return liq;
}
function alertText(prev, curr) {
  const vd = pct(prev.volume, curr.volume), ld = pct(prev.liquidity, curr.liquidity);
  const combination = vd >= 0 && ld >= 0 ? 'VOLUME ↑ + LIQUIDITY ↑' : vd < 0 && ld < 0 ? 'VOLUME ↓ + LIQUIDITY ↓' : 'MIXED';
  const winner = vd > ld ? 'VOLUME' : ld > vd ? 'LIQUIDITY' : 'TIE';
  return [
    `🔥 ${COIN} · POLYBACKTEST 5M`,
    `VOLUME: ${vd >= 0 ? 'UP' : 'DOWN'} ${fmtPct(vd)}`,
    `LIQUIDITY: ${ld >= 0 ? 'UP' : 'DOWN'} ${fmtPct(ld)}`,
    `VOLUME: ${fmtUsd(prev.volume)} → ${fmtUsd(curr.volume)}`,
    `LIQUIDITY: ${fmtUsd(prev.liquidity)} → ${fmtUsd(curr.liquidity)}`,
    `COMBINATION: ${combination}`,
    `WINNER: ${winner}`,
    `PERIOD: ${curr.period ?? curr.end ?? 'unknown'}`,
    '', '➡️ POLYMARKET 5M', `https://polymarket.com/event/${curr.slug}`,
  ].join('\n');
}
async function finalize(market) {
  let curr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    curr = await getDetails(market);
    if (curr) return curr;
    if (attempt < 2) await sleep(DETAIL_RETRY_MS);
  }
  throw new Error(`Market ${market.id} has no final_volume at boundary`);
}
async function main() {
  console.log('[polybacktest] boundary-anchored BTC 5m watcher');
  const boundary = nextBoundary();
  const markets = await getMarkets();
  const candidates = markets.filter(m => Math.abs(endMs(m) - boundary) <= 15000);
  if (!candidates.length) throw new Error(`No BTC 5m market found ending near boundary ${new Date(boundary).toISOString()}`);
  const target = candidates[candidates.length - 1];
  const targetIndex = markets.findIndex(m => m.id === target.id);
  if (targetIndex < 1) throw new Error(`No previous market for target ${target.id}`);
  const previous = markets[targetIndex - 1];
  console.log(`[polybacktest] boundary=${new Date(boundary).toISOString()} target=${target.id} end=${new Date(endMs(target)).toISOString()} previous=${previous.id}`);

  const wait = Math.max(0, boundary - Date.now());
  if (wait) await sleep(wait);

  console.log(`[polybacktest] processing target ${target.id} at boundary`);
  const curr = await finalize(target);
  const prev = await getDetails(previous);
  if (!prev) throw new Error(`Previous market ${previous.id} has no final_volume at boundary`);
  prev.liquidity = await getLiquidity(previous);
  curr.liquidity = await getLiquidity(target);
  console.log(`[polybacktest] values volume=${prev.volume}->${curr.volume} liquidity=${prev.liquidity}->${curr.liquidity}`);
  await sendTelegram(alertText(prev, curr));
  console.log(`[polybacktest] TELEGRAM SENT ${target.id}`);
}
main().catch(err => { console.error(`[polybacktest] FAILED ${err.stack || err.message}`); require('node:process').exitCode = 1; });
