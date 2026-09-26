const http = require("node:http");

const port = Number(process.env.PORT || 3000);
const startedAt = new Date().toISOString();
const logBuffer = [];
const MAX_LOGS = 500;

function pushLog(level, args) {
  const line = "[" + new Date().toISOString() + "] " + level + " " +
    args.map(v => {
      try { return typeof v === "string" ? v : JSON.stringify(v); }
      catch { return String(v); }
    }).join(" ");
  logBuffer.push(line);
  if (logBuffer.length > MAX_LOGS) logBuffer.shift();
}

function safeWrite(line) {
  try { process.stdout.write(line + "\n"); } catch {}
}

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  pushLog("INFO", args);
  originalLog(...args);
};
console.error = (...args) => {
  pushLog("ERROR", args);
  originalError(...args);
};
console.warn = (...args) => {
  pushLog("WARN", args);
  originalWarn(...args);
};

safeWrite("DEPLEXO_BOOT");

const server = http.createServer((req,res)=>{
  try {
    if (req.url === "/logs") {
      const body = JSON.stringify({
        ok:true,
        service:"polymarket-soccer-live-monitor",
        startedAt,
        lines:logBuffer.length,
        logs:logBuffer
      });
      res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
      res.end(body);
      return;
    }

    if (req.url === "/health" || req.url === "/status") {
      const body = JSON.stringify({
        ok:true,
        service:"polymarket-soccer-live-monitor",
        startedAt,
        uptimeSec:Math.floor(process.uptime()),
        logLines:logBuffer.length,
        time:new Date().toISOString()
      });
      res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
      res.end(body);
      return;
    }

    const body = JSON.stringify({
      ok:true,
      service:"polymarket-soccer-live-monitor",
      time:new Date().toISOString()
    });
    res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
    res.end(body);
  } catch(e) {
    res.writeHead(500,{"content-type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({ok:false,error:String(e?.stack||e)}));
  }
});

server.on("error",e=>{
  safeWrite("DEPLEXO_SERVER_ERROR " + String(e?.stack||e));
});

server.listen(port,"0.0.0.0",()=>{
  safeWrite("DEPLEXO_LISTENING " + port);
  process.env.DEPLEXO_WRAPPER="1";
  try {
    require("./polymarket-soccer-live-alerts.js");
    safeWrite("DEPLEXO_MONITOR_STARTED");
  } catch(e) {
    safeWrite("DEPLEXO_MONITOR_ERROR " + String(e?.stack||e));
  }
});

process.on("uncaughtException",e=>{
  pushLog("FATAL",[String(e?.stack||e)]);
  safeWrite("DEPLEXO_UNCAUGHT " + String(e?.stack||e));
});
process.on("unhandledRejection",e=>{
  pushLog("FATAL",[String(e?.stack||e)]);
  safeWrite("DEPLEXO_REJECTION " + String(e?.stack||e));
});
