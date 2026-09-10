const fs = require('fs');

const statePath = '.monitor-state.json';
const historyPath = process.argv[2] || 'monitor-history.log';
const state = fs.existsSync(statePath) ? (() => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; } })() : null;
const history = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8').split(/\r?\n/).filter(Boolean) : [];
const records = history.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
const periods = records.filter(x => x.type === 'period' && x.symbol === 'BTC' && x.timeframe === '5m');
const alerts = records.filter(x => x.type === 'alert' && x.symbol === 'BTC' && x.timeframe === '5m');
const currentCount = Number(state?.periodEventCount) || 0;
const currentStart = Number(state?.periodStart);
const currentStartText = Number.isFinite(currentStart) ? new Date(currentStart).toISOString() : '—';
const fmt = n => Number.isFinite(Number(n)) ? Number(n).toLocaleString('en-US') : '—';

let out = '# MarginPad monitor statistics\n\n';
out += `Updated: ${new Date().toISOString()}\n\n`;
out += '## Active monitor\n\n';
out += '| Symbol | Timeframe | Current period UTC | Liquidations | Armed after empty | Alerted | Last alert |\n';
out += '|---|---|---|---:|---|---|---|\n';
out += `| BTC | 5m | ${currentStartText} | ${fmt(currentCount)} | ${state?.armedAfterEmptyPeriod ? 'YES' : 'NO'} | ${state?.periodAlreadyAlerted ? 'YES' : 'NO'} | ${state?.lastAlertAt || '—'} |\n\n`;
out += `Completed 5m periods recorded: ${periods.length}\n`;
out += `BTC 5m alerts recorded: ${alerts.length}\n\n`;
out += '## Recent completed periods\n\n';
out += '| Period UTC | Liquidations | Status |\n|---|---:|---|\n';
for (const x of periods.slice(-30).reverse()) {
  out += `| ${new Date(Number(x.periodStart)).toISOString()} | ${fmt(x.eventCount)} | ${x.empty ? 'EMPTY → ARMED' : 'LIQUIDATIONS'} |\n`;
}
out += '\n## Recent alerts\n\n';
for (const x of alerts.slice(-30).reverse()) {
  out += `- ${x.ts} · BTC · 5m · ${x.display || x.side}\n`;
}
fs.writeFileSync('monitor-stats.md', out);
