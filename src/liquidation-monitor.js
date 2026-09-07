const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';
const HISTORICAL_URL = 'https://marginpad.io/api/v1/liquidations/recent';
const DEFAULT_SYMBOLS = ['BTC'];
const POLL_MS = 4000;
const FALLBACK_REFRESH_MS = 15000;
const WINDOW_MS = 5 * 60 * 1000;
const FEED_RETENTION_MS = 26 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATE_PATH = '.monitor-state.json';
const STATE_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;

let fallbackCache = { fetchedAt: 0, eventsBySymbol: new Map() };
let liveFeedCache = { fetchedAt: 0, events: new Map() };
let liveFeedPromise = null;

function bucketStart(ts) { const ms = Number(ts); return Math.floor(ms / WINDOW_MS) * WINDOW_MS; }
function normalizeTs(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) { const ts = value.getTime(); return Number.isFinite(ts) && ts > 0 ? ts : null; }
  if (Array.isArray(value)) return normalizeTs(value[0]);
  if (typeof value === 'object') { for (const key of ['$date', 'date', 'timestamp', 'ts', 'time', 'value', 'start', 'startTime', 'epoch']) if (Object.prototype.hasOwnProperty.call(value, key)) { const ts = normalizeTs(value[key]); if (ts) return ts; } return null; }
  if (typeof value === 'string') { const trimmed = value.trim(); if (!trimmed) return null; const numeric = Number(trimmed); if (Number.isFinite(numeric) && numeric > 0) return normalizeTs(numeric); const parsed = Date.parse(trimmed); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
  const n = Number(value); if (!Number.isFinite(n) || n <= 0) return null;
  if (n < 1e11) return n * 1000;
  if (n < 1e14) return n;
  if (n < 1e17) return n / 1000;
  return n / 1000000;
}
function normalizeSymbol(symbol) { return String(symbol || '').toUpperCase().replace(/USDT$|USD$/i, ''); }
function eventKey(event) { return [event.ts, event.exchange, event.symbol, event.side, event.price, event.qty, event.notional].join('|'); }
function extractEvents(json) { if (json && Array.isArray(json.events)) return json.events; if (json && json.data && Array.isArray(json.data.events)) return json.data.events; if (json && Array.isArray(json.data)) return json.data; return null; }
async function fetchJson(url, fetchImpl = fetch) { const response = await fetchImpl(url, { headers: { accept: 'application/json' } }); if (!response.ok) throw new Error(`MarginPad feed HTTP ${response.status}`); return response.json(); }
function historicalRows(json) { const roots = [json?.data, json]; const keys = ['buckets', 'histogram', 'rows', 'series', 'bars', 'points', 'items', 'data']; const seen = new Set(); const queue = roots.map(value => ({ value, depth: 0 })); while (queue.length) { const { value, depth } = queue.shift(); if (!value || depth > 3 || typeof value !== 'object' || seen.has(value)) continue; seen.add(value); if (Array.isArray(value)) { if (value.some(row => row && typeof row === 'object')) return value; continue; } for (const key of keys) if (Array.isArray(value[key]) && value[key].length) return value[key]; for (const child of Object.values(value)) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 }); } return []; }
function numericValue(value) { if (value === null || value === undefined || value === '') return 0; if (typeof value === 'number') return Number.isFinite(value) ? value : 0; if (typeof value === 'object') { for (const key of ['usd', 'value', 'notional', 'amount', 'total', 'volume', 'vol']) { const n = numericValue(value[key]); if (n) return n; } return 0; } const n = Number(String(value).replace(/[$,\s]/g, '')); return Number.isFinite(n) ? n : 0; }
function historicalRowTs(row) { if (Array.isArray(row)) return normalizeTs(row[0]); const aliases = ['ts', 'timestamp', 'time', 't', 'bucket', 'start', 'startTime', 'start_ts', 'startTimeMs', 'bucketStart', 'bucket_start', 'epoch', 'date']; for (const key of aliases) { const ts = normalizeTs(row?.[key]); if (ts) return ts; } if (row && typeof row === 'object') for (const [key, raw] of Object.entries(row)) { if (!/(time|timestamp|bucket|start|epoch|date|^ts$)/i.test(key)) continue; const ts = normalizeTs(raw); if (ts) return ts; } return null; }
function bucketValue(row, names, direction) { for (const name of names) { const value = numericValue(row?.[name]); if (value !== 0) return Math.abs(value); } if (row && typeof row === 'object') for (const [key, raw] of Object.entries(row)) { const lower = key.toLowerCase(); if (!lower.includes(direction)) continue; if (!/(usd|notional|volume|value|amount|liquid)/i.test(lower) && lower !== direction) continue; const value = numericValue(raw); if (value !== 0) return Math.abs(value); } return 0; }

function normalizeHistoricalLiveEvents(json) { const events = extractEvents(json) || []; const buckets = events.map(event => { const ts = normalizeTs(event?.ts); const side = String(event?.side || event?.direction || '').toLowerCase(); const notional = Number(event?.notional ?? event?.usd ?? event?.value ?? event?.amount); const value = Number.isFinite(notional) ? Math.abs(notional) : 0; return { ...event, ts, longUsd: side.includes('long') ? value : 0, shortUsd: side.includes('short') ? value : 0 }; }).filter(row => row.ts && (row.longUsd > 0 || row.shortUsd > 0)); return { ok: true, data: { buckets }, ts: Date.now() }; }

function installHistoricalFetchNormalizer() {
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== 'function' || originalFetch.__marginpadHistoricalNormalizer) return;
  const wrappedFetch = async (...args) => {
    const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url;
    if (requestUrl && requestUrl.includes(HISTORICAL_URL)) {
      const parsed = new URL(requestUrl);
      const minutes = Number(parsed.searchParams.get('minutes') || 1440);
      // 1d must use MarginPad's real historical histogram. The live-event
      // compatibility layer remains unchanged for 15m/1h/4h.
      if (minutes >= 1440) return originalFetch(...args);
      const symbol = parsed.searchParams.get('symbol');
      const liveUrl = `${LIVE_URL}?symbol=${encodeURIComponent(symbol || 'BTC')}&limit=400`;
      const liveResponse = await originalFetch(liveUrl, { headers: { accept: 'application/json' } });
      if (!liveResponse.ok) return liveResponse;
      const liveJson = await liveResponse.json();
      return new Response(JSON.stringify(normalizeHistoricalLiveEvents(liveJson)), { status: liveResponse.status, statusText: liveResponse.statusText, headers: { 'content-type': 'application/json', 'x-marginpad-source': 'liquidations-live' } });
    }
    return originalFetch(...args);
  };
  wrappedFetch.__marginpadHistoricalNormalizer = true;
  globalThis.fetch = wrappedFetch;
}
installHistoricalFetchNormalizer();

async function repairZero1dState() {
  if (!process.env.GITHUB_TOKEN || typeof fetch !== 'function') return;
  try {
    const response = await fetch(STATE_URL, { headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'Polymarket-Perps-Monitor' } });
    if (!response.ok) return;
    const meta = await response.json(); if (!meta?.content || !meta?.sha) return;
    const state = JSON.parse(Buffer.from(meta.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    const dayBucket = Math.floor((Date.now() - 1) / DAY_MS) * DAY_MS;
    const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
    let changed = false;
    for (const symbol of symbols) {
      const current = state?.liquidationTimeframes?.['1d']?.[symbol];
      if (!current || Number(current.events) !== 0 || Number(current.imbalanceUsd) !== 0) continue;
      const recentUrl = `${HISTORICAL_URL}?symbol=${encodeURIComponent(symbol)}&minutes=2880`;
      const recentResponse = await fetch(recentUrl, { headers: { accept: 'application/json' } });
      if (!recentResponse.ok) continue;
      const rows = historicalRows(await recentResponse.json());
      let longUsd = 0, shortUsd = 0, longEvents = 0, shortEvents = 0;
      for (const row of rows) {
        const ts = historicalRowTs(row); if (!ts || Math.floor(ts / DAY_MS) * DAY_MS !== dayBucket) continue;
        const long = bucketValue(row, ['long_liquidations', 'longLiquidations', 'long_usd', 'longUsd', 'long_volume', 'longVolume', 'longNotional', 'long_notional', 'long', 'buy'], 'long');
        const short = bucketValue(row, ['short_liquidations', 'shortLiquidations', 'short_usd', 'shortUsd', 'short_volume', 'shortVolume', 'shortNotional', 'short_notional', 'short', 'sell'], 'short');
        if (long > 0) { longUsd += long; longEvents++; }
        if (short > 0) { shortUsd += short; shortEvents++; }
      }
      if (longUsd === 0 && shortUsd === 0) continue;
      const imbalanceUsd = longUsd - shortUsd;
      current.longUsd = longUsd; current.shortUsd = shortUsd; current.longEvents = longEvents; current.shortEvents = shortEvents; current.events = longEvents + shortEvents; current.imbalanceUsd = imbalanceUsd; current.establishedSign = imbalanceUsd > 0 ? 1 : -1; current.lastBucket = dayBucket; current.buckets = { ...(current.buckets || {}), [dayBucket]: { longUsd, shortUsd, longEvents, shortEvents, events: longEvents + shortEvents } }; changed = true;
      console.log(`REPAIR 1d ${symbol}: long=${longUsd} short=${shortUsd} events=${longEvents + shortEvents}`);
    }
    if (!changed) return;
    const body = { message: 'Repair zero 1d liquidation state from historical histogram', content: Buffer.from(JSON.stringify(state, null, 2)).toString('base64'), branch: process.env.GITHUB_REF_NAME || 'main', sha: meta.sha };
    const saved = await fetch(STATE_URL, { method: 'PUT', headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28', 'user-agent': 'Polymarket-Perps-Monitor', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!saved.ok) console.warn(`1d state repair failed: ${saved.status}`);
  } catch (error) { console.warn(`1d state repair failed: ${error.message}`); }
}
repairZero1dState();

async function fetchLiveFeed(fetchImpl = fetch) { const now = Date.now(); if (liveFeedPromise) return liveFeedPromise; if (now - liveFeedCache.fetchedAt < 3000) return [...liveFeedCache.events.values()]; liveFeedPromise = (async () => { const json = await fetchJson(FEED_URL, fetchImpl); const events = extractEvents(json); if (!events) throw new Error('MarginPad live feed: invalid response shape'); const merged = new Map(liveFeedCache.events); for (const event of events) merged.set(eventKey(event), event); const cutoff = Date.now() - FEED_RETENTION_MS; for (const [key, event] of merged) { const ts = normalizeTs(event.ts); if (!ts || ts < cutoff) merged.delete(key); } liveFeedCache = { fetchedAt: Date.now(), events: merged }; return [...merged.values()]; })(); try { return await liveFeedPromise; } finally { liveFeedPromise = null; } }
async function fetchLiveSymbolFallback(symbol, fetchImpl = fetch) { const normalized = normalizeSymbol(symbol); const url = `${LIVE_URL}?symbol=${encodeURIComponent(normalized)}&limit=400`; const json = await fetchJson(url, fetchImpl); return (extractEvents(json) || []).filter(event => normalizeSymbol(event.symbol) === normalized); }
async function fetchSymbolFeed(symbol, fetchImpl = fetch) { const normalized = normalizeSymbol(symbol); let events = []; try { events = (await fetchLiveFeed(fetchImpl)).filter(event => normalizeSymbol(event.symbol) === normalized); } catch (error) { console.warn(`MarginPad feed ${normalized} failed: ${error.message}`); } if (events.length) return events; const now = Date.now(); const cached = fallbackCache.eventsBySymbol.get(normalized); if (cached && now - fallbackCache.fetchedAt < FALLBACK_REFRESH_MS) return cached; try { const fresh = await fetchLiveSymbolFallback(normalized, fetchImpl); const map = new Map(fallbackCache.eventsBySymbol); map.set(normalized, fresh); fallbackCache = { fetchedAt: now, eventsBySymbol: map }; console.log(`MarginPad live fallback ${normalized}: events=${fresh.length}`); return fresh; } catch (error) { console.warn(`MarginPad live fallback ${normalized} failed: ${error.message}`); return cached || []; } }
async function fetchFeed(symbols = DEFAULT_SYMBOLS, fetchImpl = fetch, now = Date.now()) { const results = await Promise.all(symbols.map(async symbol => [normalizeSymbol(symbol), await fetchSymbolFeed(symbol, fetchImpl)])); return results.flatMap(([, events]) => events); }
function aggregateEvents(events, symbols=DEFAULT_SYMBOLS, now=Date.now()) { const allowed=new Set(symbols.map(normalizeSymbol)); const current=bucketStart(now); const rows=new Map(); for(const event of events||[]){const ts=normalizeTs(event.ts),symbol=normalizeSymbol(event.symbol);if(!ts||!allowed.has(symbol))continue;const bucket=bucketStart(ts);if(bucket>=current)continue;const key=`${bucket}:${symbol}`;if(!rows.has(key))rows.set(key,{bucket,symbol,events:0,longEvents:0,shortEvents:0});const row=rows.get(key);const side=String(event.side||'').toLowerCase();if(!(side.includes('long')||side.includes('short')||side==='buy'||side==='sell'))continue;row.events+=1;if(side.includes('long')||side==='buy')row.longEvents+=1;else row.shortEvents+=1;}return [...rows.values()].sort((a,b)=>b.events-a.events); }
function selectWinner(rows,bucket){return rows.filter(row=>row.bucket===bucket).sort((a,b)=>b.events-a.events)[0]||null;}
module.exports={FEED_URL,LIVE_URL,HISTORICAL_URL,DEFAULT_SYMBOLS,POLL_MS,FALLBACK_REFRESH_MS,WINDOW_MS,FEED_RETENTION_MS,bucketStart,normalizeTs,normalizeSymbol,eventKey,extractEvents,fetchFeed,fetchSymbolFeed,aggregateEvents,selectWinner};