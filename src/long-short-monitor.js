const https = require('https');
const { sendTelegramMessage } = require('./telegram');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const PRICE_URL = 'https://marginpad.io/api/v1/price';
const CLUSTERS_URL = 'https://marginpad.io/api/v1/clusters';
const POLL_MS = 30 * 1000;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const TOUCH_TOLERANCE_PCT = 0.05;
const STATE_PATH = '.long-short-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;

const sentClusters = new Set();
const previousPrices = new Map();
let stateSha = null;
let lastAlertAt = 0;

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
    lastAlertAt = Number(state.lastAlertAt) || 0;
  } catch (error) {
    console.warn(`STATE LOAD FAILED: ${error.message}`);
  }
}

async function saveState() {
  if (!process.env.GITHUB_TOKEN) return;
  const content = Buffer.from(JSON.stringify({
    sentClusters: [...sentClusters].slice(-1000),
    previousPrices: Object.fromEntries(previousPrices),
    lastAlertAt
  }, null, 2)).toString('base64');

  // Refresh the file SHA immediately before every write. A long-running
  // monitor can otherwise keep a stale SHA for hours and receive GitHub 409.
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

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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

// Identity of a cluster must NOT depend on changing volume/notional.
// The same price/side cluster can receive updated volume on every API poll.
function clusterKey(symbol, cluster) {
  return `${symbol}:${cluster.side}:${cluster.price}`;
}

function isTouch(previousPrice, currentPrice, clusterPrice) {
  if (previousPrice == null || currentPrice == null) return false;

  const tolerance = clusterPrice * (TOUCH_TOLERANCE_PCT / 100);
  const previousDistance = Math.abs(previousPrice - clusterPrice);
  const currentDistance = Math.abs(currentPrice - clusterPrice);

  if (currentDistance <= tolerance) return true;

  const crossed = (previousPrice <= clusterPrice && currentPrice >= clusterPrice) ||
                  (previousPrice >= clusterPrice && currentPrice <= clusterPrice);
  if (crossed) return true;

  return previousDistance > tolerance && currentDistance <= tolerance;
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

function nextMarketUrl(symbol) {
  // Polymarket recurring 5m event slugs use the START timestamp of the NEXT
  // 5-minute window in Unix seconds (10 digits), not milliseconds and not a
  // millisecond value divided a second time.
  const nextBoundaryEpochSeconds =
    Math.floor(Date.now() / (5 * 60 * 1000)) * (5 * 60) + (5 * 60);
  return `https://polymarket.com/event/${symbol.toLowerCase()}-updown-5m-${nextBoundaryEpochSeconds}`;
}

async function check() {
  const snapshots = await Promise.all(SYMBOLS.map(async symbol => {
    try {
      return await getCoinSnapshot(symbol);
    } catch (error) {
      console.warn(`${symbol}: ${error.message}`);
      return { symbol, nearest: null };
    }
  }));

  for (const snapshot of snapshots) {
    if (snapshot.currentPrice != null) previousPrices.set(snapshot.symbol, snapshot.currentPrice);
  }

  const touched = snapshots.filter(snapshot => {
    const cluster = snapshot.nearest;
    if (!cluster) return false;
    return isTouch(snapshot.previousPrice, snapshot.currentPrice, cluster.price);
  });

  if (touched.length === 0) {
    const nearest = snapshots
      .filter(x => x.nearest)
      .sort((a, b) => a.nearest.distancePct - b.nearest.distancePct)[0];
    if (nearest) {
      console.log(JSON.stringify({
        type: 'cluster_waiting_for_touch',
        symbol: nearest.symbol,
        clusterPrice: nearest.nearest.price,
        currentPrice: nearest.currentPrice,
        distancePct: nearest.nearest.distancePct,
        clusterKey: nearest.nearest.clusterKey
      }));
    } else {
      console.log(JSON.stringify({ type: 'cluster_no_data' }));
    }
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
    console.log(JSON.stringify({
      type: 'cluster_cooldown',
      remainingMs: ALERT_COOLDOWN_MS - (Date.now() - lastAlertAt),
      symbol: winner.symbol,
      clusterPrice: cluster.price
    }));
    await saveState();
    return;
  }

  const sideLabel = cluster.side === 'long_liquidated' ? 'LONG' : 'SHORT';
  const emoji = sideLabel === 'LONG' ? '🟢' : '🔴';
  const message = [
    `${emoji} CLUSTER TOUCHED`,
    `${winner.symbol} · 5M`,
    '',
    `Cluster: ${sideLabel}`,
    `Cluster price: ${cluster.price}`,
    `Current price: ${winner.currentPrice}`,
    `Distance: ${cluster.distancePct.toFixed(2)}%`,
    `Estimated volume: $${Math.round(cluster.estNotional).toLocaleString('en-US')}`,
    '',
    '➡️ NEXT Polymarket 5M',
    nextMarketUrl(winner.symbol)
  ].join('\n');

  await sendTelegramMessage(message);
  sentClusters.add(cluster.clusterKey);
  lastAlertAt = Date.now();
  await saveState();

  console.log(JSON.stringify({
    type: 'cluster_alert_sent',
    symbol: winner.symbol,
    side: sideLabel,
    clusterPrice: cluster.price,
    currentPrice: winner.currentPrice,
    distancePct: cluster.distancePct,
    clusterKey: cluster.clusterKey
  }));
}

async function main() {
  await loadState();
  console.log(`LONG/SHORT cluster monitor started; symbols=${SYMBOLS.join(',')}; source=${CLUSTERS_URL}; alert ONLY on price touch; next unprocessed cluster after each alert; max 1 alert per 5 minutes; no duplicates`);

  while (true) {
    try {
      await check();
    } catch (error) {
      console.error(`CLUSTER CYCLE FAILED: ${error.stack || error.message}`);
    }
    await sleep(POLL_MS);
  }
}

main().catch(error => {
  console.error(`CLUSTER MONITOR FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});
