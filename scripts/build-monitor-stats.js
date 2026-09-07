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
      const hasLongEvents = Number.isFinite(Number(x.longEvents));
      const hasShortEvents = Number.isFinite(Number(x.shortEvents));
      const previous = totals.get(key) || { longUsd: 0, shortUsd: 0, fallbackLongEvents: 0, fallbackShortEvents: 0, buckets: 0 };

      totals.set(key, {
        longUsd: previous.longUsd + longUsd,
        shortUsd: previous.shortUsd + shortUsd,
        // index.js logs cumulative event counters, so they must NOT be summed.
        latestLongEvents: hasLongEvents ? Math.max(0, Number(x.longEvents)) : (previous.latestLongEvents || 0),
        latestShortEvents: hasShortEvents ? Math.max(0, Number(x.shortEvents)) : (previous.latestShortEvents || 0),
        hasLongEventCounter: previous.hasLongEventCounter || hasLongEvents,
        hasShortEventCounter: previous.hasShortEventCounter || hasShortEvents,
        // Fallback for older log lines that predate event-counter logging.
        fallbackLongEvents: previous.fallbackLongEvents + (longUsd > 0 ? 1 : 0),
        fallbackShortEvents: previous.fallbackShortEvents + (shortUsd > 0 ? 1 : 0),
        buckets: previous.buckets + 1
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
    if (!t) {
      out += `| ${symbol} | — | — | — | — | — | — | — |\n`;
      continue;
    }
    const imbalance = t.shortUsd - t.longUsd;
    const sign = imbalance > 0 ? 1 : imbalance < 0 ? -1 : 0;
    const longEvents = t.hasLongEventCounter ? t.latestLongEvents : t.fallbackLongEvents;
    const shortEvents = t.hasShortEventCounter ? t.latestShortEvents : t.fallbackShortEvents;
    out += `| ${symbol} | ${signed(imbalance)} | ${usd(t.longUsd)} | ${usd(t.shortUsd)} | ${longEvents} | ${shortEvents} | ${t.buckets} | ${sign} |\n`;
  }
  out += '\n';
}

out += '## Recent alerts\n\n';
for (const a of alerts.slice(-100).reverse()) out += `- ${a.timeframe} ${a.symbol} ${a.signal}\n`;

fs.writeFileSync('monitor-stats.md', out);
