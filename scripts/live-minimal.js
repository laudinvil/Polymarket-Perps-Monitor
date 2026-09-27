const http=require("node:http");
const GAMMA="https://gamma-api.polymarket.com";
const POLL_MS=5000;
const COOLDOWN=40000;
const seen=new Set();
let last=0;
const text=x=>typeof x==="string"?x.trim():"";
async function json(url){const r=await fetch(url,{headers:{accept:"application/json","user-agent":"Mozilla/5.0"},signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error("HTTP "+r.status);return r.json();}
function events(x){return Array.isArray(x)?x:(x?.events||x?.data||[]);}
function teams(e){const s=text(e?.title||e?.question);const m=s.match(/^(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+)$/i);return m?[m[1].trim(),m[2].trim()]:[text(e?.homeTeam?.name||e?.homeTeam),text(e?.awayTeam?.name||e?.awayTeam)];}
function soccer(e){const s=JSON.stringify(e).toLowerCase();if(/tennis|basketball|baseball|hockey|nfl|nhl|mlb|ufc|mma|cricket|esports|valorant|dota|cs2/.test(s))return false;return /soccer|football|premier|laliga|la liga|serie a|bundesliga|ligue|mls|eredivisie|uefa|fifa|liga mx|brasileirao|j1 league|j2 league|a league|superliga|premiership|scottish|belgian|danish|polish|czech|romanian|austrian|swiss|norwegian|swedish|argentina|colombia|chile|peru|ecuador|uruguay|paraguay|costa rica|honduras|guatemala|jamaica|el salvador/.test(s);}
function start(e){for(const k of ["gameStartTime","startDate","startTime"]){const n=Date.parse(e?.[k]||"");if(Number.isFinite(n))return n;}return NaN;}
function score(e){for(const x of [e?.score,e?.scores,e?.scoreboard,e?.result]){if(Array.isArray(x)&&x.length>=2)return[x[0],x[1]];if(x&&typeof x==="object"){const h=x.home??x.homeScore,a=x.away??x.awayScore;if(h!=null&&a!=null)return[h,a];}const m=text(x).match(/(\d+)\s*[-–:]\s*(\d+)/);if(m)return[m[1],m[2]];}return null;}
function minute(e,st){for(const k of ["minute","matchMinute","elapsed","clock"]){if(e?.[k]!=null)return String(e[k]).replace(/[^0-9]/g,"");}return Number.isFinite(st)?String(Math.max(1,Math.floor((Date.now()-st)/60000))):"—";}
async function find(){let all=[];for(const o of [0,500,1000]){try{all.push(...events(await json(`${GAMMA}/events?active=true&closed=false&limit=500&offset=${o}`)));}catch{}}const now=Date.now();return all.filter(e=>{if(!e||e.active===false||e.closed===true||!soccer(e))return false;const [h,a]=teams(e);if(!h||!a)return false;const st=start(e);if(!Number.isFinite(st))return false;const age=now-st;return age>=-10*60000&&age<=4*3600000;}).sort((a,b)=>start(a)-start(b))[0]||null;}
async function send(e){const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;if(!token||!chat)return;if(Date.now()-last<COOLDOWN)return;const id=String(e.id||e.slug||e.title);if(seen.has(id))return;const [h,a]=teams(e),st=start(e),sc=score(e);const msg=["⚽ LIVE FOUND","",`${h} vs ${a}`,"STATUS: LIVE",`START: ${new Date(st).toISOString()}`,`MINUTE: ${minute(e,st)}'`,sc?`SCORE: ${sc[0]}–${sc[1]}`:"SCORE: —",e.slug?`\nhttps://polymarket.com/event/${e.slug}`:""] .join("\n");const r=await fetch(`https://api.telegram.org/bot${token}/sendMessage`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text:msg}),signal:AbortSignal.timeout(8000)});if(!r.ok)throw Error("Telegram HTTP "+r.status);seen.add(id);last=Date.now();}
async function cycle(){try{const e=await find();if(e)await send(e);}catch{}}
const port=Number(process.env.PORT||3000);http.createServer((q,s)=>{s.writeHead(200,{"content-type":"application/json"});s.end(JSON.stringify({ok:true,service:"polymarket-soccer-live-monitor",time:new Date().toISOString()}));}).listen(port,"0.0.0.0",()=>{cycle();setInterval(cycle,POLL_MS);});
