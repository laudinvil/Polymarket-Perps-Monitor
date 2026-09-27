import http from "node:http";

const TOKEN=process.env.TELEGRAM_BOT_TOKEN||"";
const CHAT_ID=process.env.TELEGRAM_CHAT_ID||"";
const POLL_MS=Number(process.env.POLL_MS||15000);
const PORT=Number(process.env.PORT||3000);
const SOURCE="https://polymarket.com/ru/sports/soccer/games";
const seen=new Set();
let status={startedAt:new Date().toISOString(),scans:0,live:0,lastError:null};

const server=http.createServer((req,res)=>{
  res.writeHead(200,{"content-type":"application/json"});
  res.end(JSON.stringify({ok:true,service:"polymarket-live-soccer-monitor",...status}));
});
server.listen(PORT,"0.0.0.0",()=>console.log("HTTP HEALTH LISTENING:",PORT));

async function sendTelegram(text){
  if(!TOKEN||!CHAT_ID) throw new Error("TELEGRAM CONFIG MISSING");
  const r=await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`,{
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:CHAT_ID,text,disable_web_page_preview:false})
  });
  if(!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
}

function clean(s){
  return s.replace(/<[^>]*>/g," ")
    .replace(/&nbsp;/gi," ")
    .replace(/&amp;/gi,"&")
    .replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'")
    .replace(/\\s+/g," ").trim();
}

function extractLiveCards(html){
  const result=[];
  const marker="/sports/soccer/games/";
  let pos=0;
  while((pos=html.indexOf(marker,pos))!==-1){
    const start=Math.max(0,html.lastIndexOf("<a",pos));
    const end=html.indexOf("</a>",pos);
    if(start<0||end<0||end-start>20000){pos+=marker.length;continue;}
    const chunk=html.slice(start,end+4);
    const hrefMatch=chunk.match(/href=["']([^"']*\/sports\/soccer\/games\/[^"']*)["']/i);
    if(hrefMatch && /\\bLIVE\\b/i.test(clean(chunk))){
      const href=new URL(hrefMatch[1],SOURCE).href;
      result.push({href,text:clean(chunk)});
    }
    pos=pos+marker.length;
  }
  return [...new Map(result.map(x=>[x.href,x])).values()];
}

async function scan(){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),10000);
  try{
    const r=await fetch(SOURCE,{
      signal:controller.signal,
      headers:{
        "user-agent":"Mozilla/5.0",
        "accept":"text/html,application/xhtml+xml"
      }
    });
    if(!r.ok) throw new Error(`Polymarket HTTP ${r.status}`);
    const html=await r.text();
    console.log("FETCHED BYTES:",html.length);
    const live=extractLiveCards(html);
    status={...status,scans:status.scans+1,live:live.length,lastError:null};
    console.log(`SCAN: live=${live.length}`);
    for(const item of live){
      if(seen.has(item.href)) continue;
      const title=item.text.replace(/\\bLIVE\\b/ig,"").replace(/\\s+/g," ").trim();
      console.log("NEW LIVE:",item.href);
      await sendTelegram(`⚽ LIVE FOUND\\n\\n${title}\\n\\n${item.href}`);
      seen.add(item.href);
    }
  }finally{
    clearTimeout(timer);
  }
}

async function main(){
  console.log("MONITOR STARTING");
  console.log("SOURCE:",SOURCE);
  console.log("MODE: LOW-MEMORY HTTP");
  console.log("TELEGRAM:",TOKEN&&CHAT_ID?"CONFIGURED":"MISSING");
  while(true){
    try{await scan();}
    catch(e){status.lastError=e?.stack||String(e);console.error("SCAN ERROR:",status.lastError);}
    await new Promise(r=>setTimeout(r,POLL_MS));
  }
}

process.on("SIGTERM",()=>{server.close();process.exit(0)});
process.on("SIGINT",()=>{server.close();process.exit(0)});
main();
