const fs = require('fs');

const statePath = '.monitor-state.json';
const historyPath = process.argv[2] || 'monitor-history.log';
const state = fs.existsSync(statePath) ? (() => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; } })() : null;
const history = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8').split(/\r?\n/).filter(Boolean) : [];
const records = history.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const symbols = ['BTC', 'ETH', 'SOL'];
const periods = records.filter(x => x.type === 'period' && x.timeframe === '5m' && symbols.includes(x.symbol));
const alerts = records.filter(x => x.type === 'alert' && x.timeframe === '5m' && symbols.includes(x.symbol));
const currentCounts = state?.periodEventCount && typeof state.periodEventCount === 'object' ? state.periodEventCount : {};
const currentStart = Number(state?.periodStart);
const currentStartText = Number.isFinite(currentStart) ? new Date(currentStart).toISOString() : '—';
const fmt = n => Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '—';

let out = '# MarginPad monitor statistics\n\n';
out += `Updated: ${new Date().toISOString()}\n\n`;
out += '## Active monitor\n\n';
out += '| Symbol | Timeframe | Current period UTC | Liquidations | Alerted | Last alert |\n';
out += '|---|---|---|---:|---|---|\n';
for (const symbol of symbols) {
  out += `| ${symbol} | 5m | ${currentStartText} | ${fmt(currentCounts[symbol])} | ${state?.periodAlreadyAlerted ? 'YES' : 'NO'} | ${state?.lastAlertAt || '—'} |\n`;
}
out += '\n';
out += `Completed 5m periods recorded: ${periods.length}\n`;
out += `5m alerts recorded: ${alerts.length}\n\n`;
out += '## Recent completed periods\n\n';
out += '| Period UTC | BTC | ETH | SOL | Total | Status |\n|---|---:|---:|---:|---:|---|\n';
const grouped = new Map();
for (const x of periods) {
  const key = String(x.periodStart);
  if (!grouped.has(key)) grouped.set(key, { periodStart: Number(x.periodStart), counts: { BTC: 0, ETH: 0, SOL: 0 } });
  const row = grouped.get(key);
  row.counts[x.symbol] = Number(x.eventCount) || 0;
}
for (const row of [...grouped.values()].slice(-30).reverse()) {
  const total = symbols.reduce((sum, symbol) => sum + (row.counts[symbol] || 0), 0);
  out += `| ${new Date(row.periodStart).toISOString()} | ${fmt(row.counts.BTC)} | ${fmt(row.counts.ETH)} | ${fmt(row.counts.SOL)} | ${fmt(total)} | ${total > 0 ? 'LIQUIDATIONS' : 'NO LIQUIDATIONS'} |\n`;
}
out += '\n## Recent alerts\n\n';
for (const x of alerts.slice(-30).reverse()) {
  out += `- ${x.ts} · ${x.symbol} · 5m · ${x.display || x.side}\n`;
}
fs.writeFileSync('monitor-stats.md', out);
