import fs from 'node:fs';

const KEY=process.env.PINAX_API_KEY||process.env.PINAX_API_TOKEN;
const TG_TOKEN=process.env.TELEGRAM_BOT_TOKEN, TG_CHAT=process.env.TELEGRAM_CHAT_ID;
const ASSETS=['BTC','ETH','XRP','SOL','DOGE','HYPE','BNB'];
const PINAX_URL='https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const STATE='src/spike-alerted-windows.json';
const RUN_ONCE=process.env.RUN_ONCE==='true';
const WINDOW_5M=5*60*1000, WINDOW_15M=15*60*1000;
const LIMIT=1000;
const MAX_PAGES_PER_COIN=12;
const PAGE_DELAY_MS=250;
const COIN_DELAY_MS=500;
let stopping=false;
let state={windows:{}};
try{state=JSON.parse(fs.readFileSync(STATE,'utf8'));}catch(e){if(e?.code!=='ENOENT')console.error('[SPIKE][STATE]',e?.message??e);}
function save(){fs.writeFileSync(STATE,JSON.stringify(state,null,2)+'\n');}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function num(...v){for(const x of v){const n=Number(x);if(Number.isFinite(n))return n;}return 0;}
function ts(x){const v=x?.time??x?.timestamp??x?.created_at??x?.createdAt??x?.block_time??x?.blockTime;if(v==null)return 0;if(typeof v==='number')return v<1e12?v*1000:v;const n=Date.parse(v);return Number.isFinite(n)?n:0;}
function user(x){return String(x?.liquidated_user??x?.liquidatedUser??x?.user??x?.address??x?.wallet??x?.account??'').toLowerCase();}
function usd(x){return `${Number(x).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})} USDT`;}
async function page(coin,start,end,p){const u=new globalThis.URL(PINAX_URL);u.searchParams.set('coin',coin);u.searchParams.set('dex','perps');u.searchParams.set('sort_by','time');u.searchParams.set('start_time',new Date(start).toISOString());u.searchParams.set('end_time',new Date(end).toISOString());u.searchParams.set('limit',String(LIMIT));u.searchParams.set('page',String(p));if(p>1)await sleep(PAGE_DELAY_MS);const t=Date.now();const r=await fetch(u,{headers:{Authorization:`Bearer ${KEY}`,Accept:'application/json'}});const raw=await r.text();if(!r.ok)throw Error(`HTTP ${r.status}: ${raw.slice(0,300)}`);let b;try{b=JSON.parse(raw);}catch{throw Error('Pinax returned non-JSON response');}const rows=Array.isArray(b?.data)?b.data:[];console.log(`[SPIKE][PINAX] ${coin} page=${p}/${MAX_PAGES_PER_COIN} rows=${rows.length} latency=${Date.now()-t}ms`);return rows;}
async function collect(coin,start,end){const out=[];let pages=0;for(let p=1;p<=MAX_PAGES_PER_COIN;p++){const rows=await page(coin,start,end,p);pages=p;out.push(...rows);if(rows.length<LIMIT)break;const times=rows.map(ts).filter(Boolean);if(times.length&&Math.min(...times)<=start)break;}const filtered=out.filter(x=>{const t=ts(x);return t>=start&&t<end;});console.log(`[SPIKE][FILTER] ${coin} pages=${pages} fetched=${out.length} matched=${filtered.length}`);return filtered;}
function analyze(rows){const users=new Set(),longUsers=new Set(),shortUsers=new Set();let volume=0;for(const x of rows){const u=user(x);if(u)users.add(u);const side=String(x?.direction??x?.side??x?.liquidation_kind??x?.positionSide??'').toUpperCase();if(u&&side.includes('LONG'))longUsers.add(u);else if(u&&side.includes('SHORT'))shortUsers.add(u);volume+=Math.abs(num(x?.notional,x?.positionValue,x?.position_value,x?.sizeUsd,x?.usdValue,x?.value,x?.size));}return{users:users.size,events:rows.length,volume,long:longUsers.size,short:shortUsers.size};}
function market(coin,min,start){return `https://polymarket.com/event/${coin.toLowerCase()}-updown-${min}m-${Math.floor((start+min*60000)/1000)}`;}
async function send(text){const r=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,disable_web_page_preview:true})});if(!r.ok)throw Error(`Telegram HTTP ${r.status}: ${await r.text()}`);}
async function runWindow(min,end){const start=end-min*60000,key=`${min}:${end}`;if(state.windows[key]){console.log(`[SPIKE][SKIP] already checked ${key}`);return;}console.log(`[SPIKE][WINDOW] ${min}M ${new Date(start).toISOString()}..${new Date(end).toISOString()}`);const results=[];for(const coin of ASSETS){try{const a=analyze(await collect(coin,start,end));results.push({coin,...a});console.log(`[SPIKE][${min}M] ${coin} users=${a.users} long=${a.long} short=${a.short} events=${a.events} volume=${a.volume}`);}catch(e){console.error(`[SPIKE][ERROR] ${coin}`,e?.message??e);results.push({coin,users:0,long:0,short:0,events:0,volume:0,error:e?.message??String(e)});}if(!stopping)await sleep(COIN_DELAY_MS);}
results.sort((a,b)=>b.users-a.users||b.volume-a.volume);const winner=results.find(x=>x.users>0);if(!winner){console.log(`[SPIKE][${min}M] no liquidations in closed window`);state.windows[key]={checkedAt:new Date().toISOString(),sent:false};save();return;}const lines=['🚨 LIQUIDATION SPIKE','',`${winner.coin} — ${min}M`,`Liquidated users: ${winner.users}`];if(winner.long>0)lines.push(`LONG users: ${winner.long}`);if(winner.short>0)lines.push(`SHORT users: ${winner.short}`);lines.push(`Liquidation volume: ${usd(winner.volume)}`,'','▶️ POLYMARKET',market(winner.coin,min,start));await send(lines.join('\n'));state.windows[key]={checkedAt:new Date().toISOString(),sent:true,coin:winner.coin,users:winner.users,long:winner.long,short:winner.short,volume:winner.volume};save();console.log(`[SPIKE][ALERT] ${min}M winner=${winner.coin} users=${winner.users}`);}
async function cycle(){const now=Date.now();const end5=Math.floor(now/WINDOW_5M)*WINDOW_5M;const end15=Math.floor(now/WINDOW_15M)*WINDOW_15M;await runWindow(5,end5);await runWindow(15,end15);}
async function main(){if(!KEY||!TG_TOKEN||!TG_CHAT)throw Error('PINAX and Telegram configuration required');console.log('=== LIQUIDATION SPIKE MONITOR ===');console.log('SOURCE: PINAX HYPERLIQUID ONLY');console.log('PERIODS: 5M + 15M');console.log(`PAGINATION: max=${MAX_PAGES_PER_COIN} pages/coin, pageDelay=${PAGE_DELAY_MS}ms, coinDelay=${COIN_DELAY_MS}ms`);await cycle();if(RUN_ONCE){console.log('[RUN_ONCE] SPIKE cycle complete; exiting.');return;}while(!stopping){const now=Date.now(),next=Math.floor(now/WINDOW_5M)*WINDOW_5M+WINDOW_5M;await sleep(Math.max(1000,next-now));if(!stopping)await cycle();}}
process.on('SIGINT',()=>stopping=true);process.on('SIGTERM',()=>stopping=true);main().catch(e=>{console.error('[SPIKE][FATAL]',e?.stack??e);process.exitCode=1;});
