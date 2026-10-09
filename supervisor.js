const { spawn } = require("child_process");
const children = new Map();
let stopping = false;
let restartTimer = null;

function startMonitor() {
  if (stopping) return;
  const existing = children.get("MONITOR");
  if (existing && existing.exitCode === null && !existing.killed) return;
  const child = spawn(process.execPath, ["monitor.js"], {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env
  });
  children.set("MONITOR", child);
  child.stdout.on("data", function(data) { process.stdout.write("[MONITOR] " + data); });
  child.stderr.on("data", function(data) { process.stderr.write("[MONITOR] " + data); });
  child.on("exit", function(code, signal) {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      component: "SUPERVISOR",
      event: "CHILD_EXIT",
      name: "MONITOR",
      code: code,
      signal: signal
    }));
    if (children.get("MONITOR") === child) children.delete("MONITOR");
    if (!stopping && !restartTimer) {
      restartTimer = setTimeout(function() {
        restartTimer = null;
        startMonitor();
      }, 1000);
    }
  });
}
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    component: "SUPERVISOR",
    event: "STOPPING",
    signal: signal
  }));
  if (restartTimer) clearTimeout(restartTimer);
  for (const child of children.values()) {
    try { child.kill("SIGTERM"); } catch (_) {}
  }
  setTimeout(function() { process.exit(0); }, 5000).unref();
}
process.on("SIGTERM", function() { shutdown("SIGTERM"); });
process.on("SIGINT", function() { shutdown("SIGINT"); });
startMonitor();
