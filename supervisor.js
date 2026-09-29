const { spawn } = require("child_process");
const children = [];
let stopping = false;

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
setTimeout(() => start("MONITOR", ["monitor.js"]), 1500);
