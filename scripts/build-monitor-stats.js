const fs = require('fs');

const path = process.argv[2] || 'monitor-history.log';
const text = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
const lines = text.split(/\r?\n/).filter(Boolean);
const totals = new Map();
const latest = new Map();
const alerts = [];

for (const line of lines) {
  try {
    const x = JSON.parse(line);
    if (x.timeframe && x.symbol && Number.isFinite(Number(x.period))) {
      const key = `${x.timeframe}:${x.symbol}`;
      const longUsd = Math.max(0, Number(x.longUsd) || 0);
      const shortUsd = Math.max(0, Number(x.shortUsd) || 0);
      const longEvents = Math.max(0, Number(x.longEvents) || 0);
      const shortEvents = Math.max(0, Number(x.shortEvents) || 0);
      totals.set(key, {
        longUsd: (totals.get(key)?.longUsd || 0) + longUsd,
        shortUsd: (totals.get(key)?.shortUsd || 0) + shortUsd,
        longEvents: (totals.get(key)?.longEvents || 0) + longEvents,
        shortEvents: (totals.get(key)?.shortEvents || 0) + shortEvents,
        buckets: (totals.get(key)?.buckets || 0) + 1
      });
      latest.set(key, x);
    }
  } catch {}

  const m = line.match(/^ALERT SENT (5m|15m|1h|4h|1d) ([A-Z]+) (BUY UP|BUY DOWN)$/);
  if (m) alerts.push({ timeframe: m[1], symbol: m[2], signal: m[3] });
}

const frames = ['5m', '15m', '1h', '4h', '1d'];
const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const usd = n => Number.isFinite(Number(n)) ? `$${Math.round(Math.abs(Number(n))).toLocaleString('en-US')}` : '—';
const signed = n => Number.isFinite(Number(n)) ? `${Number(n) >= 0 ? '+' : '-'}$${Math.round(Math.abs(Number(n))).toLocaleString('en-US')}` : '—';

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
    const t = totals.get(key);
    const x = latest.get(key);
    if (!t) {
      out += `| ${symbol} | — | — | — | — | — | — | — |\n`;
      continue;
    }
    const imbalance = t.shortUsd - t.longUsd;
    const sign = imbalance > 0 ? 1 : imbalance < 0 ? -1 : 0;
    out += `| ${symbol} | ${signed(imbalance)} | ${usd(t.longUsd)} | ${usd(t.shortUsd)} | ${t.longEvents} | ${t.shortEvents} | ${t.buckets} | ${sign} |\n`;
  }
  out += '\n';
}

out += '## Recent alerts\n\n';
for (const a of alerts.slice(-100).reverse()) out += `- ${a.timeframe} ${a.symbol} ${a.signal}\n`;

fs.writeFileSync('monitor-stats.md', out);
