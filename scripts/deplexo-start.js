const http = require("node:http");

const port = Number(process.env.PORT || 3000);

function log(event, extra = {}) {
  process.stdout.write(JSON.stringify({level:"INFO",event,...extra}) + "\\n");
}

log("deplexo_wrapper_boot", {node:process.version,pid:process.pid,port});

function fallbackHealth() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {"content-type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({ok:false,service:"polymarket-soccer-live-monitor",startupError:true}));
  });
  server.listen(port, "0.0.0.0", () => {
    log("monitor_load_failed_fallback_health",{port});
  });
}

process.on("uncaughtException", e => {
  process.stderr.write(JSON.stringify({level:"ERROR",event:"wrapper_uncaught_exception",name:e?.name,message:e?.message,stack:e?.stack}) + "\n");
});
process.on("unhandledRejection", e => {
  process.stderr.write(JSON.stringify({level:"ERROR",event:"wrapper_unhandled_rejection",message:e?.message||String(e),stack:e?.stack}) + "\n");
});

try {
  require("./polymarket-soccer-live-alerts.js");
  log("monitor_module_loaded",{node:process.version,port});
} catch (e) {
  process.stderr.write(JSON.stringify({level:"ERROR",event:"monitor_module_load_failed",name:e?.name,message:e?.message,stack:e?.stack}) + "\n");
  fallbackHealth();
}

setInterval(() => {}, 2147483647);
