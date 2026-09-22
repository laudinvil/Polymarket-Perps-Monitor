const { env } = require('node:process');

const { executeTrade } = require('./polymarket-auto-trader');

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

const PERIOD = 300000;
const ALERT_LEAD_MS = 0;
const MIN_SIGNAL_SCORE = 2;
const CONFIRMATIONS_REQUIRED = 2;
const DISTANCE_THRESHOLD_BPS = 0.5;
const MOMENTUM_THRESHOLD_BPS = 0.20;
const FLOW_THRESHOLD = 0.04;
const DEPTH_THRESHOLD = 0.05;
const MICRO_THRESHOLD_BPS = 0.15;
const CONFIRMATION_INTERVAL_MS = 5000;
const COINS = ['BTC'];
const FETCH_TIMEOUT_MS = 7000;
const RUN_MS = 358 * 60 * 1000;

const BINANCE_DEPTH_URL = 'wss://fstream.binance.com/public/stream?streams=btcusdt@depth20@100ms';
const BINANCE_TRADE_URL = 'wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade';
const RTDS_URL = 'wss://ws-live-data.polymarket.com';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const boundaryNow = () => Math.floor(Date.now() / PERIOD) * PERIOD;
const marketSlug = (coin, start) => coin.toLowerCase() + '-updown-5m-' + Math.floor(start / 1000);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const sign = value => value > 0 ? 1 : value < 0 ? -1 : 0;

async function fetchTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, options = {}) {
  const response = await fetchTimeout(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers || {}) }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(new URL(url).hostname + ' ' + response.status + ': ' + body);
  return JSON.parse(body);
}

class ReferenceFeed {
  constructor() {
    this.ticks = [];
    this.ws = null;
    this.timer = null;
    this.lastMessage = 0;
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.ws?.close();
  }

  connect() {
    if (this.stopped) return;
    const ws = this.ws = new WebSocket(RTDS_URL);

    ws.onopen = () => {
      this.lastMessage = Date.now();
      ws.send(JSON.stringify({
        action: 'subscribe',
        subscriptions: [
          { topic: 'crypto_prices_chainlink', type: '*', filters: JSON.stringify({ symbol: 'btc/usd' }) },
          { topic: 'crypto_prices_twap_sixty', type: 'update', filters: JSON.stringify({ symbol: 'btc/usd' }) }
        ]
      }));
      clearInterval(this.timer);
      this.timer = setInterval(() => {
        if (Date.now() - this.lastMessage > 20000) {
          ws.close();
          return;
        }
        if (ws.readyState === WebSocket.OPEN) ws.send('PING');
      }, 5000);
    };

    ws.onmessage = event => {
      this.lastMessage = Date.now();
      try {
        const msg = JSON.parse(String(event.data));
        const topic = msg?.topic;
        if (topic !== 'crypto_prices_chainlink' && topic !== 'crypto_prices_twap_sixty') return;
        if (msg?.payload?.symbol !== 'btc/usd') return;

        const raw = Array.isArray(msg.payload.data) ? msg.payload.data : [msg.payload.data ?? msg.payload];
        for (const item of raw) {
          const timestamp = Number(item?.timestamp);
          const price = Number(item?.value);
          if (!Number.isFinite(timestamp) || !Number.isFinite(price)) continue;
          if (timestamp > Date.now() + 2000 || timestamp < Date.now() - 1800000) continue;
          this.ticks.push({
            source: topic === 'crypto_prices_twap_sixty' ? 'twap60' : 'spot',
            timestamp,
            price
          });
        }
        this.ticks.sort((a, b) => a.timestamp - b.timestamp);
        this.ticks = this.ticks.slice(-10000);
      } catch {}
    };

    ws.onerror = () => ws.close();
    ws.onclose = () => {
      clearInterval(this.timer);
      if (!this.stopped) setTimeout(() => this.connect(), 1500);
    };
  }

  latest(source) {
    return [...this.ticks].reverse().find(t => t.source === source) || null;
  }

  exact(source, timestamp) {
    return this.ticks.find(t => t.source === source && t.timestamp === timestamp) || null;
  }

  atOrBefore(source, timestamp) {
    for (let i = this.ticks.length - 1; i >= 0; i--) {
      const tick = this.ticks[i];
      if (tick.source === source && tick.timestamp <= timestamp) return tick;
    }
    return null;
  }
}

class PerpFeed {
  constructor() {
    this.depth = null;
    this.trades = [];
    this.tradeCoverageStart = null;
    this.sockets = [];
    this.stopped = true;
  }

  start() {
    this.stopped = false;
    this.connectDepth();
    this.connectTrades();
  }

  stop() {
    this.stopped = true;
    for (const ws of this.sockets) ws.close();
  }

  connectDepth() {
    if (this.stopped) return;
    const ws = new WebSocket(BINANCE_DEPTH_URL);
    this.sockets.push(ws);

    ws.onmessage = event => {
      try {
        const msg = JSON.parse(String(event.data))?.data;
        if (msg?.e !== 'depthUpdate' || msg?.s !== 'BTCUSDT') return;
        const bids = Array.isArray(msg.b) ? msg.b.map(x => [Number(x[0]), Number(x[1])]).filter(x => x[0] > 0 && x[1] >= 0).sort((a, b) => b[0] - a[0]) : [];
        const asks = Array.isArray(msg.a) ? msg.a.map(x => [Number(x[0]), Number(x[1])]).filter(x => x[0] > 0 && x[1] >= 0).sort((a, b) => a[0] - b[0]) : [];
        if (!bids.length || !asks.length || bids[0][0] >= asks[0][0]) return;
        this.depth = { at: Number(msg.E), bids, asks };
      } catch {}
    };

    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.sockets = this.sockets.filter(item => item !== ws);
      if (!this.stopped) setTimeout(() => this.connectDepth(), 1000);
    };
  }

  connectTrades() {
    if (this.stopped) return;
    const ws = new WebSocket(BINANCE_TRADE_URL);
    this.sockets.push(ws);

    ws.onmessage = event => {
      try {
        const msg = JSON.parse(String(event.data))?.data;
        if (msg?.e !== 'aggTrade' || msg?.s !== 'BTCUSDT') return;
        const at = Number(msg.T);
        const qty = Number(msg.q);
        if (!Number.isFinite(at) || !Number.isFinite(qty) || qty <= 0) return;
        this.tradeCoverageStart ??= at;
        this.trades.push({ at, qty, buy: !Boolean(msg.m) });
        this.trades = this.trades.filter(t => t.at >= Date.now() - 60000);
      } catch {}
    };

    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.tradeCoverageStart = null;
      this.sockets = this.sockets.filter(item => item !== ws);
      if (!this.stopped) setTimeout(() => this.connectTrades(), 1000);
    };
  }

  features(now) {
    const d = this.depth;
    if (!d || now - d.at > 15000 || d.at > now + 2000) return null;

    const sum = (levels, count) => levels.slice(0, count).reduce((s, [, qty]) => s + qty, 0);
    const imbalance = (a, b) => a + b > 0 ? (a - b) / (a + b) : null;

    const bid = d.bids[0][0];
    const ask = d.asks[0][0];
    const bidQty = d.bids[0][1];
    const askQty = d.asks[0][1];
    const mid = (bid + ask) / 2;
    const micro = (bid * askQty + ask * bidQty) / (bidQty + askQty);

    const flow = seconds => {
      if (this.tradeCoverageStart === null || this.tradeCoverageStart > now - seconds * 1000) return null;
      const rows = this.trades.filter(t => t.at >= now - seconds * 1000 && t.at <= now);
      const buy = rows.filter(t => t.buy).reduce((s, t) => s + t.qty, 0);
      const sell = rows.filter(t => !t.buy).reduce((s, t) => s + t.qty, 0);
      return { buy, sell, imbalance: imbalance(buy, sell) };
    };

    return {
      at: d.at,
      mid,
      spreadBps: (ask - bid) / mid * 10000,
      microBps: (micro / mid - 1) * 10000,
      depth5: imbalance(sum(d.bids, 5), sum(d.asks, 5)),
      depth20: imbalance(sum(d.bids, 20), sum(d.asks, 20)),
      flow10: flow(10),
      flow30: flow(30),
      flow60: flow(60)
    };
  }
}

const referenceFeed = new ReferenceFeed();
const perpFeed = new PerpFeed();

async function findMarket(slug) {
  const data = await getJson(GAMMA_API + '/events/slug/' + encodeURIComponent(slug));
  const event = data && typeof data === 'object' ? data : null;
  const markets = Array.isArray(event?.markets) ? event.markets : [];
  const market = markets.find(item => item?.slug === slug) || markets[0];
  if (!market) throw new Error('Exact BTC 5m market not found: ' + slug);

  let outcomes = market.outcomes;
  let tokenIds = market.clobTokenIds ?? market.clob_token_ids;
  if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);
  if (typeof tokenIds === 'string') tokenIds = JSON.parse(tokenIds);

  if (!Array.isArray(outcomes) || !Array.isArray(tokenIds)) {
    throw new Error('Market outcomes/token ids unavailable: ' + slug);
  }

  const normalized = outcomes.map(value => String(value).trim().toUpperCase());
  const upIndex = normalized.indexOf('UP');
  const downIndex = normalized.indexOf('DOWN');
  if (upIndex < 0 || downIndex < 0) throw new Error('UP/DOWN outcomes not found: ' + slug);

  const start = Number(slug.split('-').at(-1)) * 1000;
  const end = Date.parse(market.endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start !== PERIOD) {
    throw new Error('Market is not an exact 5-minute window: ' + slug);
  }

  let priceToBeat = Number(event?.eventMetadata?.priceToBeat);
  if (!Number.isFinite(priceToBeat) || priceToBeat <= 0) {
    const anchor = referenceFeed.exact('twap60', start);
    if (!anchor) throw new Error('Exact Chainlink TWAP opening price unavailable: ' + slug);
    priceToBeat = anchor.price;
  }

  return {
    slug,
    start,
    end,
    conditionId: market.conditionId ?? market.condition_id,
    upTokenId: String(tokenIds[upIndex]),
    downTokenId: String(tokenIds[downIndex]),
    priceToBeat
  };
}

function topBook(book, n = 5) {
  const bids = Array.isArray(book?.bids) ? book.bids : [];
  const asks = Array.isArray(book?.asks) ? book.asks : [];
  const bidSize = bids.slice(0, n).reduce((s, x) => s + Number(x.size || 0), 0);
  const askSize = asks.slice(0, n).reduce((s, x) => s + Number(x.size || 0), 0);
  const bestBid = bids.length ? Number(bids[0].price) : null;
  const bestAsk = asks.length ? Number(asks[0].price) : null;
  const mid = Number.isFinite(bestBid) && Number.isFinite(bestAsk) ? (bestBid + bestAsk) / 2 : null;
  return { bidSize, askSize, bestBid, bestAsk, mid };
}

async function getBooks(upTokenId, downTokenId) {
  const rows = await getJson(CLOB_API + '/books', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ token_id: upTokenId }, { token_id: downTokenId }])
  });

  if (!Array.isArray(rows)) throw new Error('CLOB books response is not an array');

  const up = rows.find(row => String(row.asset_id) === String(upTokenId));
  const down = rows.find(row => String(row.asset_id) === String(downTokenId));
  if (!up || !down) throw new Error('UP/DOWN order books missing');

  return { up: topBook(up), down: topBook(down) };
}

function momentumScore(value, deadbandBps = MOMENTUM_THRESHOLD_BPS) {
  if (!Number.isFinite(value) || Math.abs(value) < deadbandBps) return 0;
  return sign(value);
}

function flowScore(flow) {
  if (!flow || !Number.isFinite(flow.imbalance) || Math.abs(flow.imbalance) < FLOW_THRESHOLD) return 0;
  return sign(flow.imbalance);
}

function bookScore(up, down) {
  if (!up || !down || !Number.isFinite(up.mid) || !Number.isFinite(down.mid)) return 0;
  const total = up.mid + down.mid;
  if (!Number.isFinite(total) || total <= 0) return 0;
  return up.mid > down.mid ? 1 : up.mid < down.mid ? -1 : 0;
}

function evaluateStrategy(market, books, perp, now) {
  const twap = referenceFeed.latest('twap60');
  if (!twap) return null;

  const distanceBps = (twap.price / market.priceToBeat - 1) * 10000;
  const previous10 = referenceFeed.atOrBefore('twap60', now - 10000);
  const previous30 = referenceFeed.atOrBefore('twap60', now - 30000);
  const previous60 = referenceFeed.atOrBefore('twap60', now - 60000);

  const ret10 = previous10 ? (twap.price / previous10.price - 1) * 10000 : null;
  const ret30 = previous30 ? (twap.price / previous30.price - 1) * 10000 : null;
  const ret60 = previous60 ? (twap.price / previous60.price - 1) * 10000 : null;

  const distanceSignal = Math.abs(distanceBps) >= DISTANCE_THRESHOLD_BPS ? sign(distanceBps) * 2 : 0;
  const momentum10 = momentumScore(ret10);
  const momentum30 = momentumScore(ret30);
  const momentum60 = momentumScore(ret60);

  const perp10 = flowScore(perp?.flow10);
  const perp30 = flowScore(perp?.flow30);
  const perp60 = flowScore(perp?.flow60);
  const depth5 = Number.isFinite(perp?.depth5) && Math.abs(perp.depth5) >= DEPTH_THRESHOLD ? sign(perp.depth5) : 0;
  const depth20 = Number.isFinite(perp?.depth20) && Math.abs(perp.depth20) >= DEPTH_THRESHOLD ? sign(perp.depth20) : 0;
  const micro = Number.isFinite(perp?.microBps) && Math.abs(perp.microBps) >= MICRO_THRESHOLD_BPS ? sign(perp.microBps) : 0;
  const polyBook = bookScore(books.up, books.down);

  const score =
    distanceSignal +
    momentum10 + momentum30 + momentum60 +
    perp10 + perp30 + perp60 +
    depth5 + depth20 + micro +
    polyBook;

  const direction = score >= MIN_SIGNAL_SCORE ? 'UP' : score <= -MIN_SIGNAL_SCORE ? 'DOWN' : 'WAIT';
  const confidence = Math.round(Math.abs(score) / 12 * 100);

  return {
    direction,
    score,
    confidence,
    distanceBps,
    ret10,
    ret30,
    ret60,
    perp10: perp?.flow10?.imbalance ?? null,
    perp30: perp?.flow30?.imbalance ?? null,
    perp60: perp?.flow60?.imbalance ?? null,
    depth5: perp?.depth5 ?? null,
    depth20: perp?.depth20 ?? null,
    microBps: perp?.microBps ?? null,
    upMid: books.up.mid,
    downMid: books.down.mid,
    secondsRemaining: Math.max(0, Math.round((market.end - now) / 1000)),
    diagnostic: {
      thresholds: {
        score: MIN_SIGNAL_SCORE,
        distanceBps: DISTANCE_THRESHOLD_BPS,
        momentumBps: MOMENTUM_THRESHOLD_BPS,
        flow: FLOW_THRESHOLD,
        depth: DEPTH_THRESHOLD,
        microBps: MICRO_THRESHOLD_BPS
      },
      raw: {
        distanceBps,
        ret10,
        ret30,
        ret60,
        flow10: perp?.flow10?.imbalance ?? null,
        flow30: perp?.flow30?.imbalance ?? null,
        flow60: perp?.flow60?.imbalance ?? null,
        depth5: perp?.depth5 ?? null,
        depth20: perp?.depth20 ?? null,
        microBps: perp?.microBps ?? null,
        polyUpMid: books.up.mid,
        polyDownMid: books.down.mid
      },
      contributions: {
        distance: distanceSignal,
        momentum10,
        momentum30,
        momentum60,
        flow10: perp10,
        flow30: perp30,
        flow60: perp60,
        depth5,
        depth20,
        micro,
        polyBook
      }
    }
  };
}

function fmt(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

async function saveStrategyStability(data) {
  const site = env.CONVEX_SITE_URL;
  const token = env.CONVEX_INGEST_TOKEN;
  if (!site || !token) {
    console.log('[btc5m-strategy] stability not saved: Convex env missing');
    return;
  }
  try {
    const response = await fetch(site.replace(/\/$/, '') + '/ingest', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'strategyStability', data })
    });
    if (!response.ok) throw new Error(await response.text());
    console.log('[btc5m-strategy] stability saved: stable=' + data.stable + ' flips=' + data.flips + ' winner=' + (data.winner || 'n/a'));
  } catch (error) {
    console.error('[btc5m-strategy] stability save failed: ' + error.message);
  }
}

async function resolveWinner(slug) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const event = await getJson(GAMMA_API + '/events/slug/' + encodeURIComponent(slug));
      const markets = Array.isArray(event?.markets) ? event.markets : [];
      const market = markets.find(item => item?.slug === slug) || markets[0];
      const winner = String(market?.winner || '').trim().toUpperCase();
      if (winner === 'UP' || winner === 'DOWN') return winner;
      let outcomes = market?.outcomes;
      let prices = market?.outcomePrices ?? market?.outcome_prices;
      if (typeof outcomes === 'string') outcomes = JSON.parse(outcomes);
      if (typeof prices === 'string') prices = JSON.parse(prices);
      if (Array.isArray(outcomes) && Array.isArray(prices)) {
        const normalized = outcomes.map(value => String(value).trim().toUpperCase());
        const up = normalized.indexOf('UP');
        const down = normalized.indexOf('DOWN');
        if (up >= 0 && Number(prices[up]) >= 0.99) return 'UP';
        if (down >= 0 && Number(prices[down]) >= 0.99) return 'DOWN';
      }
    } catch (error) {
      console.error('[btc5m-strategy] winner check failed: ' + error.message);
    }
    if (attempt < 6) await sleep(5000);
  }
  return null;
}

async function sendTelegram(message) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(
        'https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: message,
            disable_web_page_preview: false
          })
        }
      );
      const body = await response.text();
      const data = JSON.parse(body);
      if (response.ok && data.ok === true && data.result?.message_id) return;
      throw new Error('Telegram delivery not confirmed: ' + body);
    } catch (error) {
      console.log('[btc5m-strategy] Telegram attempt ' + attempt + ': ' + error.message);
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw new Error('Telegram delivery failed');
}

async function processPeriod(coin, boundary) {
  const activeStart = boundary - PERIOD;
  const activeSlug = marketSlug(coin, activeStart);
  const nextSlug = marketSlug(coin, boundary);
  const market = await findMarket(activeSlug);

  console.log('[btc5m-strategy] monitoring ' + activeSlug + ' from period start');

  let confirmations = 0;
  let confirmedDirection = null;
  let lastScore = null;
  let alertSent = false;
  let signalDirection = null;
  let signalScore = null;
  let signalAt = null;
  let stabilitySamples = [];
  let lastObservedDirection = null;
  let flips = 0;

  while (Date.now() < market.end - 500 && market.end > Date.now()) {
    const now = Date.now();
    try {
      const books = await getBooks(market.upTokenId, market.downTokenId);
      const perp = perpFeed.features(now);
      const decision = evaluateStrategy(market, books, perp, now);
      if (!decision) {
        const twap = referenceFeed.latest('twap60');
        console.log('[btc5m-diagnostic] snapshot skipped: TWAP=' + (twap ? 'OK' : 'MISSING') + ' depth=' + (perp ? 'OK' : 'MISSING'));
        await sleep(CONFIRMATION_INTERVAL_MS);
        continue;
      }

      lastScore = decision.score;
      const d = decision.diagnostic;
      console.log('[btc5m-strategy] ' + activeSlug + ' score=' + decision.score + ' direction=' + decision.direction + ' seconds=' + decision.secondsRemaining);
      console.log('[btc5m-diagnostic] thresholds score>=' + d.thresholds.score + ' distance>=' + d.thresholds.distanceBps + 'bps momentum>=' + d.thresholds.momentumBps + 'bps flow>=' + (d.thresholds.flow * 100).toFixed(1) + '% depth>=' + (d.thresholds.depth * 100).toFixed(1) + '% micro>=' + d.thresholds.microBps + 'bps');
      console.log('[btc5m-diagnostic] raw distance=' + fmt(d.raw.distanceBps) + ' ret10=' + fmt(d.raw.ret10) + ' ret30=' + fmt(d.raw.ret30) + ' ret60=' + fmt(d.raw.ret60) + ' flow10=' + fmt(d.raw.flow10 * 100) + '% flow30=' + fmt(d.raw.flow30 * 100) + '% flow60=' + fmt(d.raw.flow60 * 100) + '% depth5=' + fmt(d.raw.depth5 * 100) + '% depth20=' + fmt(d.raw.depth20 * 100) + '% micro=' + fmt(d.raw.microBps) + 'bps polyUP=' + fmt(d.raw.polyUpMid, 4) + ' polyDOWN=' + fmt(d.raw.polyDownMid, 4));
      console.log('[btc5m-diagnostic] points distance=' + d.contributions.distance + ' mom10=' + d.contributions.momentum10 + ' mom30=' + d.contributions.momentum30 + ' mom60=' + d.contributions.momentum60 + ' flow10=' + d.contributions.flow10 + ' flow30=' + d.contributions.flow30 + ' flow60=' + d.contributions.flow60 + ' depth5=' + d.contributions.depth5 + ' depth20=' + d.contributions.depth20 + ' micro=' + d.contributions.micro + ' poly=' + d.contributions.polyBook + ' total=' + decision.score + ' confirmation=' + confirmations + '/' + CONFIRMATIONS_REQUIRED);

      if (alertSent) {
        stabilitySamples.push({ ts: now, direction: decision.direction, score: decision.score, secondsRemaining: decision.secondsRemaining });
        if (decision.direction !== 'WAIT') {
          if (lastObservedDirection && decision.direction !== lastObservedDirection) flips++;
          lastObservedDirection = decision.direction;
        }
      }

      if (decision.direction !== 'WAIT') {
        if (decision.direction === confirmedDirection) confirmations++;
        else {
          confirmedDirection = decision.direction;
          confirmations = 1;
        }

        if (confirmations >= CONFIRMATIONS_REQUIRED && !alertSent) {
          alertSent = true;
          signalDirection = decision.direction;
          signalScore = decision.score;
          signalAt = now;
          stabilitySamples.push({ ts: now, direction: decision.direction, score: decision.score, secondsRemaining: decision.secondsRemaining });
          lastObservedDirection = decision.direction;
          flips = 0;
          await sendStrategyAlert(coin, market, nextSlug, decision);
        }
      } else if (!alertSent) {
        confirmations = 0;
        confirmedDirection = null;
      }
    } catch (error) {
      console.error('[btc5m-strategy] snapshot failed: ' + error.message);
    }

    await sleep(CONFIRMATION_INTERVAL_MS);
  }

  if (alertSent) {
    const winner = await resolveWinner(activeSlug);
    const finalDirection = [...stabilitySamples].reverse().find(sample => sample.direction !== 'WAIT')?.direction || 'WAIT';
    await saveStrategyStability({
      symbol: coin,
      periodStart: market.start,
      periodEnd: market.end,
      signalDirection,
      signalScore,
      signalAt,
      samples: stabilitySamples,
      stable: flips === 0,
      flips,
      finalDirection,
      winner: winner || undefined,
      correct: winner ? winner === signalDirection : undefined,
      recordedAt: Date.now()
    });
    console.log('[btc5m-strategy] signal stability: direction=' + signalDirection + ' stable=' + (flips === 0) + ' flips=' + flips + ' winner=' + (winner || 'n/a'));
    return true;
  }

  console.log('[btc5m-strategy] no confirmed signal for ' + activeSlug + ' lastScore=' + lastScore);
  return false;
}

async function sendStrategyAlert(coin, market, nextSlug, decision) {
  const now = Date.now();

  const message = [
    '🔥 BTC · 5M',
    '',
    'PREDICTED: ' + decision.direction,
    'OUTCOME PRICE: ' + fmt(decision.direction === 'UP' ? decision.upMid : decision.downMid, 4),
    'SCORE: ' + decision.score + '/12',
    'CONFIDENCE: ' + decision.confidence + '%',
    '',
    'PRICE TO BEAT: ' + fmt(market.priceToBeat, 2),
    'CHAINLINK TWAP: ' + fmt(referenceFeed.latest('twap60')?.price, 2),
    'DISTANCE: ' + fmt(decision.distanceBps) + ' bps',
    '',
    'BTC 10S: ' + fmt(decision.ret10) + ' bps',
    'BTC 30S: ' + fmt(decision.ret30) + ' bps',
    'BTC 60S: ' + fmt(decision.ret60) + ' bps',
    '',
    'PERP FLOW 10S: ' + fmt(decision.perp10 * 100) + '%',
    'PERP FLOW 30S: ' + fmt(decision.perp30 * 100) + '%',
    'PERP FLOW 60S: ' + fmt(decision.perp60 * 100) + '%',
    'DEPTH 5: ' + fmt(decision.depth5 * 100) + '%',
    'DEPTH 20: ' + fmt(decision.depth20 * 100) + '%',
    'MICROPRICE: ' + fmt(decision.microBps) + ' bps',
    '',
    'POLY UP MID: ' + fmt(decision.upMid, 4),
    'POLY DOWN MID: ' + fmt(decision.downMid, 4),
    'SECONDS LEFT: ' + decision.secondsRemaining,
    '',
    '➡️ NEXT · Polymarket 5M',
    'https://polymarket.com/event/' + nextSlug
  ].join('\n');

  if (String(env.POLYMARKET_AUTO_TRADE_ENABLED || 'false').toLowerCase() === 'true') {
    executeTrade(coin, nextSlug, market.end, market.end + PERIOD, decision.direction.toLowerCase()).catch(error => {
      console.error('[btc5m-strategy] AUTO TRADE FAILED: ' + error.message);
    });
  }

  await sendTelegram(message);
  console.log('[btc5m-strategy] alert sent: ' + activeSlug + ' -> ' + decision.direction);
  return true;
}

async function main() {
  referenceFeed.start();
  perpFeed.start();

  const stopAt = Date.now() + RUN_MS;
  let boundary = boundaryNow() + PERIOD;
  const initialWait = boundary - PERIOD - Date.now() + 1000;
  if (initialWait > 0) await sleep(initialWait);

  console.log('[btc5m-strategy] BTC 5M confluence strategy started');
  console.log('[btc5m-strategy] prediction = Chainlink TWAP + Binance perp flow/depth + Polymarket book');
  console.log('[btc5m-strategy] monitoring starts near period open; alert after 2 consecutive confirmations');

  while (Date.now() < stopAt) {
    const wait = boundary - PERIOD - Date.now() + 1000;
    if (wait > 0) await sleep(wait);
    if (Date.now() >= stopAt) break;

    try {
      const results = await Promise.allSettled(
        COINS.map(coin => processPeriod(coin, boundary))
      );
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          console.error('[btc5m-strategy] ' + COINS[index] + ' PERIOD FAILED: ' + result.reason.message);
        }
      });
    } catch (error) {
      console.error('[btc5m-strategy] PERIOD ERROR: ' + error.message);
    }

    boundary += PERIOD;
  }

  referenceFeed.stop();
  perpFeed.stop();
}

main().catch(error => {
  console.error('[btc5m-strategy] FAILED', error);
  process.exit(1);
});
