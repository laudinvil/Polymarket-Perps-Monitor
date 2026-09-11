const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('../src/telegram');

const API_KEY = String(process.env.ODDS_API_KEY || '').trim();
const API_BASE = 'https://api.odds-api.io/v3';
const SPORT = String(process.env.ODDS_SPORT || 'football').trim();
const LEAGUE = String(process.env.ODDS_LEAGUE || 'england-premier-league').trim();
const BOOKMAKERS = String(process.env.ODDS_BOOKMAKERS || 'Bet365,Unibet').split(',').map(s => s.trim()).filter(Boolean);
const MARKET = String(process.env.ODDS_MARKET || 'Totals').trim();
const SELECTION = String(process.env.ODDS_SELECTION || 'over').trim();
const TARGET_LINE = process.env.ODDS_LINE === undefined ? 2.5 : Number(process.env.ODDS_LINE);
const MOVE_THRESHOLD = Number(process.env.ODDS_MOVE_THRESHOLD_PERCENT || 5);
const MIN_BOOKMAKERS = Math.max(1, Number(process.env.ODDS_MIN_BOOKMAKERS || 2));
const DIRECTION = String(process.env.ODDS_MOVE_DIRECTION || 'down').toLowerCase();
const POLL_MS = Math.max(60_000, Number(process.env.ODDS_POLL_SECONDS || 600) * 1000);
const EVENTS_REFRESH_MS = Math.max(5 * 60_000, Number(process.env.ODDS_EVENTS_REFRESH_MINUTES || 30) * 60_000);
const LOOKAHEAD_HOURS = Math.max(1, Number(process.env.ODDS_LOOKAHEAD_HOURS || 48));
const MAX_EVENTS = Math.max(1, Number(process.env.ODDS_MAX_EVENTS || 12));
const STATE_FILE = path.resolve('.line-movement-state.json');
const HISTORY_FILE = path.resolve('line-movement-history.log');

if (!API_KEY) {
  console.error('LINE MOVE FATAL: ODDS_API_KEY is not configured');
  process.exit(1);
}
if (!BOOKMAKERS.length) {
  console.error('LINE MOVE FATAL: ODDS_BOOKMAKERS is empty');
  process.exit(1);
}
if (!Number.isFinite(TARGET_LINE)) {
  console.error('LINE MOVE FATAL: ODDS_LINE must be numeric');
  process.exit(1);
}

const state = {
  updatedAt: null,
  eventsUpdatedAt: 0,
  events: {},
  prices: {},
  armed: {},
};

function saveState() {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
}

function loadState() {
  try {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (saved && typeof saved === 'object') Object.assign(state, saved);
    state.events = state.events && typeof state.events === 'object' ? state.events : {};
    state.prices = state.prices && typeof state.prices === 'object' ? state.prices : {};
    state.armed = state.armed && typeof state.armed === 'object' ? state.armed : {};
    console.log(`LINE MOVE STATE RESTORED events=${Object.keys(state.events).length} prices=${Object.keys(state.prices).length}`);
  } catch {
    console.log('LINE MOVE STATE: no usable state; starting with fresh baselines');
  }
}

function appendHistory(row) {
  fs.appendFileSync(HISTORY_FILE, JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n');
}

async function getJson(endpoint, params) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.searchParams.set('apiKey', API_KEY);
  for (const [key, value] of Object.entries(params || {})) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Odds API ${response.status}: ${text.slice(0, 250)}`);
  try { return JSON.parse(text); } catch { throw new Error('Odds API returned invalid JSON'); }
}

function eventAllowed(event) {
  if (!event || event.status && event.status !== 'pending') return false;
  const date = Date.parse(event.date || '');
  if (!Number.isFinite(date)) return false;
  const now = Date.now();
  return date >= now && date <= now + LOOKAHEAD_HOURS * 60 * 60 * 1000;
}

async function refreshEvents(force = false) {
  if (!force && Date.now() - Number(state.eventsUpdatedAt || 0) < EVENTS_REFRESH_MS && Object.keys(state.events).length) return;
  const events = await getJson('events', { sport: SPORT, league: LEAGUE, status: 'pending' });
  const selected = (Array.isArray(events) ? events : []).filter(eventAllowed).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)).slice(0, MAX_EVENTS);
  const next = {};
  for (const event of selected) next[String(event.id)] = { id: event.id, home: event.home, away: event.away, date: event.date, league: event.league, urls: event.urls || {} };
  state.events = next;
  state.eventsUpdatedAt = Date.now();
  saveState();
  console.log(`EVENTS refreshed sport=${SPORT} league=${LEAGUE} selected=${selected.length} max=${MAX_EVENTS}`);
}

function marketRows(payload, bookmaker) {
  const markets = payload?.bookmakers?.[bookmaker];
  if (!Array.isArray(markets)) return [];
  return markets.filter(m => String(m?.name || '').toLowerCase() === MARKET.toLowerCase());
}

function extractSelection(market) {
  const odds = Array.isArray(market?.odds) ? market.odds : [];
  for (const row of odds) {
    if (TARGET_LINE !== null && Number.isFinite(TARGET_LINE) && row?.hdp !== undefined && Math.abs(Number(row.hdp) - TARGET_LINE) > 1e-9) continue;
    const value = row?.[SELECTION];
    const price = Number(value);
    if (Number.isFinite(price) && price > 1) return { price, line: row?.hdp !== undefined ? Number(row.hdp) : null, updatedAt: market?.updatedAt || null };
  }
  return null;
}

function priceMovePercent(previous, current) {
  if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(current)) return null;
  return ((current / previous) - 1) * 100;
}

function directionAllowed(move) {
  if (DIRECTION === 'both') return Math.abs(move) >= MOVE_THRESHOLD;
  if (DIRECTION === 'up') return move >= MOVE_THRESHOLD;
  return move <= -MOVE_THRESHOLD;
}

function formatPct(value) {
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}

function formatOdds(value) {
  return Number(value).toFixed(2);
}

function eventKey(eventId) {
  return `${eventId}|${MARKET}|${TARGET_LINE}|${SELECTION}`;
}

function makeAlert(event, rows, move) {
  const date = new Date(event.date).toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour12: false });
  const lines = [`⚡ LINE MOVE`, ``, `${event.home} — ${event.away}`, `Market: ${MARKET}${Number.isFinite(TARGET_LINE) ? ` ${SELECTION === 'over' ? 'Over' : SELECTION === 'under' ? 'Under' : ''} ${TARGET_LINE}`.replace(/\s+/g, ' ').trim() : ''}`, ``];
  for (const row of rows) lines.push(`${row.bookmaker.padEnd(9)} ${formatOdds(row.previous)} → ${formatOdds(row.current)}`);
  lines.push(`Move: ${formatPct(move)}`);
  lines.push(`Kickoff: ${date} UTC+3`);
  const preferred = BOOKMAKERS.find(bookmaker => event.urls?.[bookmaker]);
  if (preferred) lines.push(`➡️ MARKET · ${preferred}\n${event.urls[preferred]}`);
  return lines.join('\n');
}

async function pollEvent(event) {
  const payload = await getJson('odds', { eventId: event.id, bookmakers: BOOKMAKERS.join(',') });
  const current = [];
  const key = eventKey(event.id);
  const previous = state.prices[key] || {};
  for (const bookmaker of BOOKMAKERS) {
    const markets = marketRows(payload, bookmaker);
    const selected = markets.map(extractSelection).find(Boolean);
    if (!selected) continue;
    const old = previous[bookmaker];
    current.push({ bookmaker, current: selected.price, line: selected.line, updatedAt: selected.updatedAt, previous: old?.price ?? null });
  }
  if (!current.length) return;

  const candidates = current.filter(row => Number.isFinite(row.previous) && directionAllowed(priceMovePercent(row.previous, row.current)));
  const groupedMove = candidates.length ? candidates.reduce((sum, row) => sum + priceMovePercent(row.previous, row.current), 0) / candidates.length : null;
  const armed = state.armed[key] !== false;

  if (candidates.length >= MIN_BOOKMAKERS && armed && groupedMove !== null) {
    const message = makeAlert(event, candidates, groupedMove);
    await sendTelegramMessage(message);
    appendHistory({ type: 'line_move_alert', eventId: event.id, home: event.home, away: event.away, market: MARKET, selection: SELECTION, line: TARGET_LINE, bookmakers: candidates.map(row => ({ bookmaker: row.bookmaker, previous: row.previous, current: row.current, movePercent: priceMovePercent(row.previous, row.current) })), movePercent: groupedMove, marketUrl: BOOKMAKERS.map(bookmaker => event.urls?.[bookmaker]).find(Boolean) || null });
    console.log(`LINE MOVE ALERT event=${event.id} ${event.home} vs ${event.away} market=${MARKET} selection=${SELECTION} line=${TARGET_LINE} books=${candidates.length} move=${formatPct(groupedMove)}`);
    state.armed[key] = false;
  } else if (candidates.length === 0) {
    state.armed[key] = true;
  }

  const nextPrices = {};
  for (const row of current) nextPrices[row.bookmaker] = { price: row.current, line: row.line, updatedAt: row.updatedAt };
  state.prices[key] = nextPrices;
}

async function pollAll() {
  await refreshEvents(false);
  const events = Object.values(state.events);
  for (const event of events) {
    try { await pollEvent(event); }
    catch (error) { console.warn(`EVENT ${event.id} ${event.home} vs ${event.away} FAILED: ${error.message}`); }
  }
  state.updatedAt = new Date().toISOString();
  saveState();
  console.log(`LINE MOVE POLL complete events=${events.length} interval=${Math.round(POLL_MS / 1000)}s threshold=${MOVE_THRESHOLD}% direction=${DIRECTION} minBooks=${MIN_BOOKMAKERS}`);
}

async function main() {
  loadState();
  console.log(`LINE MOVEMENT MONITOR STARTED; source=Odds-API.io sport=${SPORT} league=${LEAGUE} market=${MARKET} selection=${SELECTION} line=${TARGET_LINE} bookmakers=${BOOKMAKERS.join(',')} poll=${Math.round(POLL_MS / 1000)}s eventsRefresh=${Math.round(EVENTS_REFRESH_MS / 60000)}m`);
  console.log(`LINE MOVE RULE: alert when at least ${MIN_BOOKMAKERS} configured bookmakers move ${DIRECTION} by >=${MOVE_THRESHOLD}% between consecutive snapshots; one alert per move until the move resets.`);
  while (true) {
    const started = Date.now();
    try { await pollAll(); }
    catch (error) { console.error(`LINE MOVE LOOP FAILED: ${error.stack || error.message}`); }
    const sleep = Math.max(1000, POLL_MS - (Date.now() - started));
    await new Promise(resolve => setTimeout(resolve, sleep));
  }
}

main().catch(error => { console.error(`LINE MOVE FATAL: ${error.stack || error.message}`); process.exitCode = 1; });
