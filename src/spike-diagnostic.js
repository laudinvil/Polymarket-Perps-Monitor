import { spawn } from 'node:child_process';

const run = (script) => new Promise((resolve, reject) => {
  const p = spawn(process.execPath, [script], { env: { ...process.env, RUN_ONCE: 'true' }, stdio: 'inherit' });
  p.on('exit', code => code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`)));
  p.on('error', reject);
});

console.log('=== SPIKE ONE-SHOT DIAGNOSTIC ===');
console.log(`started=${new Date().toISOString()}`);
try {
  await run('src/spike.js');
  console.log('=== HYPERLIQUID SPIKE DIAGNOSTIC COMPLETE ===');
} catch (e) {
  console.error(`[HL SPIKE DIAGNOSTIC ERROR] ${e.message}`);
  process.exitCode = 1;
}

try {
  await run('src/binance-spike.js');
  console.log('=== BINANCE SPIKE DIAGNOSTIC COMPLETE ===');
} catch (e) {
  console.error(`[BINANCE SPIKE DIAGNOSTIC ERROR] ${e.message}`);
  process.exitCode = 1;
}
console.log(`finished=${new Date().toISOString()}`);
