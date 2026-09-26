const http = require("node:http");
const LIVE_PAGE = "https://polymarket.com/ru/sports/live";
const POLL_MS = 5000;
const seen = new Map();
let lastSent = 0;

function text(s){return String(s||"").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#x27;/g,"'").replace(/\s+/g," ").trim();}
function parseCandidate(href,raw){
  const clean=text(raw);
  const tm=clean.match(/(.{2,120}?)\s+(?:vs\.?|v\.?|versus)\s+(.{2,120}?)(?=\s+(?:1H|2H|HT|ET|OT)\b|\s+\d{1,3}[′']|$)/i);
  if(!tm)return null;
  const home=tm[1].trim(),away=tm[2].trim();
  if(!home||!away)return null;
  const clock=clean.match(/\b(?:1H|2H|ET|OT)\s*(?:-|–|:)?\s*(\d{1,3})\s*(?:′|')?/i)
    ||clean.match(/\b(?:1H|2H|ET|OT)\b/i)
    ||clean.match(/\b(\d{1,3})\s*(?:′|')\b/i);
  if(!clock)return null;
  const minute=clock[1]!=null?Number(clock[1]):0;
  if(!Number.isFinite(minute)||minute<0||minute>130)return null;
  const pos=clean.indexOf(tm[0]);
  const tail=pos>=0?clean.slice(pos,Math.min(clean.length,pos+3500)):clean;
  let score=null;
  for(const re of [/\b(\d{1,2})\s*[-–:]\s*(\d{1,2})\b/,/\b(\d{1,2})\s*[–—]\s*(\d{1,2})\b/]){
    const m=tail.match(re);if(m){score=[Number(m[1]),Number(m[2])];break;}
  }
  if(!score)return null;
  return {href:href.startsWith("http")?href:"https://polymarket.com"+href,home,away,minute,score};
}
async function fetchLive(){
  const r=await fetch(LIVE_PAGE,{headers:{"user-agent":"Mozilla/5.0","accept":"text/html,application/xhtml+xml"},signal:AbortSignal.timeout(8000)});
  const html=await r.text();
  console.log(JSON.stringify({level:"INFO",event:"LIVE_PAGE_FETCH",status:r.status,bytes:html.length}));
  const anchors=[...html.matchAll(/<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]{0,16000}?)<\/a>/gi)];
  console.log(JSON.stringify({level:"INFO",event:"LIVE_PAGE_ANCHORS",count:anchors.length}));
  for(const a of anchors){const c=parseCandidate(a[1],a[2]);if(c)return c;}
  const body=text(html);
  const chunks=body.split(/(?=\b(?:1H|2H|HT)\b)/i);
  for(const chunk of chunks.slice(0,200)){const c=parseCandidate("/sports/live",chunk.slice(0,4000));if(c)return c;}
  return null;
}
async function telegram(c){
  const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chat){console.log(JSON.stringify({level:"ERROR",event:"TELEGRAM_CONFIG_MISSING",hasToken:!!token,hasChat:!!chat}));return false;}
  const now=Date.now(); if(now-lastSent<40000)return false;
  const key=c.href+"|"+c.score.join("-")+"|"+c.minute; if(seen.has(key))return false;
  const body=`⚽ LIVE FOUND\n\n${c.home} vs ${c.away}\nLIVE · ${c.minute}′\nSCORE: ${c.score[0]}–${c.score[1]}`;
  const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text:body,reply_markup:{inline_keyboard:[[{text:"ОТКРЫТЬ POLYMARKET",url:c.href}]]}}),signal:AbortSignal.timeout(8000)});
  const response=await r.text(); if(!r.ok)throw new Error("Telegram HTTP "+r.status+" "+response);
  seen.set(key,now);lastSent=now;console.log(JSON.stringify({level:"INFO",event:"TELEGRAM_SENT",...c}));return true;
}
async function cycle(){try{const c=await fetchLive();console.log(JSON.stringify({level:"INFO",event:"LIVE_DIRECT_SCAN",candidate:c}));if(c)await telegram(c);}catch(e){console.log(JSON.stringify({level:"ERROR",event:"DIRECT_SCAN_ERROR",message:e.stack||e.message||String(e)}));}}
const port=Number(process.env.PORT||3000);const server=http.createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify({ok:true,service:"polymarket-soccer-live-direct",time:new Date().toISOString()}));});server.listen(port,"0.0.0.0",()=>{console.log(JSON.stringify({level:"INFO",event:"DIRECT_MONITOR_STARTED",port}));cycle();setInterval(cycle,POLL_MS);});
