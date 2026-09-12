const DATA_API = 'https://data-api.polymarket.com/trades';
const GAMMA_API = 'https://gamma-api.polymarket.com/events';
const POLL_MS = 2 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 10000;
const MAX_PAGES = 2;
const TZ_LABEL = 'UTC+3';
const seen = new Map();
let sportsSlugs = new Set();
let lastAlertTrade = null;

function log(message) { console.log(`[${new Date().toISOString()}] ${message}`); }
function nowMs() { return Date.now(); }
function tradeUsd(t) { return Number(t.size) * Number(t.price); }
function tradeKey(t) { return `${t.transactionHash || ''}|${t.conditionId || ''}|${t.asset || ''}|${t.timestamp || ''}|${t.size || ''}|${t.price || ''}`; }
function fmtUsd(v) { return `$${Math.round(v).toLocaleString('en-US')}`; }
function fmtTime(ts) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(ts)); }
function marketUrl(t) { return t.eventSlug ? `https://polymarket.com/event/${t.eventSlug}` : `https://polymarket.com/`; }

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function loadSportsEvents() {
  const cutoff = new Date(nowMs() - WINDOW_MS).toISOString();
  const slugs = new Set();
  let offset = 0;
  for (let page = 0; page < 10; page++) {
    const url = `${GAMMA_API}?closed=false&limit=500&offset=${offset}&end_date_min=${encodeURIComponent(cutoff)}&tag_slug=sports`;
    const data = await getJson(url);
    const events = Array.isArray(data) ? data : (Array.isArray(data.events) ? data.events : []);
    for (const e of events) if (e?.slug) slugs.add(String(e.slug));
    if (events.length < 500) break;
    offset += 500;
  }
  sportsSlugs = slugs;
  log(`SPORTS EVENTS: ${sportsSlugs.size} active/recent event slugs loaded`);
}

async function fetchRecentTrades() {
  const cutoff = Math.floor((nowMs() - WINDOW_MS) / 1000);
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_SIZE;
    const url = `${DATA_API}?limit=${PAGE_SIZE}&offset=${offset}`;
    const data = await getJson(url);
    const trades = Array.isArray(data) ? data : [];
    if (!trades.length) break;
    let oldest = Infinity;
    for (const t of trades) {
      const ts = Number(t.timestamp);
      if (!Number.isFinite(ts)) continue;
      oldest = Math.min(oldest, ts);
      if (ts >= cutoff && sportsSlugs.has(String(t.eventSlug || ''))) all.push(t);
    }
    if (oldest < cutoff || trades.length < PAGE_SIZE) break;
  }
  return all;
}

function ingest(trades) {
  const cutoff = nowMs() - WINDOW_MS;
  for (const [key, t] of seen) if (Number(t.timestamp) * 1000 < cutoff) seen.delete(key);
  for (const t of trades) {
    const usd = tradeUsd(t);
    const ts = Number(t.timestamp);
    if (!Number.isFinite(usd) || usd <= 0 || !Number.isFinite(ts)) continue;
    const key = tradeKey(t);
    if (!seen.has(key)) seen.set(key, { ...t, usd });
  }
}

function largest() {
  const cutoff = Math.floor((nowMs() - WINDOW_MS) / 1000);
  let best = null;
  for (const t of seen.values()) {
    if (Number(t.timestamp) < cutoff) continue;
    if (!best || t.usd > best.usd || (t.usd === best.usd && Number(t.timestamp) > Number(best.timestamp))) best = t;
  }
  return best;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Telegram secrets are missing');
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false })
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
}

async function evaluate() {
  await loadSportsEvents();
  const trades = await fetchRecentTrades();
  ingest(trades);
  const best = largest();
  if (!best) { log(`STATS: sportsTrades24h=${seen.size}; largest=none`); return; }
  log(`STATS: sportsTrades24h=${seen.size}; largest=${fmtUsd(best.usd)} | ${best.title} | ${best.outcome} | ${fmtTime(Number(best.timestamp) * 1000)} ${TZ_LABEL}`);
  const key = tradeKey(best);
  if (lastAlertTrade === key) return;
  if (!lastAlertTrade || Number(best.timestamp) * 1000 > Number(lastAlertTrade.timestamp || 0) || best.usd > Number(lastAlertTrade.usd || 0)) {
    const text = [
      'SPORTS WHALE ALERT',
      '',
      `Event: ${best.title || best.eventSlug || 'Unknown'}`,
      `Market: ${best.outcome || 'Unknown'}`,
      `Largest bet: ${fmtUsd(best.usd)}`,
      `Side: ${best.side || 'UNKNOWN'}`,
      `Price: ${Number(best.price).toFixed(4)}`,
      `Time: ${fmtTime(Number(best.timestamp) * 1000)} ${TZ_LABEL}`,
      '',
      'Rolling window: 24H',
      `Polymarket: ${marketUrl(best)}`
    ].join('\n');
    await sendTelegram(text);
    lastAlertTrade = { timestamp: best.timestamp, usd: best.usd, key };
    log(`ALERT: ${fmtUsd(best.usd)} | ${best.title} | ${best.outcome}`);
  }
}

async function main() {
  log('Sports Whale 24H monitor started; rolling window=24h; polling=120s; sports only.');
  try { await evaluate(); } catch (e) { log(`EVALUATION ERROR: ${e.message}`); }
  setInterval(async () => { try { await evaluate(); } catch (e) { log(`EVALUATION ERROR: ${e.message}`); } }, POLL_MS);
}
main().catch(e => { log(`FATAL: ${e.stack || e.message}`); process.exitCode = 1; });
