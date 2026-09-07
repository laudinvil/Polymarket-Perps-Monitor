const fs = require('fs');
const https = require('https');

const path = process.argv[2] || 'monitor-history.log';
const text = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
const lines = text.split(/\r?\n/).filter(Boolean);
const alerts = [];

for (const line of lines) {
  const m = line.match(/^ALERT SENT (5m|15m|1h|4h) ([A-Z]+) (BUY UP|BUY DOWN)$/);
  if (m) alerts.push({ timeframe: m[1], symbol: m[2], signal: m[3] });
}

const frames = ['5m', '15m', '1h', '4h'];
const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const disabledSymbolsByTimeframe = { '5m': new Set(['HYPE']), '15m': new Set(), '1h': new Set(), '4h': new Set() };
const usd = n => Number.isFinite(Number(n)) ? `$${Math.round(Math.abs(Number(n))).toLocaleString('en-US')}` : '—';
const signed = n => Number.isFinite(Number(n)) ? `${Number(n) >= 0 ? '+' : '-'}$${Math.round(Math.abs(Number(n))).toLocaleString('en-US')}` : '—';

function convexBaseUrl() {
  const configured = String(process.env.CONVEX_URL || '').trim().replace(/\/$/, '');
  return configured.replace(/\.convex\.cloud$/i, '.convex.site');
}

async function loadConvexStats(timeframe) {
  const baseUrl = convexBaseUrl();
  if (!baseUrl) return null;
  try {
    const response = await fetch(`${baseUrl}/latest-stats?timeframe=${encodeURIComponent(timeframe)}`, {
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return Array.isArray(payload.stats) ? payload.stats : null;
  } catch {
    return null;
  }
}

function githubRequest(pathname) {
  return new Promise((resolve, reject) => {
    const repository = process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor';
    const url = new URL(`https://api.github.com/repos/${repository}/contents/${pathname}`);
    url.searchParams.set('ref', 'monitor-status');
    const req = https.request({
      hostname: url.hostname,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: {
        'User-Agent': 'Polymarket-Perps-Monitor',
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${process.env.GITHUB_TOKEN || ''}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) return resolve(null);
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function loadPersistedState() {
  const result = await githubRequest('.monitor-state.json');
  if (!result?.content) return null;
  try {
    return JSON.parse(Buffer.from(result.content.replace(/\s/g, ''), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

function loadFallbackLatest() {
  const latest = new Map();
  for (const line of lines) {
    try {
      const x = JSON.parse(line);
      if (x.timeframe && x.symbol && Number.isFinite(Number(x.period))) {
        const key = `${x.timeframe}:${x.symbol}`;
        const previous = latest.get(key);
        if (!previous || Number(x.period) >= Number(previous.period)) latest.set(key, x);
      }
    } catch {}
  }
  return latest;
}

async function main() {
  const convexByKey = new Map();
  for (const tf of frames) {
    const rows = await loadConvexStats(tf);
    if (!rows) continue;
    for (const row of rows) convexByKey.set(`${tf}:${row.symbol}`, row);
  }

  const persisted = await loadPersistedState();
  const stateByKey = new Map();
  for (const tf of frames) {
    const frame = persisted?.liquidationTimeframes?.[tf] || {};
    for (const symbol of symbols) {
      if (frame[symbol]) stateByKey.set(`${tf}:${symbol}`, frame[symbol]);
    }
  }

  const fallbackLatest = loadFallbackLatest();

  let out = '# MarginPad monitor statistics\n\n';
  out += `Updated: ${new Date().toISOString()}\n\n`;
  out += `Historical log lines retained: ${lines.length}\n`;
  out += `Alerts recorded: ${alerts.length}\n\n`;

  for (const tf of frames) {
    out += `## ${tf}\n\n`;
    out += '| Symbol | Imbalance | Long | Short | Long events | Short events | Buckets | Sign |\n';
    out += '|---|---:|---:|---:|---:|---:|---:|---:|\n';
    for (const symbol of symbols) {
      if (disabledSymbolsByTimeframe[tf].has(symbol)) continue;
      const key = `${tf}:${symbol}`;
      const state = stateByKey.get(key);
      const x = state || convexByKey.get(key) || fallbackLatest.get(key);
      if (!x) {
        out += `| ${symbol} | — | — | — | — | — | — | — |\n`;
        continue;
      }

      // Persisted monitor state is authoritative because its long/short totals,
      // event counts and imbalance are reconstructed from the same buckets.
      const longUsd = Math.max(0, Number(x.longUsd) || 0);
      const shortUsd = Math.max(0, Number(x.shortUsd) || 0);
      const imbalance = longUsd || shortUsd || state
        ? shortUsd - longUsd
        : (Number.isFinite(Number(x.imbalanceUsd)) ? Number(x.imbalanceUsd) : 0);
      const sign = imbalance > 0 ? 1 : imbalance < 0 ? -1 : 0;
      const longEvents = Number.isFinite(Number(x.longEvents)) ? Math.max(0, Number(x.longEvents)) : 0;
      const shortEvents = Number.isFinite(Number(x.shortEvents)) ? Math.max(0, Number(x.shortEvents)) : 0;
      const buckets = x.buckets && typeof x.buckets === 'object' && !Array.isArray(x.buckets)
        ? Object.keys(x.buckets).length
        : Array.isArray(x.buckets) ? x.buckets.length : Number.isFinite(Number(x.buckets)) ? Number(x.buckets) : '—';
      out += `| ${symbol} | ${signed(imbalance)} | ${usd(longUsd)} | ${usd(shortUsd)} | ${longEvents} | ${shortEvents} | ${buckets} | ${sign} |\n`;
    }
    out += '\n';
  }

  out += '## Recent alerts\n\n';
  for (const a of alerts.slice(-100).reverse()) out += `- ${a.timeframe} ${a.symbol} ${a.signal}\n`;
  fs.writeFileSync('monitor-stats.md', out);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
