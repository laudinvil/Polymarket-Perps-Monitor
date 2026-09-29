const { spawn } = require("child_process");
const children = [];
let stopping = false;
let monitorStarted = false;

function start(name, args) {
  const child = spawn(process.execPath, args, {stdio:["ignore","pipe","pipe"], env:process.env});
  children.push({name, child});
  child.stdout.on("data", data => process.stdout.write("[" + name + "] " + data));
  child.stderr.on("data", data => process.stderr.write("[" + name + "] " + data));
  child.on("exit", (code, signal) => {
    console.log(JSON.stringify({ts:new Date().toISOString(),component:"SUPERVISOR",event:"CHILD_EXIT",name,code,signal}));
    if (!stopping) process.exit(code || 1);
  });
}

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(JSON.stringify({ts:new Date().toISOString(),component:"SUPERVISOR",event:"STOPPING",signal}));
  for (const {child} of children) { try { child.kill("SIGTERM"); } catch {} }
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

start("AGGR", ["aggr-bridge.js"]);
function waitForAggr() {
  if (stopping || monitorStarted) return;
  const req = require("http").get("http://127.0.0.1:9090/health", res => {
    res.resume();
    if (res.statusCode === 200) {
      monitorStarted = true;
      console.log(JSON.stringify({
        ts: new Date().toISOString(),
        component: "SUPERVISOR",
        event: "AGGR_READY",
        endpoint: "http://127.0.0.1:9090/health"
      }));
      start("MONITOR", ["monitor.js"]);
      return;
    }
    setTimeout(waitForAggr, 1000).unref();
  });
  req.on("error", () => setTimeout(waitForAggr, 1000).unref());
  req.setTimeout(1000, () => req.destroy());
}

waitForAggr();
