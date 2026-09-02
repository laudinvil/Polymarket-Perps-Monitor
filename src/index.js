import { createServer } from 'node:http';
import { startBinanceLiquidationStream, stopBinanceLiquidationStream, getBinanceLiquidationStats } from './binance-liquidations.js';
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const PINAX_API_KEY = process.env.PINAX_API_KEY || process.env.PINAX_API_TOKEN;
const PINAX_URL = 'https://api.pinax.network/v1/hyperliquid/markets/liquidations';
const ASSETS = ['BTC','ETH','XRP','SOL','DOGE','HYPE','BNB'];
const WINDOW_5M = 5*60*1000;
const HTTP_PORT = Number(process.env.PORT || 3000);
const PAGE_LIMIT = 10;
const MAX_PAGES_PER_COIN = 30;
const PAGE_DELAY_MS = 350;
const COIN_DELAY_MS = 700;
const RUN_ONCE = process.env.RUN_ONCE === 'true';
const alertedPeriods = new Set();
let boundaryTimer=null, stopping=false, lastCheck=null, lastResult=null, lastProcessed5m=null;
function windowStart(ms,size){return Math.floor(ms/size)*size;}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
function parseTs(v){if(v==null)return NaN;const s=String(v).trim();if(!s)return NaN;if(/^\d+(\.\d+)?$/.test(s)){const n=Number(s);return n>1e12?n:n*1000;}const n=s.includes('T')?s:s.replace(' ','T');const z=/(?:Z|[+-]\d\d:\d\d)$/.test(n)?n:`${n}Z`;const p=Date.parse(z);return Number.isFinite(p)?p:NaN;}
function eventTs(e){return parseTs(e?.timestamp??e?.time??e?.created_at);}
async function fetchCoinLiquidations(coin,startMs,endMs){
 if(!PINAX_API_KEY)throw new Error('PINAX_API_KEY/PINAX_API_TOKEN is not configured');
 const all=[];let pages=0;
 for(let page=1;page<=MAX_PAGES_PER_COIN;page++){
  const u=new URL(PINAX_URL);u.searchParams.set('coin',coin);u.searchParams.set('dex','perps');u.searchParams.set('sort_by','time');u.searchParams.set('limit',String(PAGE_LIMIT));u.searchParams.set('page',String(page));
  if(page>1)await sleep(PAGE_DELAY_MS);
  const r=await fetch(u,{headers:{Authorization:`Bearer ${PINAX_API_KEY}`,Accept:'application/json'}});const raw=await r.text();
  if(r.status===429){console.error(`[Pinax][RATE_LIMIT] ${coin} page=${page}; stopping this coin`);break;}
  if(!r.ok)throw new Error(`${coin}: Pinax HTTP ${r.status}: ${raw.slice(0,500)}`);
  let body;try{body=JSON.parse(raw);}catch{throw new Error(`${coin}: Pinax returned non-JSON response`);}
  const rows=Array.isArray(body?.data)?body.data:[];pages=page;if(!rows.length)break;all.push(...rows);
  const ts=rows.map(eventTs).filter(Number.isFinite);if(ts.length&&Math.min(...ts)<startMs)break;if(rows.length<PAGE_LIMIT)break;
 }
 const filtered=all.filter(e=>{const t=eventTs(e);return Number.isFinite(t)&&t>=startMs&&t<endMs;});
 console.log(`[Pinax][LOCAL_FILTER] ${coin} pages=${pages} fetched=${all.length} matched=${filtered.length}`);return filtered;
}
function getUser(e){for(const v of [e?.liquidated_user,e?.liquidatedUser,e?.user,e?.account,e?.wallet,e?.address])if(v!=null&&String(v).trim())return String(v).trim().toLowerCase();return '';}
async function fetchSpike(startMs,endMs){
 const bn=getBinanceLiquidationStats(startMs,endMs),out=[];
 for(const coin of ASSETS){try{const events=await fetchCoinLiquidations(coin,startMs,endMs);const users=new Set();let longs=0,shorts=0,volume=0;const dirs=new Set();for(const e of events){const user=getUser(e);if(!user)continue;users.add(user);const n=Number(e?.notional||0);if(Number.isFinite(n))volume+=n;const d=String(e?.direction||e?.liquidation_kind||'').toUpperCase(),k=`${user}:${d}`;if(!dirs.has(k)){dirs.add(k);if(d.includes('LONG'))longs++;if(d.includes('SHORT'))shorts++;}}const b=bn[coin]||{events:0,longVolume:0,shortVolume:0,totalVolume:0};out.push({coin,users:users.size,longUsers:longs,shortUsers:shorts,totalNotional:volume,events:events.length,binanceEvents:b.events,binanceLongVolume:b.longVolume,binanceShortVolume:b.shortVolume,binanceTotalVolume:b.totalVolume});}catch(e){console.error(`[Pinax][ERROR] ${coin}:`,e?.message??e);const b=bn[coin]||{events:0,longVolume:0,shortVolume:0,totalVolume:0};out.push({coin,users:0,longUsers:0,shortUsers:0,totalNotional:0,events:0,binanceEvents:b.events,binanceLongVolume:b.longVolume,binanceShortVolume:b.shortVolume,binanceTotalVolume:b.totalVolume,error:e?.message??String(e)});}if(!stopping)await sleep(COIN_DELAY_MS);}
 console.log(`[SPIKE][STATS] ${JSON.stringify(out)}`);return out;
}
async function sendTelegram(text){if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)throw new Error('Telegram is not configured');const r=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:false})});const raw=await r.text();if(!r.ok)throw new Error(`Telegram HTTP ${r.status}: ${raw}`);}
function marketUrl(coin,start){return `https://polymarket.com/event/${coin.toLowerCase()}-updown-5m-${Math.floor(start/1000)}`;}
async function sendSpikeAlert(start,stats){
 const candidates=stats.filter(x=>x.users>0||x.binanceTotalVolume>0).sort((a,b)=>b.users-a.users||(b.totalNotional+b.binanceTotalVolume)-(a.totalNotional+a.binanceTotalVolume));
 if(!candidates.length)return null;const w=candidates[0];const lines=[`🚨 LIQUIDATION SPIKE`,'',`${w.coin} — 5M`];if(w.longUsers>0)lines.push(`LONG users: ${w.longUsers}`);if(w.shortUsers>0)lines.push(`SHORT users: ${w.shortUsers}`);lines.push(`Liquidation volume: ${Math.round(w.totalNotional).toLocaleString('en-US')} USDT`);if(w.binanceTotalVolume>0)lines.push(`Binance liquidation volume: ${Math.round(w.binanceTotalVolume).toLocaleString('en-US')} USDT`);lines.push('','▶️ NEXT POLYMARKET 5M',marketUrl(w.coin,start+WINDOW_5M));const text=lines.join('\n');await sendTelegram(text);console.log(`[ALERT][SPIKE][SENT] ${w.coin} 5M`);return w;}
async function process5m(start){if(lastProcessed5m===start)return;const end=start+WINDOW_5M;const stats=await fetchSpike(start,end);if(!alertedPeriods.has(start)){const alert=await sendSpikeAlert(start,stats);if(alert)alertedPeriods.add(start);}lastProcessed5m=start;return{periodStart:start,periodEnd:end,stats};}
async function processDue(){const start=windowStart(Date.now(),WINDOW_5M)-WINDOW_5M;const five=await process5m(start);lastCheck=new Date().toISOString();lastResult={five};console.log('[RESULT]',JSON.stringify(lastResult));}
function schedule(){if(stopping)return;clearTimeout(boundaryTimer);const now=Date.now(),next=windowStart(now,WINDOW_5M)+WINDOW_5M;boundaryTimer=setTimeout(async()=>{if(stopping)return;try{await processDue();}catch(e){console.error('[Liquidations]',e?.message??e);}schedule();},Math.max(0,next-now));}
async function start(){console.log('=== LIQUIDATION SPIKE MONITOR ===');console.log('SOURCES: HYPERLIQUID/PINAX + BINANCE FUTURES');console.log('PERIOD: 5M ONLY');console.log('TELEGRAM: SPIKE ALERTS ENABLED');console.log(`PINAX: limit=${PAGE_LIMIT}, rate-limit-safe pagination`);startBinanceLiquidationStream();await processDue();if(RUN_ONCE){stopping=true;stopBinanceLiquidationStream();server.close(()=>console.log('[RUN_ONCE] done'));return;}schedule();}
function shutdown(s){stopping=true;clearTimeout(boundaryTimer);stopBinanceLiquidationStream();try{server.close();}catch{}console.log(`Shutdown: ${s}`);}process.on('SIGINT',()=>shutdown('SIGINT'));process.on('SIGTERM',()=>shutdown('SIGTERM'));
const server=createServer((req,res)=>{const u=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);res.setHeader('content-type','application/json; charset=utf-8');if(u.pathname==='/health'||u.pathname==='/liquidations'){res.writeHead(200);res.end(JSON.stringify({ok:true,lastCheck,lastResult}));return;}res.writeHead(404);res.end(JSON.stringify({ok:false,error:'Not found'}));});server.listen(HTTP_PORT,()=>console.log(`HTTP diagnostics server listening on :${HTTP_PORT}`));start().catch(e=>{console.error('[FATAL]',e?.stack??e);process.exitCode=1;});
