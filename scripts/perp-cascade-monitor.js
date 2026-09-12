const PERPS_REST = 'https://api.perpetuals.polymarket.com';
const PERPS_WS = 'wss://ws.perpetuals.polymarket.com/v1/ws';
const TELEGRAM_API = 'https://api.telegram.org';
const POLYMARKET_BASE = 'https://polymarket.com/perps/asset';
const { openPaperBuy, updateMark, logSnapshot } = require('./paper-trading');

const BUCKET_MS = 5 * 60 * 1000;
const EVAL_MS = 15 * 1000;
const PAPER_LOG_MS = 60 * 1000;
const RECONNECT_MS = 3000;
const MIN_CASCADE_NOTIONAL = 10_000;
const MIN_ACCELERATION = 1.8;
const MAX_EXHAUSTION_RATIO = 0.50;
const MIN_OI_DROP_PCT = 0.50;
const MAX_PRICE_EXTENSION_PCT = 0.35;
const COOLDOWN_MS = 60 * 60 * 1000;
const MAX_BUCKETS_PER_INSTRUMENT = 12;

const instruments = new Map();
const states = new Map();
const lastAlerts = new Map();
let ws = null;
let stopping = false;
let reconnectTimer = null;
let evaluationTimer = null;
let paperLogTimer = null;

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

async function getJson(path) {
  const response = await fetch(`${PERPS_REST}${path}`, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}`);
  return response.json();
}

async function loadInstruments() {
  const data = await getJson('/v1/info/instruments');
  if (!Array.isArray(data) || data.length === 0) throw new Error('No Polymarket Perps instruments returned');
  instruments.clear();
  for (const item of data) {
    const id = Number(item.instrument_id);
    const symbol = String(item.symbol || '').trim().toUpperCase();
    if (Number.isInteger(id) && symbol) instruments.set(id, { id, symbol, category: item.category || null });
  }
  log(`Loaded ${instruments.size} live Polymarket Perps instruments.`);
  log(`Symbols: ${Array.from(instruments.values()).map(x => x.symbol).join(', ')}`);
}

function bucketStart(ts) {
  return Math.floor(ts / BUCKET_MS) * BUCKET_MS;
}

function getState(iid) {
  let state = states.get(iid);
  if (!state) {
    state = { buckets: new Map(), lastOi: null, lastPrice: null };
    states.set(iid, state);
  }
  return state;
}

function getBucket(iid, start) {
  const state = getState(iid);
  let bucket = state.buckets.get(start);
  if (!bucket) {
    bucket = {
      start,
      longNotional: 0,
      shortNotional: 0,
      longQty: 0,
      shortQty: 0,
      trades: 0,
      firstPrice: null,
      lastPrice: null,
      oiOpen: null,
      oiClose: null,
    };
    state.buckets.set(start, bucket);
  }
  return bucket;
}

function pruneBuckets(state, now) {
  const cutoff = bucketStart(now) - MAX_BUCKETS_PER_INSTRUMENT * BUCKET_MS;
  for (const key of state.buckets.keys()) if (key < cutoff) state.buckets.delete(key);
}

function ingestTrade(trade) {
  const iid = Number(trade?.iid ?? trade?.instrument_id ?? trade?.instrumentId);
  const side = String(trade?.side || '').toLowerCase();
  const price = Number(trade?.p ?? trade?.price);
  const qty = Number(trade?.qty ?? trade?.quantity);
  const ts = Number(trade?.ts ?? trade?.timestamp ?? Date.now());
  if (!Number.isInteger(iid) || !instruments.has(iid) || !['long', 'short'].includes(side)) return;
  if (!Number.isFinite(price) || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(ts)) return;
  const bucket = getBucket(iid, bucketStart(ts));
  const notional = Math.abs(price * qty);
  if (bucket.firstPrice === null) bucket.firstPrice = price;
  bucket.lastPrice = price;
  bucket.trades += 1;
  if (side === 'long') {
    bucket.longNotional += notional;
    bucket.longQty += qty;
  } else {
    bucket.shortNotional += notional;
    bucket.shortQty += qty;
  }
}

function ingestTicker(data) {
  const iid = Number(data?.iid ?? data?.instrument_id ?? data?.instrumentId);
  const oi = Number(data?.oi ?? data?.open_interest ?? data?.openInterest);
  const price = Number(data?.mark ?? data?.mark_price ?? data?.markPrice ?? data?.last ?? data?.last_price ?? data?.lastPrice);
  if (!Number.isInteger(iid) || !instruments.has(iid)) return;
  const state = getState(iid);
  const ts = Date.now();
  const current = getBucket(iid, bucketStart(ts));
  if (Number.isFinite(oi)) {
    if (current.oiOpen === null) current.oiOpen = oi;
    current.oiClose = oi;
    state.lastOi = oi;
  }
  if (Number.isFinite(price) && price > 0) {
    if (current.firstPrice === null) current.firstPrice = price;
    current.lastPrice = price;
    state.lastPrice = price;
    updateMark(iid, price);
  }
}

function priceExtensionPct(cascadeDirection, before, exhaustion) {
  const start = before?.lastPrice;
  const end = exhaustion?.lastPrice;
  if (!(Number.isFinite(start) && Number.isFinite(end) && start > 0)) return null;
  const movePct = ((end - start) / start) * 100;
  return cascadeDirection === 'long' ? Math.max(0, movePct) : Math.max(0, -movePct);
}

function analyzeCandidate(iid, now) {
  const state = states.get(iid);
  if (!state) return null;
  const currentStart = bucketStart(now);
  const starts = [currentStart - 3 * BUCKET_MS, currentStart - 2 * BUCKET_MS, currentStart - BUCKET_MS];
  const [b1, b2, b3] = starts.map(start => state.buckets.get(start));
  if (!b1 || !b2 || !b3) return null;
  if (b1.trades + b2.trades + b3.trades < 6) return null;

  const directions = [
    { side: 'long', a: b1.longNotional, c: b2.longNotional, e: b3.longNotional },
    { side: 'short', a: b1.shortNotional, c: b2.shortNotional, e: b3.shortNotional },
  ];

  let best = null;
  for (const flow of directions) {
    if (flow.a <= 0 || flow.c <= 0) continue;
    const acceleration = flow.c / flow.a;
    const exhaustionRatio = flow.e / flow.c;
    const oiBefore = b2.oiClose ?? b2.oiOpen;
    const oiAfter = b3.oiClose ?? b3.oiOpen;
    const oiDropPct = Number.isFinite(oiBefore) && oiBefore > 0 && Number.isFinite(oiAfter)
      ? ((oiBefore - oiAfter) / oiBefore) * 100
      : null;
    const extensionPct = priceExtensionPct(flow.side, b2, b3);
    if (flow.c < MIN_CASCADE_NOTIONAL) continue;
    if (acceleration < MIN_ACCELERATION) continue;
    if (exhaustionRatio > MAX_EXHAUSTION_RATIO) continue;
    if (oiDropPct === null || oiDropPct < MIN_OI_DROP_PCT) continue;
    if (extensionPct === null || extensionPct > MAX_PRICE_EXTENSION_PCT) continue;

    const score = Math.min(5, acceleration / MIN_ACCELERATION)
      + Math.min(3, (1 - exhaustionRatio) / (1 - MAX_EXHAUSTION_RATIO))
      + Math.min(3, oiDropPct / MIN_OI_DROP_PCT)
      + Math.min(2, Math.max(0, MAX_PRICE_EXTENSION_PCT - extensionPct) / MAX_PRICE_EXTENSION_PCT);

    const candidate = {
      iid,
      symbol: instruments.get(iid).symbol,
      cascadeSide: flow.side,
      signalSide: flow.side === 'long' ? 'LONG' : 'SHORT',
      cascadeNotional: flow.c,
      acceleration,
      exhaustionRatio,
      oiDropPct,
      extensionPct,
      price: b3.lastPrice ?? b3.firstPrice,
      periodStart: b1.start,
      periodEnd: b3.start + BUCKET_MS,
      score,
    };
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function formatPct(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}%` : 'n/a';
}

function marketUrl(symbol) {
  return `${POLYMARKET_BASE}/${encodeURIComponent(symbol.toLowerCase())}`;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required');
  const response = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: false }),
  });
  if (!response.ok) throw new Error(`Telegram HTTP ${response.status}`);
}

async function evaluate(now = Date.now()) {
  const candidates = [];
  for (const iid of instruments.keys()) {
    const candidate = analyzeCandidate(iid, now);
    if (candidate) candidates.push(candidate);
  }
  candidates.sort((a, b) => b.score - a.score);
  if (candidates.length === 0) {
    log('No cascade-exhaustion setup in the latest closed 15m window.');
    return;
  }
  const candidate = candidates[0];
  const previous = lastAlerts.get(candidate.iid) || 0;
  if (now - previous < COOLDOWN_MS) {
    log(`Setup suppressed by cooldown: ${candidate.symbol} ${candidate.signalSide}.`);
    return;
  }
  lastAlerts.set(candidate.iid, now);

  const paperPosition = openPaperBuy({
    iid: candidate.iid,
    symbol: candidate.symbol,
    price: candidate.price,
    signalSide: candidate.signalSide,
    alertTime: now,
  });
  if (!paperPosition) {
    log(`PAPER BUY skipped: invalid entry price for ${candidate.symbol}.`);
    return;
  }

  const period = `${new Date(candidate.periodStart).toISOString()} → ${new Date(candidate.periodEnd).toISOString()}`;
  const message = [
    `⚡ ${candidate.symbol} · PERP CASCADE EXHAUSTION`,
    `Signal: ${candidate.signalSide}`,
    `Cascade: ${candidate.cascadeSide.toUpperCase()} flow`,
    `Cascade notional: ${formatUsd(candidate.cascadeNotional)}`,
    `Acceleration: ${candidate.acceleration.toFixed(2)}x`,
    `Exhaustion: ${(candidate.exhaustionRatio * 100).toFixed(0)}% of peak`,
    `OI drop: ${formatPct(candidate.oiDropPct)}`,
    `Price extension: ${formatPct(candidate.extensionPct)}`,
    `Score: ${candidate.score.toFixed(1)}`,
    `Period: ${period} UTC`,
    `PAPER BUY: $1.00 @ ${candidate.price}`,
    `Paper position: ${paperPosition.id}`,
    `➡️ Polymarket Perp`,
    marketUrl(candidate.symbol),
  ].join('\n');
  await sendTelegram(message);
  log(`ALERT ${candidate.symbol} ${candidate.signalSide} score=${candidate.score.toFixed(1)} oiDrop=${formatPct(candidate.oiDropPct)} extension=${formatPct(candidate.extensionPct)}`);
  log(`PAPER BUY ${paperPosition.id}: ${candidate.symbol} $1.00 @ ${candidate.price}; open positions are now tracked from live ticker marks.`);
  logSnapshot(log);
}

function scheduleEvaluation() {
  if (evaluationTimer) clearInterval(evaluationTimer);
  evaluationTimer = setInterval(() => {
    const now = Date.now();
    const boundary = bucketStart(now);
    const msIntoBucket = now - boundary;
    if (msIntoBucket < 20_000) evaluate(now).catch(error => log(`Evaluation error: ${error.message}`));
    for (const state of states.values()) pruneBuckets(state, now);
  }, EVAL_MS);
}

function schedulePaperLogging() {
  if (paperLogTimer) clearInterval(paperLogTimer);
  paperLogTimer = setInterval(() => logSnapshot(log), PAPER_LOG_MS);
}

function connect() {
  if (stopping) return;
  try {
    ws = new WebSocket(PERPS_WS);
    ws.onopen = () => {
      log('Connected to Polymarket Perps public WebSocket.');
      const channels = ['tickers::all'];
      for (const iid of instruments.keys()) channels.push(`trades::${iid}`);
      ws.send(JSON.stringify({ id: 1, req: 'sub', chs: channels }));
      log(`Subscribed to ${channels.length} public Perps channels.`);
    };
    ws.onmessage = event => {
      let frame;
      try { frame = JSON.parse(String(event.data)); } catch { return; }
      if (!frame || !frame.ch) return;
      const channel = String(frame.ch);
      if (channel.startsWith('trades::')) {
        if (!Array.isArray(frame.data)) return;
        for (const trade of frame.data) ingestTrade(trade);
      } else if (channel.startsWith('tickers::')) {
        if (Array.isArray(frame.data)) {
          for (const ticker of frame.data) ingestTicker(ticker);
        } else {
          ingestTicker(frame.data);
        }
      }
    };
    ws.onerror = () => log('Perps WebSocket error.');
    ws.onclose = () => {
      if (stopping) return;
      log(`Perps WebSocket closed; reconnecting in ${RECONNECT_MS / 1000}s.`);
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, RECONNECT_MS);
    };
  } catch (error) {
    log(`WebSocket connection error: ${error.message}`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, RECONNECT_MS);
  }
}

async function main() {
  await loadInstruments();
  scheduleEvaluation();
  schedulePaperLogging();
  connect();
  log(`Perp Cascade Exhaustion Monitor started: 15m setup, all ${instruments.size} live instruments.`);
  log('Paper trading: every alert executes a simulated BUY for exactly $1.00 at the alert price; no real order is sent.');
  log('Paper positions remain open and are marked to live ticker prices until the monitor process stops.');
  log(`Rules: acceleration >= ${MIN_ACCELERATION}x; exhaustion <= ${MAX_EXHAUSTION_RATIO * 100}%; OI drop >= ${MIN_OI_DROP_PCT}%; price extension <= ${MAX_PRICE_EXTENSION_PCT}%; cooldown=${COOLDOWN_MS / 60000}m.`);
  log('Liquidations are not exposed in the public Perps market-data stream; the strategy therefore uses directional flow + OI contraction as a liquidation-pressure proxy.');
}

function shutdown() {
  stopping = true;
  clearInterval(evaluationTimer);
  clearInterval(paperLogTimer);
  clearTimeout(reconnectTimer);
  logSnapshot(log);
  try { ws?.close(); } catch {}
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch(error => { console.error(error); process.exitCode = 1; });
