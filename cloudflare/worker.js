const MARGINPAD_BASE = 'https://marginpad.io/api/v1/liquidations/live';
const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
const MARKET_BASE_URL = 'https://polymarket.com/event';
const TELEGRAM_API = 'https://api.telegram.org';
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_MS = 5 * 60 * 1000;
const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BUFFER_TTL_MS = 15 * 60 * 1000;
const GRACE_BUCKETS = 2;
const POLL_INTERVAL_MS = 30 * 1000;
const FEED_ALERT_COOLDOWN_MS = 10 * 60 * 1000;
const FEED_HEARTBEAT_MS = 10 * 60 * 1000;
const VERSION = '2026-09-03-marginpad-symbol-live-1';

function bucketStart(ts) { return Math.floor(Number(ts) / WINDOW_MS) * WINDOW_MS; }
function normalizeTs(value) { const n = Number(value); if (!Number.isFinite(n)) return null; return n < 1e12 ? n * 1000 : n; }
function normalizeSymbol(symbol) { return String(symbol || '').toUpperCase().replace(/USDT$|USD$/i, ''); }
function extractEvents(json) {
  if (json && Array.isArray(json.events)) return json.events;
  if (json?.data && Array.isArray(json.data.events)) return json.data.events;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}
function eventKey(event) { return [event.ts, event.exchange, event.symbol, event.side, event.price, event.qty, event.notional].join('|'); }
async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}
async function fetchSymbolEvents(symbol) {
  const url = `${MARGINPAD_BASE}?symbol=${encodeURIComponent(symbol)}&limit=400`;
  return extractEvents(await fetchJson(url));
}
async function fetchLiquidationEvents() {
  const results = await Promise.allSettled(SYMBOLS.map(fetchSymbolEvents));
  const events = [];
  const errors = [];
  results.forEach((result, i) => {
    if (result.status === 'fulfilled') events.push(...result.value);
    else errors.push(`${SYMBOLS[i]}: ${result.reason?.message || 'request failed'}`);
  });
  if (events.length === 0 && errors.length === SYMBOLS.length) throw new Error(`All MarginPad symbol feeds failed: ${errors.join('; ')}`);
  return { events, errors };
}
async function mergeBuffer(storage, incoming, now) {
  const cutoff = now - BUFFER_TTL_MS;
  const previous = (await storage.get('event_buffer')) || [];
  const merged = new Map();
  for (const event of previous) { const ts = normalizeTs(event.ts); if (ts && ts >= cutoff) merged.set(eventKey(event), event); }
  let added = 0;
  for (const event of incoming) { const ts = normalizeTs(event.ts); if (!ts || ts < cutoff) continue; const key = eventKey(event); if (!merged.has(key)) added += 1; merged.set(key, event); }
  const events = [...merged.values()].sort((a, b) => (normalizeTs(a.ts) || 0) - (normalizeTs(b.ts) || 0));
  if (added > 0 || previous.length !== events.length) await storage.put('event_buffer', events);
  return { events, added };
}
function selectWinner(events, targetBucket) {
  const rows = new Map(); const allowed = new Set(SYMBOLS);
  for (const event of events) {
    const ts = normalizeTs(event.ts); const symbol = normalizeSymbol(event.symbol);
    if (!ts || !allowed.has(symbol) || bucketStart(ts) !== targetBucket) continue;
    if (!rows.has(symbol)) rows.set(symbol, { symbol, events: 0, longEvents: 0, shortEvents: 0, notionalUsd: 0, longNotionalUsd: 0, shortNotionalUsd: 0 });
    const row = rows.get(symbol); const notional = Number(event.notional) || 0; const side = String(event.side || '').toLowerCase();
    row.events += 1; row.notionalUsd += notional;
    if (side.includes('long') || side === 'buy') { row.longEvents += 1; row.longNotionalUsd += notional; }
    else if (side.includes('short') || side === 'sell') { row.shortEvents += 1; row.shortNotionalUsd += notional; }
  }
  return [...rows.values()].sort((a,b) => b.notionalUsd - a.notionalUsd || b.events - a.events)[0] || null;
}
function formatUsd(value) { return `$${Math.round(Number(value) || 0).toLocaleString('en-US')}`; }
async function findMarketByEpoch(symbol, epoch) {
  const asset = String(symbol || '').trim().toLowerCase(); if (!asset) return null;
  const slug = `${asset}-updown-5m-${epoch}`;
  try { const market = await fetchJson(`${GAMMA_BASE_URL}/markets/slug/${encodeURIComponent(slug)}`); if (market && market.slug === slug && market.active === true && market.closed !== true) return { slug, url: `${MARKET_BASE_URL}/${slug}` }; } catch (_) {}
  return null;
}
async function findCurrentMarket(symbol, now) { return findMarketByEpoch(symbol, Math.floor(bucketStart(now) / 1000)); }
async function findNextMarket(symbol, now) { const start = bucketStart(now) + WINDOW_MS; for (let i = 0; i < 6; i += 1) { const market = await findMarketByEpoch(symbol, Math.floor((start + i * WINDOW_MS) / 1000)); if (market) return market; } return null; }
async function sendTelegram(runtimeEnv, text) {
  const token = runtimeEnv?.TELEGRAM_BOT_TOKEN; const chatId = runtimeEnv?.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }), signal: AbortSignal.timeout(10000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) throw new Error(`Telegram HTTP ${response.status}: ${data.description || 'unknown error'}`);
  return data.result;
}
function getMonitor(env) { return env.MONITOR.get(env.MONITOR.idFromName('global')); }
function internalHeaders(env) { return { 'content-type': 'application/json', 'x-telegram-bot-token': env.TELEGRAM_BOT_TOKEN || '', 'x-telegram-chat-id': env.TELEGRAM_CHAT_ID || '' }; }
function runtimeEnvFromRequest(request, baseEnv) { return { ...baseEnv, TELEGRAM_BOT_TOKEN: request.headers.get('x-telegram-bot-token') || baseEnv?.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: request.headers.get('x-telegram-chat-id') || baseEnv?.TELEGRAM_CHAT_ID }; }

export class MonitorState {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async cleanup(now) { const index = (await this.ctx.storage.get('sent_index')) || []; const cutoff = now - SENT_TTL_MS; const keep = []; for (const bucketId of index) { if (Number(bucketId) >= cutoff) keep.push(bucketId); else await this.ctx.storage.delete(`sent:${bucketId}`); } if (keep.length !== index.length) await this.ctx.storage.put('sent_index', keep); }
  async recordFeedHealth(now, incoming, feedErrors, runtimeEnv) {
    const previous = (await this.ctx.storage.get('feed_health')) || {};
    const health = { ok: feedErrors.length < SYMBOLS.length, source: 'marginpad_symbol_live', lastSuccessAt: now, lastEventTs: incoming.reduce((max, e) => Math.max(max, normalizeTs(e.ts) || 0), Number(previous.lastEventTs) || 0), lastEventCount: incoming.length, totalPolls: (Number(previous.totalPolls) || 0) + 1, partialErrors: feedErrors, lastError: feedErrors.length ? feedErrors.join('; ') : null, lastErrorAt: feedErrors.length ? now : null };
    const lastHeartbeat = Number(previous.lastHeartbeatAt) || 0;
    if (previous.ok === false && health.ok) { try { await sendTelegram(runtimeEnv, `🟢 MARGINPAD LIQUIDATION FEEDS RECOVERED\n\nPer-symbol live feeds are reachable again.\nEvents in latest poll: ${incoming.length}\nTime: ${new Date(now).toISOString().slice(11,16)} UTC`); health.lastHeartbeatAt = now; } catch (e) { health.telegramError = e.message; } }
    else if (health.ok && now - lastHeartbeat >= FEED_HEARTBEAT_MS) { try { await sendTelegram(runtimeEnv, `📡 MARGINPAD LIQUIDATION FEEDS OK\n\nSource: /liquidations/live per symbol\nEvents in latest poll: ${incoming.length}\nSymbols: ${SYMBOLS.join(', ')}\nPoll interval: 30s\nTime: ${new Date(now).toISOString().slice(11,16)} UTC`); health.lastHeartbeatAt = now; } catch (e) { health.telegramError = e.message; } }
    await this.ctx.storage.put('feed_health', health); return health;
  }
  async recordFeedFailure(now, error, runtimeEnv) {
    const previous = (await this.ctx.storage.get('feed_health')) || {}; const health = { ...previous, ok: false, source: 'marginpad_symbol_live', lastError: error.message, lastErrorAt: now, totalFailures: (Number(previous.totalFailures) || 0) + 1 };
    const lastNotice = Number(previous.lastNoticeAt) || 0;
    if (now - lastNotice >= FEED_ALERT_COOLDOWN_MS) { try { await sendTelegram(runtimeEnv, `🚨 MARGINPAD LIQUIDATION FEEDS ERROR\n\nAll per-symbol liquidation requests failed.\nError: ${error.message}\nTime: ${new Date(now).toISOString().slice(11,16)} UTC`); health.lastNoticeAt = now; } catch (telegramError) { health.telegramError = telegramError.message; } }
    await this.ctx.storage.put('feed_health', health); return health;
  }
  async process(now, runtimeEnv) {
    const current = bucketStart(now); const targets = [current - WINDOW_MS, current - 2 * WINDOW_MS, current - 3 * WINDOW_MS].slice(0, GRACE_BUCKETS + 1);
    let incoming, feedErrors;
    try { ({ events: incoming, errors: feedErrors } = await fetchLiquidationEvents()); await this.recordFeedHealth(now, incoming, feedErrors, runtimeEnv); }
    catch (error) { await this.recordFeedFailure(now, error, runtimeEnv); throw error; }
    const { events, added } = await mergeBuffer(this.ctx.storage, incoming, now); const results = [];
    for (const target of targets) {
      const bucketId = String(target); if (await this.ctx.storage.get(`sent:${bucketId}`)) continue;
      const winner = selectWinner(events, target); if (!winner || winner.notionalUsd <= 0) { results.push({ bucket: new Date(target).toISOString(), reason: 'no_liquidations' }); continue; }
      const [currentMarket, nextMarket] = await Promise.all([findCurrentMarket(winner.symbol, now), findNextMarket(winner.symbol, now)]); const bucketLabel = new Date(target).toISOString().slice(11,16);
      let text = ['🔥 LIQUIDATION SPIKE', `${winner.symbol} · 5M · ${bucketLabel} UTC`, '', `Liquidations: ${winner.events}`, `Long: ${winner.longEvents} · Short: ${winner.shortEvents}`, `Volume: ${formatUsd(winner.notionalUsd)}`, `Long volume: ${formatUsd(winner.longNotionalUsd)}`, `Short volume: ${formatUsd(winner.shortNotionalUsd)}`].join('\n');
      text += currentMarket ? `\n\n🔴 Current Polymarket 5M\n${currentMarket.url}` : '\n\n🔴 Current Polymarket 5M\nMarket not found'; text += nextMarket ? `\n\n➡️ Next Polymarket 5M\n${nextMarket.url}` : '\n\n➡️ Next Polymarket 5M\nMarket not found yet';
      const sent = await sendTelegram(runtimeEnv, text); await this.ctx.storage.put(`sent:${bucketId}`, { result: 'sent', messageId: sent?.message_id || null, at: Date.now() }); const index = (await this.ctx.storage.get('sent_index')) || []; if (!index.includes(bucketId)) await this.ctx.storage.put('sent_index', [...index, bucketId]);
      results.push({ bucket: new Date(target).toISOString(), sent: true, winner, telegramMessageId: sent?.message_id || null });
    }
    await this.ctx.storage.put('last_result', { ok: true, at: Date.now(), source: 'marginpad_symbol_live', addedEvents: added, feedEvents: incoming.length, bufferedEvents: events.length, feedErrors, checkedBuckets: targets.map(t => new Date(t).toISOString()), results }); await this.cleanup(now); return { ok: true, results, feedEvents: incoming.length, bufferedEvents: events.length, addedEvents: added, feedErrors };
  }
  async scheduleNext() { await this.ctx.storage.setAlarm(Date.now() + POLL_INTERVAL_MS); }
  async alarm() { try { const result = await this.process(Date.now(), this.env); await this.ctx.storage.put('last_alarm', { at: Date.now(), ok: true, result }); } catch (error) { await this.ctx.storage.put('last_result', { ok: false, error: error.message, at: Date.now(), source: 'marginpad_symbol_live' }); await this.ctx.storage.put('last_alarm', { at: Date.now(), ok: false, error: error.message }); } finally { await this.scheduleNext(); } }
  async fetch(request) {
    const url = new URL(request.url); const runtimeEnv = runtimeEnvFromRequest(request, this.env);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'polymarket-perps-monitor', version: VERSION, pollIntervalMs: POLL_INTERVAL_MS, source: 'MarginPad /liquidations/live per symbol', lastCronSeen: (await this.ctx.storage.get('last_cron_seen')) || null, feedHealth: (await this.ctx.storage.get('feed_health')) || null, lastAlarm: (await this.ctx.storage.get('last_alarm')) || null, lastResult: (await this.ctx.storage.get('last_result')) || null });
    if (url.pathname === '/run' && request.method === 'POST') { const body = await request.json().catch(() => ({})); try { await this.scheduleNext(); return Response.json(await this.process(Number(body.now) || Date.now(), runtimeEnv)); } catch (error) { const failure = { ok: false, error: error.message, at: Date.now() }; await this.ctx.storage.put('last_result', failure); return Response.json(failure, { status: 500 }); } }
    return new Response('Not found', { status: 404 });
  }
}
async function bootstrapAlarm(env) { const monitor = getMonitor(env); return monitor.fetch('https://monitor/run', { method: 'POST', headers: internalHeaders(env), body: JSON.stringify({ now: Date.now() }) }); }
export default {
  async scheduled(controller, env, ctx) { const monitor = getMonitor(env); ctx.waitUntil((async () => { await monitor.storage.put('last_cron_seen', { at: Date.now(), scheduledTime: controller.scheduledTime, version: VERSION }); await bootstrapAlarm(env); })().catch(error => console.error(JSON.stringify({ ok: false, error: error.message })))); },
  async fetch(request, env) { const url = new URL(request.url); if (url.pathname === '/health') return getMonitor(env).fetch('https://monitor/health', { headers: internalHeaders(env) }); if (url.pathname === '/run' && request.method === 'POST') { try { await bootstrapAlarm(env); return Response.json({ ok: true, started: true, version: VERSION }); } catch (error) { return Response.json({ ok: false, error: error.message }, { status: 500 }); } } return new Response('Polymarket Perps Monitor', { status: 200 }); },
};