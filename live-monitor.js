const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');

const VERSION = '3.0.0';
const PORT = Number(process.env.PORT || 8080);
const POLL_MS = 10_000;
const STATE_FILE = process.env.STATE_FILE || '/data/chainlink-imbalance-state.json';
const LOG_FILE = process.env.LOG_FILE || '/data/chainlink-imbalance.jsonl';
const RTDS_URL = process.env.RTDS_URL || 'wss://ws-live-data.polymarket.com';
const GAMMA = 'https://gamma-api.polymarket.com';
const TG = 'https://api.telegram.org/bot';
const ASSETS = [
  ['BTC','btc-updown-5m','btc/usd'],['ETH','eth-updown-5m','eth/usd'],['SOL','sol-updown-5m','sol/usd'],
  ['BNB','bnb-updown-5m','bnb/usd'],['XRP','xrp-updown-5m','xrp/usd'],['DOGE','doge-updown-5m','doge/usd'],['HYPE','hype-updown-5m','hype/usd']
];
const twap = new Map();
const markets = new Map();
let ws;
let busy = false;
let lastGamma = 0;

function ensure(file){fs.mkdirSync(path.dirname(file),{recursive:true});}
function log(event,data={}){const x={ts:new Date().toISOString(),version:VERSION,event,...data};console.log(JSON.stringify(x));try{ensure(LOG_FILE);fs.appendFileSync(LOG_FILE,JSON.stringify(x)+'\n')}catch{}}
function load(){try{return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))}catch{return {version:VERSION,counts:Object.fromEntries(ASSETS.map(a=>[a[0],0])),periods:{},leader:null}}}
function save(s){ensure(STATE_FILE);fs.writeFileSync(STATE_FILE+'.tmp',JSON.stringify(s,null,2));fs.renameSync(STATE_FILE+'.tmp',STATE_FILE)}
let state=load();
for(const [a] of ASSETS) if(!Number.isFinite(Number(state.counts?.[a]))) {state.counts=state.counts||{};state.counts[a]=0}
state.version=VERSION; state.periods=state.periods||{};

async function json(url,opts={}){const wait=Math.max(0,250-(Date.now()-lastGamma));if(url.startsWith(GAMMA)&&wait)await new Promise(r=>setTimeout(r,wait));if(url.startsWith(GAMMA))lastGamma=Date.now();const c=new AbortController();const t=setTimeout(()=>c.abort(),7000);try{const r=await fetch(url,{...opts,signal:c.signal,headers:{accept:'application/json',...(opts.headers||{})}});if(!r.ok)throw new Error('HTTP '+r.status);return r.json()}finally{clearTimeout(t)}}

function connect(){
  try{
    ws=new WebSocket(RTDS_URL);
    ws.on('open',()=>{const filters=JSON.stringify({symbol:ASSETS.map(a=>a[2]).join(',')});ws.send(JSON.stringify({action:'subscribe',subscriptions:[{topic:'crypto_prices_twap_sixty',type:'update',filters}]}));log('RTDS_TWAP60_CONNECTED',{assets:ASSETS.map(a=>a[0])})});
    ws.on('message',raw=>{try{const m=JSON.parse(String(raw));if(m.message){log('RTDS_MESSAGE',{message:m.message});return}const p=m.payload;if(!p||p.window_s!==60||!p.symbol)return;const a=ASSETS.find(x=>x[2].toLowerCase()===String(p.symbol).toLowerCase());if(!a)return;const ts=Number(p.timestamp);const value=String(p.full_accuracy_value??p.value??'');if(!Number.isFinite(ts)||!value)return;twap.set(a[0],{ts,value,receivedAt:Date.now()});log('TWAP60_UPDATE',{asset:a[0],ts,value})}catch{}});
    ws.on('close',()=>{log('RTDS_TWAP60_CLOSED');setTimeout(connect,3000)});
    ws.on('error',e=>log('RTDS_TWAP60_ERROR',{error:String(e.message||e)}));
  }catch(e){log('RTDS_CONNECT_ERROR',{error:String(e.message||e)});setTimeout(connect,3000)}
}

function winner(m){const out=Array.isArray(m.outcomes)?m.outcomes:JSON.parse(m.outcomes||'[]');const prices=Array.isArray(m.outcomePrices)?m.outcomePrices:JSON.parse(m.outcomePrices||'[]');for(let i=0;i<out.length;i++)if((String(out[i]).toLowerCase()==='up'||String(out[i]).toLowerCase()==='down')&&Number(prices[i])>=.999)return String(out[i])[0].toUpperCase()+String(out[i]).slice(1).toLowerCase();return null}
function target(m){if(!m)return false;const raw=typeof m.raw==='string'?(()=>{try{return JSON.parse(m.raw)}catch{return{}}})():m.raw||{};const cfg=raw.cryptoMarketConfig||{};const d=String(m.description||'').toLowerCase();const r=String(m.resolutionSource||'').toLowerCase();return Number(cfg.twapLookbackSeconds)===60||d.includes('60-second twap')||r.includes('twap-60s')}
async function market(slug){if(markets.has(slug))return markets.get(slug);let m=null;try{const x=await json(GAMMA+'/markets?slug='+encodeURIComponent(slug));m=Array.isArray(x)?x[0]:null}catch(e){log('MARKET_ERROR',{slug,error:String(e.message||e)})}if(!m)try{const x=await json(GAMMA+'/events?slug='+encodeURIComponent(slug));const e=Array.isArray(x)?x[0]:null;m=e?.markets?.find(z=>z.slug===slug)||e?.markets?.[0]||null;if(m)log('MARKET_EVENT_FALLBACK',{slug})}catch(e){log('EVENT_ERROR',{slug,error:String(e.message||e)})}if(m)markets.set(slug,m);return m}
function boundary(asset,ms){const x=twap.get(asset);if(!x)return null;const targetSec=Math.floor(ms/1000);const obs=Math.floor(x.ts/1000);return obs>=targetSec&&obs<=targetSec+5?x:null}
function ge(a,b){try{return BigInt(a)>=BigInt(b)}catch{return Number(a)>=Number(b)}}
async function telegram(text){const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;if(!token||!chat)throw new Error('Telegram credentials missing');const r=await fetch(TG+token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chat,text,disable_web_page_preview:false})});if(!r.ok)throw new Error('Telegram HTTP '+r.status)}
function rank(){return ASSETS.map(a=>({asset:a[0],score:Number(state.counts[a[0]]||0)})).sort((a,b)=>Math.abs(b.score)-Math.abs(a.score)||a.asset.localeCompare(b.asset))}
async function cycle(){if(busy)return;busy=true;try{const now=Date.now(),close=Math.floor(now/300000)*300000,open=close-300000,key='period-'+Math.floor(open/1000);if(state.periods[key])return;const results={};for(const a of ASSETS){const slug=a[1]+'-'+Math.floor(open/1000);const m=await market(slug);if(!m){log('PERIOD_WAIT',{period:key,asset:a[0],reason:'market_not_found',slug});continue}if(!target(m)){log('PERIOD_REJECTED',{period:key,asset:a[0],reason:'not_twap60',slug});continue}const o=boundary(a[0],Date.parse(m.startDate||'')),c=boundary(a[0],Date.parse(m.endDate||''));if(!o||!c){log('PERIOD_WAIT',{period:key,asset:a[0],reason:'twap60_boundary_unavailable',open:o?.ts||null,close:c?.ts||null});continue}const w=ge(c.value,o.value)?'Up':'Down';const mw=winner(m);if(mw&&mw!==w){log('PERIOD_MISMATCH',{period:key,asset:a[0],expected:w,marketWinner:mw});continue}results[a[0]]={winner:w,open:o.value,close:c.value,marketWinner:mw||null}}
if(Object.keys(results).length!==ASSETS.length){log('PERIOD_INCOMPLETE',{period:key,processed:Object.keys(results).length,required:ASSETS.length});return}for(const a of ASSETS)state.counts[a[0]]+=results[a[0]].winner==='Up'?1:-1;const top=rank()[0];state.periods[key]=results;state.leader=top;save(state);const next=open+600000;const nextSlug=top.asset.toLowerCase()+'-updown-5m-'+Math.floor(next/1000);const text=['5M CHAINLINK TWAP 60s','',...ASSETS.map(a=>a[0]+' → '+results[a[0]].winner),'',...rank().map(x=>x.asset+': '+(x.score>=0?'+':'')+x.score),'','IMBALANCE: '+top.asset+' '+(top.score>=0?'+':'')+top.score,'https://polymarket.com/event/'+nextSlug].join('\n');try{await telegram(text);log('ALERT_SENT',{period:key,results,leader:top})}catch(e){delete state.periods[key];for(const a of ASSETS)state.counts[a[0]]-=results[a[0]].winner==='Up'?1:-1;save(state);log('TELEGRAM_ERROR',{period:key,error:String(e.message||e)})}}
finally{busy=false}}

const server=http.createServer((req,res)=>{if(req.url==='/health'||req.url==='/status'){res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({status:'ok',version:VERSION,pollingMs:POLL_MS,twap60:twap.size,counts:state.counts,leader:state.leader}))}res.writeHead(404);res.end()});server.listen(PORT,'0.0.0.0',()=>log('HEALTH_LISTENING',{port:PORT}));
log('MONITOR_STARTING',{version:VERSION,pollingMs:POLL_MS,assets:ASSETS.map(a=>a[0]),source:'Polymarket RTDS crypto_prices_twap_sixty',chainlinkResolution:'60s'});
connect();cycle();setInterval(cycle,POLL_MS);setInterval(()=>log('HEARTBEAT',{twap60:twap.size,counts:state.counts,leader:state.leader}),30000);
