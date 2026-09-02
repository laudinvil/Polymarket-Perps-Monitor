import fs from 'node:fs';

const KEY=process.env.PINAX_API_KEY||process.env.PINAX_API_TOKEN;
const TG_TOKEN=process.env.TELEGRAM_BOT_TOKEN, TG_CHAT=process.env.TELEGRAM_CHAT_ID;
const ASSETS=['BTC','ETH','XRP','SOL','DOGE','HYPE','BNB'];
const URL='https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const STATE='src/spike-alerted-windows.json';
const RUN_ONCE=process.env.RUN_ONCE==='true';
const INTERVAL=300000;
const LIMIT=1000;
const MAX_PAGES=20;
let state={windows:{}};
try{state=JSON.parse(fs.readFileSync(STATE,'utf8'));}catch(e){if(e?.code!=='ENOENT')console.error('[SPIKE][STATE]',e?.message??e);}
function save(){fs.writeFileSync(STATE,JSON.stringify(state,null,2)+'\n');}
function num(...v){for(const x of v){const n=Number(x);if(Number.isFinite(n))return n;}return 0;}
function ts(x){const v=x?.time??x?.timestamp??x?.created_at??x?.createdAt??x?.block_time??x?.blockTime; if(v==null)return 0; if(typeof v==='number')return v<1e12?v*1000:v; const n=Date.parse(v);return Number.isFinite(n)?n:0;}
function user(x){return String(x?.user??x?.address??x?.wallet??x?.account??x?.liquidated_user??x?.liquidatedUser??'').toLowerCase();}
function usd(x){return `$${Number(x).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;}
async function page(coin,start,end,p){const u=new URL(URL);u.searchParams.set('coin',coin);u.searchParams.set('dex','perps');u.searchParams.set('sort_by','time');u.searchParams.set('start_time',new Date(start).toISOString());u.searchParams.set('end_time',new Date(end).toISOString());u.searchParams.set('limit',String(LIMIT));u.searchParams.set('page',String(p));const t=Date.now();const r=await fetch(u,{headers:{Authorization:`Bearer ${KEY}`,Accept:'application/json'}});const raw=await r.text();if(!r.ok)throw Error(`HTTP ${r.status}: ${raw.slice(0,300)}`);const b=JSON.parse(raw),rows=Array.isArray(b?.data)?b.data:[];console.log(`[SPIKE][PINAX] ${coin} window=${new Date(start).toISOString()}..${new Date(end).toISOString()} page=${p} rows=${rows.length} latency=${Date.now()-t}ms`);return rows;}
async function collect(coin,start,end){const out=[];for(let p=1;p<=MAX_PAGES;p++){const rows=await page(coin,start,end,p);out.push(...rows);if(rows.length<LIMIT)break;const times=rows.map(ts).filter(Boolean);if(times.length&&Math.min(...times)<=start)break;}return out.filter(x=>{const t=ts(x);return t>=start&&t<end;});}
function analyze(rows){const users=new Set(),bySide={Long:0,Short:0};let volume=0,largest=0;for(const x of rows){const u=user(x);if(u)users.add(u);const side=String(x?.side??x?.direction??x?.positionSide??'').toLowerCase();if(side.includes('long'))bySide.Long++;else if(side.includes('short'))bySide.Short++;volume+=Math.abs(num(x?.positionValue,x?.position_value,x?.notional,x?.sizeUsd,x?.usdValue,x?.value,x?.size));largest=Math.max(largest,Math.abs(num(x?.positionValue,x?.position_value,x?.notional,x?.sizeUsd,x?.usdValue,x?.value,x?.size)));}return{users:users.size,events:rows.length,volume,largest,long:bySide.Long,short:bySide.Short};}
function market(coin,min){const n=min*60000,s=Math.floor(Date.now()/n)*n+n;return `https://polymarket.com/event/${coin.toLowerCase()}-updown-${min}m-${Math.floor(s/1000)}`;}
async function send(text){const r=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,disable_web_page_preview:true})});if(!r.ok)throw Error(`Telegram HTTP ${r.status}: ${await r.text()}`);}
async function runWindow(min,end){const start=end-min*60000,key=`${min}:${end}`;if(state.windows[key]){console.log(`[SPIKE][SKIP] already alerted ${key}`);return;}const results=[];for(const coin of ASSETS){try{const a=analyze(await collect(coin,start,end));results.push({coin,...a});console.log(`[SPIKE][${min}M] ${coin} users=${a.users} events=${a.events} volume=${a.volume}`);}catch(e){console.error(`[SPIKE][ERROR] ${coin}`,e?.message??e);}}
results.sort((a,b)=>b.users-a.users||b.volume-a.volume);const winner=results.find(x=>x.users>0);if(!winner){console.log(`[SPIKE][${min}M] no liquidations in closed window`);state.windows[key]={checkedAt:new Date().toISOString(),sent:false};save();return;}
const emoji=winner.coin==='BTC'?'🟠':'🔥';const lines=[`${emoji} #${winner.coin} Liquidation Spike ${min}M: ${winner.users} unique users`, `Liquidations: ${winner.events}`, `Volume: ${usd(winner.volume)}`,'','▶️ NEXT POLYMARKET '+min+'M',market(winner.coin,min)];await send(lines.join('\n'));state.windows[key]={checkedAt:new Date().toISOString(),sent:true,coin:winner.coin,users:winner.users};save();console.log(`[SPIKE][ALERT] ${min}M winner=${winner.coin} users=${winner.users}`);}
async function cycle(){const now=Date.now(),end5=Math.floor(now/INTERVAL)*INTERVAL,end15=Math.floor(now/900000)*900000;await Promise.all([runWindow(5,end5),runWindow(15,end15)]);}
async function main(){if(!KEY||!TG_TOKEN||!TG_CHAT)throw Error('PINAX and Telegram configuration required');await cycle();if(RUN_ONCE)return;while(true){const now=Date.now(),next=Math.floor(now/INTERVAL)*INTERVAL+INTERVAL;await new Promise(r=>setTimeout(r,Math.max(1000,next-now)));await cycle();}}
main().catch(e=>{console.error('[SPIKE][FATAL]',e?.stack??e);process.exitCode=1;});
