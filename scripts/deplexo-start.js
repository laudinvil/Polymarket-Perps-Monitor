const http = require("node:http");
const port = Number(process.env.PORT || 3000);

const server = http.createServer((req,res)=>{
  res.writeHead(200,{"content-type":"application/json; charset=utf-8"});
  res.end(JSON.stringify({ok:true,service:"polymarket-soccer-live-monitor",time:new Date().toISOString()}));
});

server.listen(port,"0.0.0.0",()=>{
  console.log(JSON.stringify({level:"INFO",event:"deplexo_http_ready",node:process.version,pid:process.pid,port}));
  try {
    require("./polymarket-soccer-live-alerts.js");
    console.log(JSON.stringify({level:"INFO",event:"monitor_module_loaded"}));
  } catch(e) {
    console.error(JSON.stringify({level:"ERROR",event:"monitor_module_load_failed",name:e?.name,message:e?.message,stack:e?.stack}));
  }
});

process.on("uncaughtException",e=>console.error(JSON.stringify({level:"ERROR",event:"uncaught_exception",message:e?.message,stack:e?.stack})));
process.on("unhandledRejection",e=>console.error(JSON.stringify({level:"ERROR",event:"unhandled_rejection",message:e?.message,stack:e?.stack})));
