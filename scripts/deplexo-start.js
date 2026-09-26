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

process.stdout.write("DEPLEXO_BOOT\n");

const server = http.createServer((req,res)=>{
  if (req.url === "/logs") {
    const body = JSON.stringify({
      ok: true,
      service: "polymarket-soccer-live-monitor",
      startedAt,
      lines: logBuffer.length,
      logs: logBuffer
    });
    res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
    res.end(body);
    return;
  }

  if (req.url === "/health" || req.url === "/status") {
    const body = JSON.stringify({
      ok: true,
      service: "polymarket-soccer-live-monitor",
      startedAt,
      uptimeSec: Math.floor(process.uptime()),
      logLines: logBuffer.length,
      time: new Date().toISOString()
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
});

server.on("error",e=>process.stderr.write("DEPLEXO_SERVER_ERROR "+String(e?.stack||e)+"\n"));

server.listen(port,"0.0.0.0",()=>{
  process.stdout.write("DEPLEXO_LISTENING "+port+"\n");
  process.env.DEPLEXO_WRAPPER="1";
  try {
    require("./polymarket-soccer-live-alerts.js");
    process.stdout.write("DEPLEXO_MONITOR_STARTED\n");
  } catch(e) {
    process.stderr.write("DEPLEXO_MONITOR_ERROR "+String(e?.stack||e)+"\n");
  }
});

process.on("uncaughtException",e=>{
  pushLog("FATAL", [String(e?.stack||e)]);
  process.stderr.write("DEPLEXO_UNCAUGHT "+String(e?.stack||e)+"\n");
});
process.on("unhandledRejection",e=>{
  pushLog("FATAL", [String(e?.stack||e)]);
  process.stderr.write("DEPLEXO_REJECTION "+String(e?.stack||e)+"\n");
});
