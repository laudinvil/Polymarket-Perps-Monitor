import http from "node:http";

const PORT=Number(process.env.PORT||3000);
const server=http.createServer((req,res)=>{
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({
    ok:true,
    service:"polymarket-live-soccer-monitor",
    startedAt:process.env.STARTED_AT||new Date().toISOString()
  }));
});
server.listen(PORT,"0.0.0.0",()=>console.log("HEALTH LISTENING",PORT));

console.log("MONITOR STARTING");
console.log("MODE: lightweight runtime");
