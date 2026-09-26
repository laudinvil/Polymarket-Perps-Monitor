const http = require("node:http");
const fs = require("node:fs");
const port = Number(process.env.PORT || 3000);
const logFile = "/data/deplexo-runtime.log";

function writeLog(line) {
  const text = String(line) + "\n";
  process.stdout.write(text);
  try { fs.mkdirSync("/data", {recursive:true}); fs.appendFileSync(logFile, text); } catch {}
}
const originalLog = console.log;
const originalError = console.error;
console.log = (...a) => writeLog(a.map(x=>typeof x === "string" ? x : JSON.stringify(x)).join(" "));
console.error = (...a) => writeLog(a.map(x=>typeof x === "string" ? x : JSON.stringify(x)).join(" "));

const server = http.createServer((req,res)=>{
  if(req.url === "/logs") {
    let body = "";
    try { body = fs.readFileSync(logFile,"utf8"); } catch {}
    res.writeHead(200,{"content-type":"text/plain; charset=utf-8","cache-control":"no-store"});
    res.end(body.slice(-200000) || "NO_RUNTIME_LOGS_YET\\n");
    return;
  }
  if(req.url === "/health" || req.url === "/") {
    res.writeHead(200,{"content-type":"application/json; charset=utf-8","cache-control":"no-store"});
    res.end(JSON.stringify({ok:true,service:"polymarket-soccer-live-monitor",logs:"/logs",time:new Date().toISOString()}));
    return;
  }
  res.writeHead(404,{"content-type":"application/json; charset=utf-8"});
  res.end(JSON.stringify({ok:false,error:"not_found"}));
});

server.listen(port,"0.0.0.0",()=>{
  writeLog("DEPLEXO_HTTP_READY " + JSON.stringify({node:process.version,pid:process.pid,port}));
  process.env.DEPLEXO_WRAPPER = "1";
  try {
    require("./polymarket-soccer-live-alerts.js");
    writeLog("DEPLEXO_MONITOR_LOADED");
  } catch(e) {
    console.error("DEPLEXO_MONITOR_LOAD_FAILED " + JSON.stringify({name:e?.name,message:e?.message,stack:e?.stack}));
  }
});

process.on("uncaughtException",e=>console.error("DEPLEXO_UNCAUGHT " + JSON.stringify({message:e?.message,stack:e?.stack})));
process.on("unhandledRejection",e=>console.error("DEPLEXO_REJECTION " + JSON.stringify({message:e?.message,stack:e?.stack})));
