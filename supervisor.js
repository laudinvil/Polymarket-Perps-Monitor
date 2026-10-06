const { spawn } = require("child_process");
const http = require("http");

const HEALTH_PORT = Number(process.env.MONITOR_HEALTH_PORT || 8080);
http.createServer((req, res) => {
  res.writeHead(200, {"Content-Type":"application/json"});
  res.end(JSON.stringify({ok:true, services:["TRADE_FREQ"]}));
}).listen(HEALTH_PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({
    ts:new Date().toISOString(),
    component:"SUPERVISOR",
    event:"HEALTH_LISTENING",
    port:HEALTH_PORT
  }));
});

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

start("TRADE_FREQ", ["trade-frequency-monitor.js"]);

