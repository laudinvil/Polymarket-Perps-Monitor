const fs = require('fs');

const path = process.argv[2] || 'monitor-history.log';
const text = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
const lines = text.split(/\r?\n/).filter(Boolean);
const alerts = [];

for (const line of lines) {
  const m = line.match(/^ALERT SENT (5m|15m|1h|4h|1d) ([A-Z]+) (BUY UP|BUY DOWN)$/);
  if (m) alerts.push({ timeframe: m[1], symbol: m[2], signal: m[3] });
}

const frames = ['5m', '15m', '1h', '4h', '1d'];
const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
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

async function main() {
  // Convex is authoritative for current statistics. The local history remains
  // useful only for the alert list and as a fallback when Convex is unavailable.
  const convexByKey = new Map();
  for (const tf of frames) {
    const rows = await loadConvexStats(tf);
    if (!rows) continue;
    for (const row of rows) convexByKey.set(`${tf}:${row.symbol}`, row);
  }

  const fallbackLatest = new Map();
  for (const line of lines) {
    try {
      const x = JSON.parse(line);
      if (x.timeframe && x.symbol && Number.isFinite(Number(x.period))) {
        const key = `${x.timeframe}:${x.symbol}`;
        const previous = fallbackLatest.get(key);
        if (!previous || Number(x.period) >= Number(previous.period)) fallbackLatest.set(key, x);
      }
    } catch {}
  }

  let out = '# MarginPad monitor statistics\n\n';
  out += `Updated: ${new Date().toISOString()}\n\n`;
  out += `Historical log lines retained: ${lines.length}\n`;
  out += `Alerts recorded: ${alerts.length}\n\n`;

  for (const tf of frames) {
    out += `## ${tf}\n\n`;
    out += '| Symbol | Imbalance | Long | Short | Long events | Short events | Buckets | Sign |\n';
    out += '|---|---:|---:|---:|---:|---:|---:|---:|\n';
    for (const symbol of symbols) {
      const key = `${tf}:${symbol}`;
      const x = convexByKey.get(key) || fallbackLatest.get(key);
      if (!x) {
        out += `| ${symbol} | — | — | — | — | — | — | — |\n`;
        continue;
      }
      const longUsd = Math.max(0, Number(x.longUsd) || 0);
      const shortUsd = Math.max(0, Number(x.shortUsd) || 0);
      const imbalance = Number.isFinite(Number(x.imbalanceUsd))
        ? Number(x.imbalanceUsd)
        : shortUsd - longUsd;
      const sign = imbalance > 0 ? 1 : imbalance < 0 ? -1 : 0;
      const longEvents = Number.isFinite(Number(x.longEvents)) ? Math.max(0, Number(x.longEvents)) : 0;
      const shortEvents = Number.isFinite(Number(x.shortEvents)) ? Math.max(0, Number(x.shortEvents)) : 0;
      const buckets = Array.isArray(x.buckets)
        ? x.buckets.length
        : Number.isFinite(Number(x.buckets)) ? Number(x.buckets) : '—';
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
