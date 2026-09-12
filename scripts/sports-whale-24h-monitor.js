const DATA_API = 'https://data-api.polymarket.com/trades';
const GAMMA_API = 'https://gamma-api.polymarket.com/events';
const POLL_MS = 2 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const ALERT_RECENCY_MS = 330 * 1000;
const PAGE_SIZE = 10000;
const EVENT_BATCH_SIZE = 50;
const TZ_LABEL = 'UTC+3';
const SPORT_TAGS = ['sports', 'esports'];
const seen = new Map();
let sportsEventIds = new Set();
let lastAlertTrade = null;

function log(message) { console.log(`[${new Date().toISOString()}] ${message}`); }
function nowMs() { return Date.now(); }
function tradeUsd(t) { return Number(t.size) * Number(t.price); }
function tradeKey(t) { return `${t.transactionHash || ''}|${t.conditionId || ''}|${t.asset || ''}|${t.timestamp || ''}|${t.size || ''}|${t.price || ''}`; }
function fmtUsd(v) { return `$${Math.round(v).toLocaleString('en-US')}`; }
function fmtTime(ts) { return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'medium', hour12: false }).format(new Date(ts)); }
function marketUrl(t) { return t.eventSlug ? `https://polymarket.com/event/${t.eventSlug}` : 'https://polymarket.com/'; }

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

async function loadSportsEvents() {
  const cutoff = new Date(nowMs() - WINDOW_MS).toISOString();
  const ids = new Set();
  const counts = {};
  for (const tag of SPORT_TAGS) {
    let offset = 0;
    let tagCount = 0;
    for (let page = 0; page < 10; page++) {
      const url = `${GAMMA_API}?closed=false&limit=500&offset=${offset}&end_date_min=${encodeURIComponent(cutoff)}&tag_slug=${tag}`;
      const data = await getJson(url);
      const events = Array.isArray(data) ? data : (Array.isArray(data.events) ? data.events : []);
      for (const e of events) {
        if (e?.id != null) { ids.add(Number(e.id)); tagCount++; }
      }
      if (events.length < 500) break;
      offset += 500;
    }
    counts[tag] = tagCount;
  }
  sportsEventIds = ids;
  log(`SPORTS EVENTS: ${sportsEventIds.size} unique OPEN event IDs loaded; sports=${counts.sports || 0}; esports=${counts.esports || 0}`);
}

async function fetchRecentTrades() {
  const start = Math.floor((nowMs() - WINDOW_MS) / 1000);
  const end = Math.floor(nowMs() / 1000);
  const ids = [...sportsEventIds];
  const all = [];
  let pages = 0;
  for (let i = 0; i < ids.length; i += EVENT_BATCH_SIZE) {
    const batch = ids.slice(i, i + EVENT_BATCH_SIZE);
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const url = `${DATA_API}?eventId=${batch.join(',')}&start=${start}&end=${end}&limit=${PAGE_SIZE}&offset=${offset}`;
      const data = await getJson(url);
      const trades = Array.isArray(data) ? data : [];
      pages++;
      for (const t of trades) {
        const ts = Number(t.timestamp);
        if (Number.isFinite(ts) && ts >= start && ts <= end) all.push(t);
      }
      if (trades.length < PAGE_SIZE) break;
    }
  }
  log(`TRADE SCAN: event batches=${Math.ceil(ids.length / EVENT_BATCH_SIZE)}; pages=${pages}; trades=${all.length}`);
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
  const bestAgeMs = nowMs() - Number(best.timestamp) * 1000;
  log(`STATS: sportsTrades24h=${seen.size}; largest=${fmtUsd(best.usd)} | ${best.title} | ${best.outcome} | ${fmtTime(Number(best.timestamp) * 1000)} ${TZ_LABEL} | age=${Math.round(bestAgeMs / 1000)}s`);
  if (bestAgeMs > ALERT_RECENCY_MS) {
    log(`NO ALERT: current 24h maximum is older than ${ALERT_RECENCY_MS / 1000}s.`);
    return;
  }
  const key = tradeKey(best);
  if (lastAlertTrade === key) return;
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
  lastAlertTrade = key;
  log(`ALERT: ${fmtUsd(best.usd)} | ${best.title} | ${best.outcome}`);
}

async function main() {
  log('Sports Whale 24H monitor started; rolling window=24h; polling=120s; sports + esports; open events only; event-scoped trades; paginated trade scan.');
  try { await evaluate(); } catch (e) { log(`EVALUATION ERROR: ${e.message}`); }
  setInterval(async () => { try { await evaluate(); } catch (e) { log(`EVALUATION ERROR: ${e.message}`); } }, POLL_MS);
}
main().catch(e => { log(`FATAL: ${e.stack || e.message}`); process.exitCode = 1; });