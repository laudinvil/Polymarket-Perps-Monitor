const https = require('https');
const { sendTelegramMessage } = require('./telegram');
const { findNextMarket } = require('./polymarket');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const PRICE_URL = 'https://marginpad.io/api/v1/price';
const CLUSTERS_URL = 'https://marginpad.io/api/v1/clusters';
const POLL_MS = 30 * 1000;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const STATE_PATH = '.long-short-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;

const sentClusters = new Set();
const previousPrices = new Map();
const alertedBuckets = new Map();
let lastAlertAt = 0;
let lastAlertSymbol = null;

function formatPrice(value) {
  if (value == null || !Number.isFinite(Number(value))) return 'N/A';
  return Number(Number(value).toPrecision(12)).toString();
}

function currentBucket() {
  return Math.floor(Date.now() / (5 * 60 * 1000));
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

function decodeState(data) {
  if (!data?.content) return {};
  return JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
}

async function loadState() {
  try {
    const data = await githubRequest('GET');
    if (!data?.content) return;
    const state = decodeState(data);
    for (const key of state.sentClusters || []) sentClusters.add(key);
    for (const [symbol, price] of Object.entries(state.previousPrices || {})) {
      const n = Number(price);
      if (Number.isFinite(n)) previousPrices.set(symbol, n);
    }
    for (const [symbol, bucket] of Object.entries(state.alertedBuckets || {})) {
      const n = Number(bucket);
      if (Number.isFinite(n)) alertedBuckets.set(symbol, n);
    }
    lastAlertAt = Number(state.lastAlertAt) || 0;
    lastAlertSymbol = state.lastAlertSymbol || null;
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveState() {
  if (!process.env.GITHUB_TOKEN) return;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const current = await githubRequest('GET');
      const remoteState = decodeState(current);
      const mergedState = {
        ...remoteState,
        sentClusters: [...new Set([...(remoteState.sentClusters || []), ...sentClusters])].slice(-2000),
        previousPrices: { ...(remoteState.previousPrices || {}), ...Object.fromEntries(previousPrices) },
        alertedBuckets: { ...(remoteState.alertedBuckets || {}), ...Object.fromEntries(alertedBuckets) },
        lastAlertAt: Math.max(Number(remoteState.lastAlertAt) || 0, lastAlertAt),
        lastAlertSymbol: lastAlertSymbol || remoteState.lastAlertSymbol || null
      };
      await githubRequest('PUT', {
        message: 'Persist long short cluster monitor state',
        content: Buffer.from(JSON.stringify(mergedState, null, 2)).toString('base64'),
        branch: process.env.GITHUB_REF_NAME || 'main',
        ...(current?.sha ? { sha: current.sha } : {})
      });
      return;
    } catch (error) {
      const isConflict = /GitHub state request failed: 409\b/.test(error.message);
      if (!isConflict || attempt === 6) {
        console.warn(`STATE SAVE FAILED: ${error.message}`);
        return;
      }
      await sleep(200 * attempt);
    }
  }
}

async function reserveAlertSlot(symbol, bucket, clusterKey) {
  if (!process.env.GITHUB_TOKEN) {
    if (alertedBuckets.get(symbol) === bucket || sentClusters.has(clusterKey) || lastAlertSymbol === symbol) return false;
    alertedBuckets.set(symbol, bucket);
    sentClusters.add(clusterKey);
    lastAlertSymbol = symbol;
    return true;
  }

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const current = await githubRequest('GET');
      const remoteState = decodeState(current);
      const remoteClusters = new Set(remoteState.sentClusters || []);
      const remoteBuckets = { ...(remoteState.alertedBuckets || {}) };
      const remoteLastSymbol = remoteState.lastAlertSymbol || null;

      if (remoteClusters.has(clusterKey) || Number(remoteBuckets[symbol]) === bucket || remoteLastSymbol === symbol) {
        sentClusters.add(clusterKey);
        alertedBuckets.set(symbol, bucket);
        lastAlertSymbol = remoteLastSymbol || symbol;
        return false;
      }

      remoteClusters.add(clusterKey);
      remoteBuckets[symbol] = bucket;
      const mergedState = {
        ...remoteState,
        sentClusters: [...remoteClusters].slice(-2000),
        previousPrices: { ...(remoteState.previousPrices || {}), ...Object.fromEntries(previousPrices) },
        alertedBuckets: remoteBuckets,
        lastAlertAt: Math.max(Number(remoteState.lastAlertAt) || 0, lastAlertAt),
        lastAlertSymbol: symbol
      };

      await githubRequest('PUT', {
        message: `Reserve ${symbol} cluster alert ${clusterKey}`,
        content: Buffer.from(JSON.stringify(mergedState, null, 2)).toString('base64'),
        branch: process.env.GITHUB_REF_NAME || 'main',
        ...(current?.sha ? { sha: current.sha } : {})
      });

      sentClusters.add(clusterKey);
      alertedBuckets.set(symbol, bucket);
      lastAlertSymbol = symbol;
      return true;
    } catch (error) {
      const isConflict = /GitHub state request failed: 409\b/.test(error.message);
      if (!isConflict || attempt === 10) {
        console.warn(`ALERT SLOT RESERVATION FAILED: ${error.message}`);
        return false;
      }
      await sleep(250 * attempt);
    }
  }
  return false;
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
    return { symbol, currentPrice, previousPrice: previousPrices.get(symbol) ?? null, nearest: null };
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
    nearest: available[0] || null
  };
}

async function check() {
  const bucket = currentBucket();
  const snapshots = await Promise.all(SYMBOLS.map(async symbol => {
    try { return await getCoinSnapshot(symbol); }
    catch (error) {
      console.warn(`${symbol}: ${error.message}`);
      return { symbol, nearest: null };
    }
  }));

  const touched = snapshots.filter(snapshot => {
    const cluster = snapshot.nearest;
    if (!cluster) return false;
    if (alertedBuckets.get(snapshot.symbol) === bucket) return false;
    if (lastAlertSymbol === snapshot.symbol) return false;
    return isTouch(snapshot.previousPrice, snapshot.currentPrice, cluster.price);
  });

  for (const snapshot of snapshots) {
    if (snapshot.currentPrice != null) previousPrices.set(snapshot.symbol, snapshot.currentPrice);
  }

  if (touched.length === 0) {
    await saveState();
    return;
  }

  touched.sort((a, b) => a.nearest.distancePct - b.nearest.distancePct);
  const winner = touched[0];
  const cluster = winner.nearest;

  if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) {
    await saveState();
    return;
  }

  let market;
  try {
    market = await findNextMarket(winner.symbol, '5m');
  } catch (error) {
    console.warn(`POLYMARKET LINK RESOLVE FAILED: ${winner.symbol}: ${error.message}`);
    await saveState();
    return;
  }

  const polymarketUrl = market?.url;
  if (!polymarketUrl) {
    console.warn(`POLYMARKET LINK RESOLVE FAILED: ${winner.symbol}: no verified market URL`);
    await saveState();
    return;
  }

  const reserved = await reserveAlertSlot(winner.symbol, bucket, cluster.clusterKey);
  if (!reserved) {
    console.log(JSON.stringify({ type: 'cluster_duplicate_or_alternation_blocked', symbol: winner.symbol, cluster: cluster.clusterKey, bucket, lastAlertSymbol }));
    return;
  }

  lastAlertAt = Date.now();
  await saveState();

  const direction = approachDirection(winner.previousPrice, winner.currentPrice, cluster.price);
  const sideLabel = cluster.side === 'long_liquidated' ? 'LONG' : 'SHORT';
  const emoji = sideLabel === 'LONG' ? '🟢' : '🔴';
  const message = [
    `${emoji} CLUSTER TOUCHED`,
    `${winner.symbol} · 5M`,
    '',
    `Cluster: ${sideLabel}`,
    `Previous price: ${formatPrice(winner.previousPrice)}`,
    `Cluster price: ${formatPrice(cluster.price)}`,
    `Current price: ${formatPrice(winner.currentPrice)}`,
    `Direction: ${direction}`,
    `Distance: ${cluster.distancePct.toFixed(2)}%`,
    `Estimated volume: $${Math.round(cluster.estNotional).toLocaleString('en-US')}`,
    '',
    '➡️ NEXT Polymarket 5M',
    polymarketUrl
  ].join('\n');

  try {
    await sendTelegramMessage(message);
  } catch (error) {
    console.warn(`TELEGRAM SEND FAILED: ${error.message}`);
  }

  console.log(JSON.stringify({
    type: 'cluster_alert_sent',
    symbol: winner.symbol,
    side: sideLabel,
    previousPrice: winner.previousPrice,
    clusterPrice: cluster.price,
    currentPrice: winner.currentPrice,
    direction,
    distancePct: cluster.distancePct,
    polymarketUrl,
    clusterKey: cluster.clusterKey,
    bucket,
    lastAlertSymbol
  }));
}

async function main() {
  await loadState();
  console.log(`LONG/SHORT cluster monitor started; symbols=${SYMBOLS.join(',')}; exact touch/cross; ATOMIC dedupe; STRICT ALTERNATING COINS; state persisted in GitHub`);
  while (true) {
    try { await check(); }
    catch (error) { console.error(`CLUSTER CYCLE FAILED: ${error.stack || error.message}`); }
    await sleep(POLL_MS);
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});