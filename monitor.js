import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_MS = Number(process.env.POLL_MS || 15000);
const PORT = Number(process.env.PORT || 3000);
const SOURCE = "https://polymarket.com/ru/sports/soccer/games";
const seen = new Set();
let status = {startedAt:new Date().toISOString(),scans:0,live:0,lastError:null};

const server=http.createServer((req,res)=>{
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({ok:true,service:"polymarket-live-soccer-monitor",...status}));
});
server.listen(PORT,"0.0.0.0",()=>console.log("HTTP HEALTH LISTENING:",PORT));

async function sendTelegram(text){
  if(!TOKEN||!CHAT_ID) throw new Error("TELEGRAM CONFIG MISSING");
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:CHAT_ID,text,disable_web_page_preview:false})
  });
  if(!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${await r.text()}`);
}

async function scan(){
  const {stdout,stderr}=await execFileAsync("/usr/bin/chromium",[
    "--headless=new","--no-sandbox","--disable-setuid-sandbox",
    "--disable-dev-shm-usage","--disable-crash-reporter","--disable-breakpad",
    "--disable-features=Crashpad","--disable-gpu","--no-first-run",
    "--disable-background-networking","--disable-component-update",
    "--disable-sync","--user-data-dir=/tmp/chromium-monitor",
    "--dump-dom",SOURCE
  ],{timeout:45000,maxBuffer:20*1024*1024});
  if(stderr) console.log("CHROMIUM:",stderr.slice(-2000));
  const html=stdout;
  const cards=[];
  const re=/<a\\b[^>]*href=["']([^"']*\\/sports\\/soccer\\/games\\/[^"']*)["'][^>]*>([\\s\\S]*?)<\\/a>/gi;
  let m;
  while((m=re.exec(html))){
    const text=m[2].replace(/<script[\\s\\S]*?<\\/script>/gi," ").replace(/<style[\\s\\S]*?<\\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/\\s+/g," ").trim();
    const href=new URL(m[1],SOURCE).href;
    cards.push({href,text});
  }
  const live=cards.filter(x=>/\\bLIVE\\b/i.test(x.text));
  status={...status,scans:status.scans+1,live:live.length,lastError:null};
  console.log(`SCAN: cards=${cards.length} live=${live.length}`);
  for(const item of live){
    if(seen.has(item.href)) continue;
    seen.add(item.href);
    const title=item.text.replace(/\\bLIVE\\b/ig,"").replace(/\\s+/g," ").trim();
    console.log("NEW LIVE:",item.href);
    await sendTelegram(`⚽ LIVE FOUND\\n\\n${title}\\n\\n${item.href}`);
    console.log("TELEGRAM SENT:",item.href);
  }
}

async function main(){
  console.log("MONITOR STARTING");
  console.log("SOURCE:",SOURCE);
  console.log("POLL_MS:",POLL_MS);
  console.log("TELEGRAM CONFIG:",TOKEN?"TOKEN=SET":"TOKEN=MISSING",CHAT_ID?"CHAT_ID=SET":"CHAT_ID=MISSING");
  while(true){
    try{await scan();}
    catch(e){
      status={...status,lastError:e?.stack||String(e)};
      console.error("SCAN ERROR:",e?.stack||e);
    }
    await new Promise(r=>setTimeout(r,POLL_MS));
  }
}
process.on("SIGTERM",()=>{server.close();process.exit(0)});
process.on("SIGINT",()=>{server.close();process.exit(0)});
main();
