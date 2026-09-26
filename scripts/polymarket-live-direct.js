const http = require("node:http");
const LIVE_PAGE = "https://polymarket.com/ru/sports/live";
const POLL_MS = 5000;
const seen = new Map();
let lastSent = 0;

function text(s){return String(s||"").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#x27;/g,"'").replace(/\s+/g," ").trim();}
function norm(s){return text(s).toLowerCase().replace(/\b(fc|cf|sc|afc|ac|cd|club)\b/g," ").replace(/[^a-z0-9]+/g," ").trim();}
function num(s){const n=Number(s);return Number.isFinite(n)?n:null;}
function parseCandidate(href,raw){
  const clean=text(raw);
  const titleMatch=clean.match(/([^|]{2,120}?\s+(?:vs\.?|v\.?|versus)\s+[^|]{2,120})/i);
  if(!titleMatch)return null;
  const title=titleMatch[1].trim();
  const teams=title.split(/\s+(?:vs\.?|v\.?|versus)\s+/i);
  if(teams.length!==2)return null;
  const home=teams[0].trim(),away=teams[1].trim();
  const clock=(clean.match(/\b(?:1H|2H|HT|ET|OT)\s*(?:-|–|:)\s*(\d{1,3})\b/i)||clean.match(/\b(?:1H|2H|HT|ET|OT)\b/i));
  if(!clock)return null;
  let minute=clock[1]!=null?Number(clock[1]):null;
  if(!Number.isFinite(minute))minute=0;
  const pos=clean.indexOf(title);
  const tail=pos>=0?clean.slice(pos+title.length,pos+1800):clean;
  const around=tail.replace(/\$[\d,.]+[KMB]?/g," ");
  const scores=[];
  const re=/(?:^|\s)(\d{1,2})(?:\s|$)/g; let m;
  while((m=re.exec(around))&&scores.length<20){const n=num(m[1]);if(n!==null)scores.push(n);}
  let score=null;
  const teamPattern=new RegExp(norm(home).split(" ").map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("\\s+")+"(?:\\s+\\d+-\\d+-\\d+)?\\s+(\\d+)\\s+"+norm(away).split(" ").map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("\\s+")+"(?:\\s+\\d+-\\d+-\\d+)?\\s+(\\d+)","i");
  const sm=teamPattern.exec(norm(around));
  if(sm)score=[Number(sm[1]),Number(sm[2])];
  if(!score && scores.length>=2)score=[scores[0],scores[1]];
  if(!score)return null;
  return {href:"https://polymarket.com"+href,home,away,minute,score};
}
async function fetchLive(){
  const r=await fetch(LIVE_PAGE,{headers:{"user-agent":"Mozilla/5.0","accept":"text/html"},signal:AbortSignal.timeout(8000)});
  const html=await r.text();
  const anchors=[...html.matchAll(/<a[^>]+href=["'](\/sports\/[^"'#?]+)["'][^>]*>([\s\S]{0,5000}?)<\/a>/gi)];
  for(const a of anchors){
    const start=Math.max(0,a.index-200),end=Math.min(html.length,a.index+12000);
    const c=parseCandidate(a[1],html.slice(start,end));
    if(c)return c;
  }
  return null;
}
async function telegram(c){
  const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chat){console.log(JSON.stringify({level:"ERROR",event:"TELEGRAM_CONFIG_MISSING",hasToken:!!token,hasChat:!!chat}));return false;}
  const now=Date.now();
  if(now-lastSent<40000)return false;
  const key=c.href+"|"+c.score.join("-")+"|"+c.minute;
  if(seen.has(key))return false;
  const dt=new Date();dt.setMinutes(dt.getMinutes()+dt.getTimezoneOffset()+180);
  const hh=String(dt.getHours()).padStart(2,"0"),mm=String(dt.getMinutes()).padStart(2,"0"),ss=String(dt.getSeconds()).padStart(2,"0");
  const body=`⚽ LIVE FOUND\n\n${c.home} vs ${c.away}\nLIVE · ${c.minute}′\nSCORE: ${c.score[0]}–${c.score[1]}\n\n${hh}:${mm}:${ss}`;
  const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text:body,reply_markup:{inline_keyboard:[[{text:"ОТКРЫТЬ POLYMARKET",url:c.href}]]}}),signal:AbortSignal.timeout(8000)});
  if(!r.ok)throw new Error("Telegram HTTP "+r.status+" "+await r.text());
  seen.set(key,now);lastSent=now;console.log(JSON.stringify({level:"INFO",event:"TELEGRAM_SENT",...c}));return true;
}
async function cycle(){try{const c=await fetchLive();console.log(JSON.stringify({level:"INFO",event:"LIVE_DIRECT_SCAN",candidate:c}));if(c)await telegram(c);}catch(e){console.log(JSON.stringify({level:"ERROR",event:"DIRECT_SCAN_ERROR",message:e.message}));}}
const port=Number(process.env.PORT||3000);const server=http.createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify({ok:true,service:"polymarket-soccer-live-direct",time:new Date().toISOString()}));});server.listen(port,"0.0.0.0",()=>{console.log(JSON.stringify({level:"INFO",event:"DIRECT_MONITOR_STARTED",port}));cycle();setInterval(cycle,POLL_MS);});
