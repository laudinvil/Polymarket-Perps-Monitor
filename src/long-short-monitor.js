const https = require('https');
const { sendTelegramMessage } = require('./telegram');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const PRICE_URL = 'https://marginpad.io/api/v1/price';
const CLUSTERS_URL = 'https://marginpad.io/api/v1/clusters';
const POLYMARKET_GAMMA_URL = 'https://gamma-api.polymarket.com/events/slug';
const POLL_MS = 30 * 1000;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const STATE_PATH = '.long-short-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;

const sentClusters = new Set();
const previousPrices = new Map();
const armedSymbols = new Set();
const rearmConditions = new Map();
let stateSha = null;
let lastAlertAt = 0;

function formatPrice(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A';
  return Number(Number(value).toPrecision(12)).toString();
}

function githubRequest(method, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error('GITHUB_TOKEN is not available'));
    const data = body ? JSON.stringify(body) : null;
    const request = https.request(STATE_API_URL, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'long-short-cluster-monitor',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
      }
    }, response => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch {}
        if (response.statusCode >= 200 && response.statusCode < 300) return resolve(json);
        reject(new Error(`GitHub state request failed: ${response.statusCode} ${text}`));
      });
    });
    request.on('error', reject);
    if (data) request.write(data);
    request.end();
  });
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function migrateRearmConditions(state) {
  const sentBySymbol = new Map();
  for (const key of sentClusters) {
    const parts = String(key).split(':');
    if (parts.length < 3) continue;
    const symbol = parts[0];
    const price = Number(parts[parts.length - 1]);
    if (!SYMBOLS.includes(symbol) || !Number.isFinite(price)) continue;
    sentBySymbol.set(symbol, price);
  }

  for (const [symbol, price] of sentBySymbol) {
    if (rearmConditions.has(symbol) || armedSymbols.has(symbol)) continue;
    const previousPrice = previousPrices.get(symbol);
    if (!Number.isFinite(previousPrice) || previousPrice === price) continue;
    const direction = previousPrice < price ? 'below' : 'above';
    rearmConditions.set(symbol, { price, direction });
    console.log(JSON.stringify({ type: 'legacy_state_migrated', symbol, resetLevel: price, direction, previousPrice }));
  }
}

async function loadState() {
  try {
    const data = await githubRequest('GET');
    if (!data?.content) return;
    stateSha = data.sha || null;
    const state = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    for (const key of state.sentClusters || []) sentClusters.add(key);
    for (const [symbol, price] of Object.entries(state.previousPrices || {})) {
      const n = Number(price);
      if (Number.isFinite(n)) previousPrices.set(symbol, n);
    }
    for (const symbol of state.armedSymbols || []) armedSymbols.add(symbol);
    for (const [symbol, condition] of Object.entries(state.rearmConditions || {})) {
      if (condition && Number.isFinite(Number(condition.price)) && (condition.direction === 'below' || condition.direction === 'above')) {
        rearmConditions.set(symbol, { price: Number(condition.price), direction: condition.direction });
      }
    }
    lastAlertAt = Number(state.lastAlertAt) || 0;
    migrateRearmConditions(state);
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveState() {
  if (!process.env.GITHUB_TOKEN) return;
  const content = Buffer.from(JSON.stringify({
    sentClusters: [...sentClusters].slice(-1000),
    previousPrices: Object.fromEntries(previousPrices),
    armedSymbols: [...armedSymbols],
    rearmConditions: Object.fromEntries(rearmConditions),
    lastAlertAt
  }, null, 2)).toString('base64');

  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const current = await githubRequest('GET');
      const currentSha = current?.sha || stateSha;
      const body = {
        message: 'Persist long short cluster monitor state',
        content,
        branch: process.env.GITHUB_REF_NAME || 'main',
        ...(currentSha ? { sha: currentSha } : {})
      };
      const result = await githubRequest('PUT', body);
      stateSha = result?.content?.sha || currentSha || stateSha;
      return;
    } catch (error) {
      const isConflict = /GitHub state request failed: 409\b/.test(error.message);
      if (!isConflict || attempt === 4) {
        console.warn(`STATE SAVE FAILED: ${error.message}`);
        return;
      }
      await sleep(250 * attempt);
    }
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  const json = await response.json();
  if (json?.ok === false) throw new Error(json?.error?.message || `API error for ${url}`);
  return json?.data ?? json;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractPrice(data) {
  if (typeof data === 'number' || typeof data === 'string') return toNumber(data);
  return toNumber(data?.price ?? data?.last ?? data?.markPrice ?? data?.value);
}

function extractClusters(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.clusters)) return data.clusters;
  return [];
}

function normalizeCluster(raw) {
  const price = toNumber(raw?.price);
  const estNotional = toNumber(raw?.est_notional ?? raw?.estNotional ?? raw?.notional) ?? 0;
  const side = String(raw?.side || '').toLowerCase();
  if (price == null || price <= 0) return null;
  if (side !== 'long_liquidated' && side !== 'short_liquidated') return null;
  return { price, estNotional, side };
}

function clusterKey(symbol, cluster) {
  return `${symbol}:${cluster.side}:${cluster.price}`;
}

function isTouch(previousPrice, currentPrice, clusterPrice) {
  if (currentPrice == null || clusterPrice == null) return false;
  if (currentPrice === clusterPrice) return true;
  if (previousPrice == null) return false;
  return (previousPrice < clusterPrice && currentPrice > clusterPrice) ||
         (previousPrice > clusterPrice && currentPrice < clusterPrice);
}

function approachDirection(previousPrice, currentPrice, clusterPrice) {
  if (previousPrice != null) {
    if (previousPrice < clusterPrice && currentPrice > clusterPrice) return 'СНИЗУ ВВЕРХ';
    if (previousPrice > clusterPrice && currentPrice < clusterPrice) return 'СВЕРХУ ВНИЗ';
    if (currentPrice === clusterPrice) {
      if (previousPrice < clusterPrice) return 'СНИЗУ ВВЕРХ';
      if (previousPrice > clusterPrice) return 'СВЕРХУ ВНИЗ';
    }
  }
  return 'ТОЧНОЕ КАСАНИЕ';
}

async function getCoinSnapshot(symbol) {
  const [priceData, clusterData] = await Promise.all([
    fetchJson(`${PRICE_URL}?symbol=${encodeURIComponent(symbol)}`),
    fetchJson(`${CLUSTERS_URL}?symbol=${encodeURIComponent(symbol)}`)
  ]);
  const currentPrice = extractPrice(priceData);
  const clusters = extractClusters(clusterData).map(normalizeCluster).filter(Boolean);
  if (currentPrice == null || clusters.length === 0) {
    return { symbol, currentPrice, previousPrice: previousPrices.get(symbol) ?? null, clusters, nearest: null };
  }
  const available = clusters
    .map(cluster => ({
      ...cluster,
      clusterKey: clusterKey(symbol, cluster),
      distancePct: Math.abs(cluster.price - currentPrice) / currentPrice * 100
    }))
    .filter(cluster => !sentClusters.has(cluster.clusterKey))
    .sort((a, b) => a.distancePct - b.distancePct);
  return {
    symbol,
    currentPrice,
    previousPrice: previousPrices.get(symbol) ?? null,
    clusters,
    nearest: available[0] || null
  };
}

async function nextMarketUrl(symbol) {
  const intervalSeconds = 5 * 60;
  const nextBoundaryEpochSeconds =
    Math.floor(Date.now() / (intervalSeconds * 1000)) * intervalSeconds + intervalSeconds;
  const slug = `${symbol.toLowerCase()}-updown-5m-${nextBoundaryEpochSeconds}`;
  const url = `${POLYMARKET_GAMMA_URL}/${slug}`;
  try {
    const event = await fetchJson(url);
    if (event?.slug) return `https://polymarket.com/event/${event.slug}`;
    throw new Error('Gamma API returned no event slug');
  } catch (error) {
    console.warn(`POLYMARKET LINK RESOLVE FAILED: ${symbol}: ${error.message}`);
    return `https://polymarket.com/event/${slug}`;
  }
}

function updateRearmState(snapshot) {
  if (snapshot.currentPrice == null || armedSymbols.has(snapshot.symbol)) return;
  const condition = rearmConditions.get(snapshot.symbol);
  if (!condition) return;
  const canRearm = condition.direction === 'below'
    ? snapshot.currentPrice < condition.price
    : snapshot.currentPrice > condition.price;
  if (canRearm) {
    armedSymbols.add(snapshot.symbol);
    rearmConditions.delete(snapshot.symbol);
    console.log(JSON.stringify({ type: 'symbol_rearmed', symbol: snapshot.symbol, resetLevel: condition.price, direction: condition.direction, currentPrice: snapshot.currentPrice }));
  }
}

async function check() {
  const snapshots = await Promise.all(SYMBOLS.map(async symbol => {
    try { return await getCoinSnapshot(symbol); }
    catch (error) { console.warn(`${symbol}: ${error.message}`); return { symbol, nearest: null }; }
  }));

  for (const snapshot of snapshots) updateRearmState(snapshot);

  const touched = snapshots.filter(snapshot => {
    const cluster = snapshot.nearest;
    if (!cluster || !armedSymbols.has(snapshot.symbol)) return false;
    const touched = isTouch(snapshot.previousPrice, snapshot.currentPrice, cluster.price);
    if (touched) {
      console.log(JSON.stringify({
        type: 'cluster_touch_detected', symbol: snapshot.symbol,
        previousPrice: snapshot.previousPrice, currentPrice: snapshot.currentPrice,
        clusterPrice: cluster.price, direction: approachDirection(snapshot.previousPrice, snapshot.currentPrice, cluster.price),
        distancePct: cluster.distancePct, clusterKey: cluster.clusterKey
      }));
    }
    return touched;
  });

  for (const snapshot of snapshots) {
    if (snapshot.currentPrice != null) previousPrices.set(snapshot.symbol, snapshot.currentPrice);
  }

  if (touched.length === 0) {
    const diagnostics = snapshots.map(snapshot => ({
      symbol: snapshot.symbol, currentPrice: snapshot.currentPrice ?? null,
      clusterPrice: snapshot.nearest?.price ?? null,
      distance: snapshot.nearest && snapshot.currentPrice != null ? Math.abs(snapshot.nearest.price - snapshot.currentPrice) : null,
      distancePct: snapshot.nearest?.distancePct ?? null, side: snapshot.nearest?.side ?? null,
      armed: armedSymbols.has(snapshot.symbol), rearmCondition: rearmConditions.get(snapshot.symbol) ?? null
    }));
    console.log(JSON.stringify({ type: 'cluster_waiting_for_touch', coins: diagnostics }));
    await saveState();
    return;
  }

  touched.sort((a, b) => a.nearest.distancePct - b.nearest.distancePct);
  const winner = touched[0];
  const cluster = winner.nearest;
  if (sentClusters.has(cluster.clusterKey)) {
    console.log(JSON.stringify({ type: 'cluster_duplicate', symbol: winner.symbol, cluster: cluster.clusterKey }));
    await saveState();
    return;
  }
  if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) {
    console.log(JSON.stringify({ type: 'cluster_cooldown', remainingMs: ALERT_COOLDOWN_MS - (Date.now() - lastAlertAt), symbol: winner.symbol, clusterPrice: cluster.price }));
    await saveState();
    return;
  }

  sentClusters.add(cluster.clusterKey);
  armedSymbols.delete(winner.symbol);
  const direction = approachDirection(winner.previousPrice, winner.currentPrice, cluster.price);
  const rearmDirection = direction === 'СНИЗУ ВВЕРХ' ? 'below' :
    direction === 'СВЕРХУ ВНИЗ' ? 'above' :
    (winner.previousPrice != null && winner.previousPrice < cluster.price ? 'below' : 'above');
  rearmConditions.set(winner.symbol, { price: cluster.price, direction: rearmDirection });
  lastAlertAt = Date.now();
  await saveState();

  const sideLabel = cluster.side === 'long_liquidated' ? 'LONG' : 'SHORT';
  const emoji = sideLabel === 'LONG' ? '🟢' : '🔴';
  const polymarketUrl = await nextMarketUrl(winner.symbol);
  const message = [
    `${emoji} CLUSTER TOUCHED`, `${winner.symbol} · 5M`, '', `Cluster: ${sideLabel}`,
    `Previous price: ${formatPrice(winner.previousPrice)}`, `Cluster price: ${formatPrice(cluster.price)}`,
    `Current price: ${formatPrice(winner.currentPrice)}`, `Direction: ${direction}`,
    `Distance: ${cluster.distancePct.toFixed(2)}%`, `Estimated volume: $${Math.round(cluster.estNotional).toLocaleString('en-US')}`,
    '', '➡️ NEXT Polymarket 5M', polymarketUrl
  ].join('\n');
  try { await sendTelegramMessage(message); }
  catch (error) { console.warn(`TELEGRAM SEND FAILED: ${error.message}`); }
  console.log(JSON.stringify({
    type: 'cluster_alert_sent', symbol: winner.symbol, side: sideLabel,
    previousPrice: winner.previousPrice, clusterPrice: cluster.price, currentPrice: winner.currentPrice,
    direction, distancePct: cluster.distancePct, polymarketUrl, clusterKey: cluster.clusterKey,
    rearmCondition: rearmConditions.get(winner.symbol)
  }));
}

async function main() {
  await loadState();
  for (const symbol of SYMBOLS) {
    if (!armedSymbols.has(symbol) && !rearmConditions.has(symbol) && ![...sentClusters].some(key => key.startsWith(`${symbol}:`))) {
      armedSymbols.add(symbol);
    }
  }
  console.log(`LONG/SHORT cluster monitor started; symbols=${SYMBOLS.join(',')}; source=${CLUSTERS_URL}; alert ONLY on exact touch/cross; one alert per price move per coin; rearm only after crossing back through last alerted level; max 1 alert per 5 minutes; no duplicates`);
  while (true) {
    try { await check(); }
    catch (error) { console.error(`CLUSTER CYCLE FAILED: ${error.stack || error.message}`); }
    await sleep(POLL_MS);
  }
}

main().catch(error => {
  console.error(`CLUSTER MONITOR FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
