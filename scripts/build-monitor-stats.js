const fs = require('fs');

const path = process.argv[2] || 'monitor-history.log';
const text = fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '';
const lines = text.split(/\r?\n/).filter(Boolean);
const latest = new Map();
const alerts = [];

for (const line of lines) {
  try {
    const x = JSON.parse(line);
    if (x.timeframe && x.symbol) latest.set(`${x.timeframe}:${x.symbol}`, x);
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
  out += '| Symbol | Imbalance | Long | Short | Long events | Short events | Sign |\n';
  out += '|---|---:|---:|---:|---:|---:|---:|\n';
  for (const symbol of symbols) {
    const x = latest.get(`${tf}:${symbol}`);
    if (!x) {
      out += `| ${symbol} | — | — | — | — | — | — |\n`;
      continue;
    }
    out += `| ${symbol} | ${signed(x.imbalanceUsd)} | ${usd(x.longUsd)} | ${usd(x.shortUsd)} | ${x.longEvents ?? '—'} | ${x.shortEvents ?? '—'} | ${x.establishedSign ?? '—'} |\n`;
  }
  out += '\n';
}

out += '## Recent alerts\n\n';
for (const a of alerts.slice(-100).reverse()) out += `- ${a.timeframe} ${a.symbol} ${a.signal}\n`;

fs.writeFileSync('monitor-stats.md', out);
