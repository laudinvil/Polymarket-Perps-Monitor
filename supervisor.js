const { spawn } = require("child_process");
const children = new Map();
let stopping = false;
const restartTimers = new Map();

function start(name, args) {
  if (stopping) return;
  const existing = children.get(name);
  if (existing && existing.exitCode === null && !existing.killed) return;

  const child = spawn(process.execPath, args, {stdio:["ignore","pipe","pipe"], env:process.env});
  children.set(name, child);
  child.stdout.on("data", data => process.stdout.write("[" + name + "] " + data));
  child.stderr.on("data", data => process.stderr.write("[" + name + "] " + data));
  child.on("exit", (code, signal) => {
    console.log(JSON.stringify({ts:new Date().toISOString(),component:"SUPERVISOR",event:"CHILD_EXIT",name,code,signal}));
    if (children.get(name) === child) children.delete(name);
    if (!stopping) {
      const previous = restartTimers.get(name);
      if (previous) clearTimeout(previous);
      const timer = setTimeout(() => {
        restartTimers.delete(name);
        console.log(JSON.stringify({ts:new Date().toISOString(),component:"SUPERVISOR",event:"CHILD_RESTART",name}));
        start(name, args);
      }, name === "AGGR" ? 2000 : 1000);
      restartTimers.set(name, timer);
    }
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ts:new Date().toISOString(),component:"SUPERVISOR",event:"STOPPING",signal}));
  for (const child of children.values()) { try { child.kill("SIGTERM"); } catch {} }
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start("AGGR", ["aggr-bridge.js"]);
start("MONITOR", ["monitor.js"]);\nstart("SPORTS_ELO", ["sports-elo-monitor.js"]);

function watchAggr() {
  if (stopping) return;
  const req = require("http").get("http://127.0.0.1:9090/health", res => {
    res.resume();
    if (res.statusCode === 200) {
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        component: "SUPERVISOR",
        event: "AGGR_READY",
        endpoint: "http://127.0.0.1:9090/health"
      }));
    } else {
      setTimeout(watchAggr, 1000).unref();
    }
  });
  req.on("error", () => setTimeout(watchAggr, 1000).unref());
  req.setTimeout(1000, () => req.destroy());
}

watchAggr();
