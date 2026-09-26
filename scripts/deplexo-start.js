const http = require("node:http");
const port = Number(process.env.PORT || 3000);

const state = {
  bootedAt: new Date().toISOString(),
  monitorStarted: false,
  monitorError: null
};

process.stdout.write("DEPLEXO_BOOT\n");

const server = http.createServer((req,res)=>{
  const body = JSON.stringify({
    ok: true,
    service: "polymarket-soccer-live-monitor",
    time: new Date().toISOString(),
    ...state
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
    state.monitorStarted = true;
    process.stdout.write("DEPLEXO_MONITOR_STARTED\n");
  } catch(e) {
    state.monitorError = String(e?.stack||e);
    process.stderr.write("DEPLEXO_MONITOR_ERROR "+state.monitorError+"\n");
  }
});

process.on("uncaughtException",e=>process.stderr.write("DEPLEXO_UNCAUGHT "+String(e?.stack||e)+"\n"));
process.on("unhandledRejection",e=>process.stderr.write("DEPLEXO_REJECTION "+String(e?.stack||e)+"\n"));
