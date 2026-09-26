const http = require("node:http");

const port = Number(process.env.PORT || 3000);
let monitorStarted = false;
let monitorError = null;

process.on("uncaughtException", (e) => {
  monitorError = String(e?.stack || e);
  process.stderr.write("DEPLEXO_UNCAUGHT " + monitorError + "\n");
});
process.on("unhandledRejection", (e) => {
  monitorError = String(e?.stack || e);
  process.stderr.write("DEPLEXO_REJECTION " + monitorError + "\n");
});

const server = http.createServer((req, res) => {
  const body = JSON.stringify({
    ok: true,
    service: "polymarket-soccer-live-monitor",
    monitorStarted,
    monitorError,
    time: new Date().toISOString()
  });
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
});

server.on("error", (e) => {
  process.stderr.write("DEPLEXO_SERVER_ERROR " + String(e?.stack || e) + "\n");
  process.exitCode = 1;
});

server.listen(port, "0.0.0.0", () => {
  process.stdout.write("DEPLEXO_LISTENING " + port + "\n");

  setImmediate(() => {
    try {
      process.env.DEPLEXO_WRAPPER = "1";
      require("./polymarket-soccer-live-alerts.js");
      monitorStarted = true;
      process.stdout.write("DEPLEXO_MONITOR_STARTED\n");
    } catch (e) {
      monitorError = String(e?.stack || e);
      process.stderr.write("DEPLEXO_MONITOR_ERROR " + monitorError + "\n");
    }
  });
});
