import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = "/data";
const LOG_FILE = path.join(DATA_DIR, "cs2-monitor.jsonl");
const STATS_FILE = path.join(DATA_DIR, "cs2-stats.json");
const DEDUPE_FILE = path.join(DATA_DIR, "cs2-alert-dedupe.json");
fs.mkdirSync(DATA_DIR, {recursive:true});

function readStats() {
  try { return JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); }
  catch { return {startedAt:new Date().toISOString(),events:0,byEvent:{},lastEvent:null,alerts:0,errors:0,polls:0,updatedAt:null}; }
}
function writeStats(s) { fs.writeFileSync(STATS_FILE, JSON.stringify(s,null,2)); }
let stats=readStats();
function readDedupe() { try { return JSON.parse(fs.readFileSync(DEDUPE_FILE, "utf8")); } catch { return {alerts:{}}; } }
function writeDedupe(s) { fs.writeFileSync(DEDUPE_FILE, JSON.stringify(s,null,2)); }
let dedupe=readDedupe();

function record(item) {
  fs.appendFileSync(LOG_FILE, JSON.stringify(item)+"\n");
  stats.events++;
  stats.byEvent[item.event]=(stats.byEvent[item.event]||0)+1;
  if (item.event==="ALERT_SENT") stats.alerts++;
  if (item.event==="POLL_ERROR" || item.event==="STATE_PUSH_ERROR") stats.errors++;
  if (item.event==="POLL_RESULT") stats.polls++;
  stats.lastEvent=item;
  stats.updatedAt=new Date().toISOString();
  writeStats(stats);
}
function send(res,status,body,type="application/json") {
  res.writeHead(status,{"content-type":type,"cache-control":"no-store","access-control-allow-origin":"*"});
  res.end(type==="application/json"?JSON.stringify(body):body);
}
function dashboard() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>CS2 Monitor</title><style>body{font-family:system-ui;margin:24px;max-width:1100px}pre{white-space:pre-wrap;word-break:break-word} .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}.card{border:1px solid #ccc;border-radius:8px;padding:12px}</style></head><body><h1>CS2 Monitor</h1><div id="stats">loading...</div><h2>Recent logs</h2><pre id="logs"></pre><script>
async function load(){const s=await fetch('/api/stats').then(r=>r.json());document.getElementById('stats').innerHTML='<div class="grid">'+[['Events',s.events],['Polls',s.polls],['Alerts',s.alerts],['Errors',s.errors]].map(x=>'<div class="card"><b>'+x[0]+'</b><br>'+x[1]+'</div>').join('')+'</div><p>Updated: '+s.updatedAt+'</p><pre>'+JSON.stringify(s.byEvent,null,2)+'</pre>';const l=await fetch('/api/logs?limit=100').then(r=>r.json());document.getElementById('logs').textContent=l.map(x=>JSON.stringify(x)).join('\n')}load();setInterval(load,5000);</script></body></html>`;
}
const server=http.createServer((req,res)=>{
  const u=new URL(req.url,"http://localhost");
  if(req.method==="GET" && u.pathname==="/health") return send(res,200,{ok:true,service:"cs2-monitor-log-server",updatedAt:stats.updatedAt});
  if(req.method==="GET" && u.pathname==="/api/stats") return send(res,200,stats);
  if(req.method==="POST" && u.pathname==="/api/claim-alert"){
    let body="";
    req.on("data",c=>{body+=c;if(body.length>100000) req.destroy();});
    req.on("end",()=>{
      try {
        const item=JSON.parse(body);
        const key=String(item.key||"").trim();
        if(!key) return send(res,400,{ok:false,error:"key required"});
        if(dedupe.alerts[key]) return send(res,409,{ok:false,duplicate:true,key,claimedAt:dedupe.alerts[key].claimedAt});
        dedupe.alerts[key]={claimedAt:new Date().toISOString(),runId:item.runId||null};
        writeDedupe(dedupe);
        return send(res,200,{ok:true,claimed:true,key});
      } catch(e) { return send(res,400,{ok:false,error:String(e)}); }
    });
    return;
  }
  if(req.method==="GET" && u.pathname==="/api/logs"){
    const limit=Math.min(500,Math.max(1,Number(u.searchParams.get("limit")||100)));
    let rows=[]; try { rows=fs.readFileSync(LOG_FILE,"utf8").trim().split("\n").filter(Boolean).slice(-limit).map(JSON.parse); } catch {}
    return send(res,200,rows);
  }
  if(req.method==="GET" && u.pathname==="/") return send(res,200,dashboard(),"text/html; charset=utf-8");
  if(req.method==="POST" && u.pathname==="/api/logs"){
    let body=""; req.on("data",c=>{body+=c;if(body.length>1000000) req.destroy();});
    req.on("end",()=>{try{const item=JSON.parse(body); if(!item.event) return send(res,400,{ok:false,error:"event required"}); record(item); send(res,200,{ok:true});}catch(e){send(res,400,{ok:false,error:String(e)});}});
    return;
  }
  send(res,404,{ok:false,error:"not found"});
});
server.listen(PORT,"0.0.0.0",()=>console.log("DEPLeXO_LOG_SERVER_READY",JSON.stringify({port:PORT,logFile:LOG_FILE})));
