const http=require("node:http");
const GAMMA="https://gamma-api.polymarket.com";
const POLL_MS=3000;
let sent=new Set();
let lastSent=0;

async function getJson(url){
  const r=await fetch(url,{headers:{"accept":"application/json","user-agent":"Mozilla/5.0"},signal:AbortSignal.timeout(6000)});
  if(!r.ok) throw new Error("HTTP "+r.status);
  return await r.json();
}
function list(x){return Array.isArray(x)?x:(x?.data||x?.events||x?.markets||[]);}
function pick(items){
  for(const x of items){
    const title=String(x?.title||x?.question||x?.name||"").trim();
    const slug=String(x?.slug||"").trim();
    const active=x?.active!==false && x?.closed!==true;
    if(!active||!title||!slug) continue;
    const low=(title+" "+slug).toLowerCase();
    if(/soccer|football|fc\b| vs | v |win|draw|match|game/.test(low)) return {title,slug};
  }
  return null;
}
async function findEvent(){
  const urls=[
    GAMMA+"/events?active=true&closed=false&order=volume_24hr&ascending=false&limit=100",
    GAMMA+"/events?active=true&closed=false&order=volume&ascending=false&limit=100",
    GAMMA+"/markets?active=true&closed=false&order=volume&ascending=false&limit=100"
  ];
  for(const u of urls){
    try{const p=pick(list(await getJson(u)));if(p)return p;}catch{}
  }
  return null;
}
async function send(e){
  const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chat)return;
  if(Date.now()-lastSent<10000)return;
  if(sent.has(e.slug))return;
  const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
    chat_id:chat,
    text:"⚽ "+e.title+"\n\nhttps://polymarket.com/event/"+e.slug
  }),signal:AbortSignal.timeout(6000)});
  if(r.ok){sent.add(e.slug);lastSent=Date.now();}
}
async function cycle(){try{const e=await findEvent();if(e)await send(e);}catch{}}
const port=Number(process.env.PORT||3000);
http.createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end('{"ok":true}');}).listen(port,"0.0.0.0",()=>{cycle();setInterval(cycle,POLL_MS);});
