import http from "node:http";
import https from "node:https";

const TOKEN=process.env.TELEGRAM_BOT_TOKEN||"";
const CHAT_ID=process.env.TELEGRAM_CHAT_ID||"";
const POLL_MS=Number(process.env.POLL_MS||15000);
const PORT=Number(process.env.PORT||3000);
const HOST="polymarket.com";
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
    method:"POST",headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:CHAT_ID,text,disable_web_page_preview:false})
  });
  if(!r.ok) throw new Error(`Telegram HTTP ${r.status}`);
}

function clean(s){
  return s.replace(/<[^>]*>/g," ").replace(/&nbsp;/gi," ")
    .replace(/&amp;/gi,"&").replace(/&quot;/gi,'"')
    .replace(/&#39;/gi,"'").replace(/\s+/g," ").trim();
}

function extractLiveCards(html){
  const result=[],marker="/sports/soccer/games/";
  let pos=0;
  while((pos=html.indexOf(marker,pos))!==-1){
    const start=html.lastIndexOf("<a",pos),end=html.indexOf("</a>",pos);
    if(start<0||end<0||end-start>20000){pos+=marker.length;continue;}
    const chunk=html.slice(start,end+4);
    const m=chunk.match(/href=["']([^"']*\/sports\/soccer\/games\/[^"']*)["']/i);
    if(m&&/\bLIVE\b/i.test(clean(chunk)))
      result.push({href:new URL(m[1],SOURCE).href,text:clean(chunk)});
    pos+=marker.length;
  }
  return [...new Map(result.map(x=>[x.href,x])).values()];
}

function dohResolve(host){
  return new Promise((resolve,reject)=>{
    const req=https.request({
      host:"1.1.1.1",port:443,path:`/dns-query?name=${encodeURIComponent(host)}&type=A`,
      method:"GET",servername:"cloudflare-dns.com",
      headers:{host:"cloudflare-dns.com",accept:"application/dns-json"}
    },res=>{
      let body="";
      res.setEncoding("utf8");
      res.on("data",d=>body+=d);
      res.on("end",()=>{
        try{
          const data=JSON.parse(body);
          const ip=data.Answer?.find(x=>x.type===1)?.data;
          if(ip) resolve(ip); else reject(new Error("DOH_NO_A_RECORD"));
        }catch(e){reject(e);}
      });
    });
    req.setTimeout(5000,()=>req.destroy(new Error("DOH_TIMEOUT")));
    req.on("error",reject);
    req.end();
  });
}

function fetchViaIp(ip){
  return new Promise((resolve,reject)=>{
    const req=https.request({
      host:ip,port:443,path:"/ru/sports/soccer/games",
      method:"GET",servername:HOST,
      headers:{
        host:HOST,
        "user-agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
        accept:"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language":"ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        connection:"close"
      }
    },res=>{
      let body="";
      res.setEncoding("utf8");
      res.on("data",d=>body+=d);
      res.on("end",()=>resolve({status:res.statusCode||0,body}));
    });
    req.setTimeout(10000,()=>req.destroy(new Error("POLYMARKET_TIMEOUT")));
    req.on("error",reject);
    req.end();
  });
}

async function scan(){
  try{
    console.log("DNS: resolving via Cloudflare DoH");
    const ip=await dohResolve(HOST);
    console.log("DNS: polymarket.com ->",ip);
    const r=await fetchViaIp(ip);
    console.log("FETCH RESPONSE:",r.status);
    if(r.status<200||r.status>=400) throw new Error(`Polymarket HTTP ${r.status}`);
    console.log("FETCHED BYTES:",r.body.length);
    const live=extractLiveCards(r.body);
    status={...status,scans:status.scans+1,live:live.length,lastError:null};
    console.log(`SCAN: live=${live.length}`);
    for(const item of live){
      if(seen.has(item.href)) continue;
      const title=item.text.replace(/\bLIVE\b/ig,"").replace(/\s+/g," ").trim();
      await sendTelegram(`⚽ LIVE FOUND\n\n${title}\n\n${item.href}`);
      seen.add(item.href);
      console.log("TELEGRAM SENT:",item.href);
    }
  }catch(e){
    status.lastError=e?.stack||String(e);
    console.error("SCAN ERROR:",status.lastError);
  }
}

async function main(){
  console.log("MONITOR STARTING");
  console.log("SOURCE:",SOURCE);
  console.log("MODE: LOW-MEMORY HTTP + DOH");
  console.log("TELEGRAM:",TOKEN&&CHAT_ID?"CONFIGURED":"MISSING");
  while(true){
    await scan();
    await new Promise(r=>setTimeout(r,POLL_MS));
  }
}
process.on("SIGTERM",()=>{server.close();process.exit(0)});
process.on("SIGINT",()=>{server.close();process.exit(0)});
main();
