const http = require("node:http");

const port = Number(process.env.PORT || 3000);

function fallbackHealth() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, {"content-type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({ok:false,service:"polymarket-soccer-live-monitor",startupError:true}));
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(JSON.stringify({level:"ERROR",event:"monitor_load_failed_fallback_health",port}));
  });
}

process.on("uncaughtException", e => {
  console.log(JSON.stringify({level:"ERROR",event:"wrapper_uncaught_exception",name:e?.name,message:e?.message,stack:e?.stack}));
});
process.on("unhandledRejection", e => {
  console.log(JSON.stringify({level:"ERROR",event:"wrapper_unhandled_rejection",message:e?.message||String(e),stack:e?.stack}));
});

try {
  require("./polymarket-soccer-live-alerts.js");
  console.log(JSON.stringify({level:"INFO",event:"monitor_module_loaded",node:process.version,port}));
} catch (e) {
  console.log(JSON.stringify({level:"ERROR",event:"monitor_module_load_failed",name:e?.name,message:e?.message,stack:e?.stack}));
  fallbackHealth();
}

setInterval(() => {}, 2147483647);
