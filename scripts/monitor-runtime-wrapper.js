const { spawn } = require('child_process');

const CONVEX_SITE_URL = process.env.CONVEX_SITE_URL || 'https://brainy-canary-207.eu-west-1.convex.site';
const CONVEX_INGEST_TOKEN = process.env.CONVEX_INGEST_TOKEN || '';
const RUN_ID = Number(process.env.GITHUB_RUN_ID || Date.now());
const GITHUB_RUN_ID = String(process.env.GITHUB_RUN_ID || RUN_ID);
const COMMIT_SHA = String(process.env.GITHUB_SHA || 'unknown');
const startedAt = Date.now();
let finished = false;

async function convexRuntime(type, data) {
  if (!CONVEX_INGEST_TOKEN) return;
  try {
    const response = await fetch(`${CONVEX_SITE_URL}/ingest`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${CONVEX_INGEST_TOKEN}`,
      },
      body: JSON.stringify({ type: `runtime.${type}`, data }),
    });
    if (!response.ok) console.error(`[CONVEX-RUNTIME] ingest ${type} failed: HTTP ${response.status}`);
  } catch (error) {
    console.error(`[CONVEX-RUNTIME] ingest ${type} failed: ${error.message}`);
  }
}

function writeLog(level, message) {
  return convexRuntime('log', {
    runId: RUN_ID,
    level,
    message: String(message).slice(0, 4000),
    ts: Date.now(),
  });
}

async function finish(status, exitCode = null) {
  if (finished) return;
  finished = true;
  await convexRuntime('finish', { runId: RUN_ID, finishedAt: Date.now(), status, exitCode });
}

(async () => {
  await convexRuntime('start', {
    runId: RUN_ID,
    githubRunId: GITHUB_RUN_ID,
    commitSha: COMMIT_SHA,
    startedAt,
  });

  const child = spawn(process.execPath, ['-r', './src/http-timeout.js', 'scripts/liquidation-long-monitor.js'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  let heartbeatBusy = false;
  const heartbeat = setInterval(() => {
    if (heartbeatBusy || finished) return;
    heartbeatBusy = true;
    convexRuntime('heartbeat', { runId: RUN_ID, heartbeatAt: Date.now() }).finally(() => { heartbeatBusy = false; });
  }, 30000);
  heartbeat.unref();

  const attach = (stream, level) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line) continue;
        console.log(line);
        void writeLog(level, line);
      }
    });
    stream.on('end', () => {
      if (buffer) void writeLog(level, buffer);
    });
  };
  attach(child.stdout, 'info');
  attach(child.stderr, 'error');

  const stop = async (signal) => {
    await writeLog('warn', `wrapper received ${signal}`);
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(async () => {
      try { child.kill('SIGKILL'); } catch {}
      await finish('failed', 143);
      process.exit(143);
    }, 10000).unref();
  };
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
  process.on('SIGINT', () => { void stop('SIGINT'); });

  child.on('error', async (error) => {
    await writeLog('error', `child process error: ${error.message}`);
    clearInterval(heartbeat);
    await finish('failed', 1);
    process.exit(1);
  });

  child.on('close', async (code, signal) => {
    clearInterval(heartbeat);
    if (signal) await writeLog('warn', `monitor exited by signal ${signal}`);
    await finish(code === 0 ? 'completed' : 'failed', code);
    process.exit(code === null ? 1 : code);
  });
})();
