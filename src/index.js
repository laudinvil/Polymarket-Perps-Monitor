import { createPublicClient } from '@polymarket/client';
import { findPredictionMarket, predictionDirectionPrice } from './prediction.js';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALERTS_ENABLED = process.env.ALERTS_ENABLED !== 'false';
const REQUIRE_PREDICTION_MARKET = process.env.REQUIRE_PREDICTION_MARKET !== 'false';
const SIGNAL_COOLDOWN_MS = Number(process.env.SIGNAL_COOLDOWN_MS ?? 300000);
const PRICE_MOVE_5M = Number(process.env.PRICE_MOVE_5M ?? 0.002);
const OI_MOVE_5M = Number(process.env.OI_MOVE_5M ?? 0.015);
const FUNDING_LONG = Number(process.env.FUNDING_LONG ?? 0.0001);
const FUNDING_SHORT = Number(process.env.FUNDING_SHORT ?? -0.0001);
const MIN_VOLUME_MULTIPLIER = Number(process.env.MIN_VOLUME_MULTIPLIER ?? 1.5);
const VOLUME_BUCKET_MS = 5 * 60 * 1000;
const HISTORY_BUCKETS = Number(process.env.HISTORY_BUCKETS ?? 12);
const MIN_BASELINE_BUCKETS = Number(process.env.MIN_BASELINE_BUCKETS ?? 1);
const SIGNAL_SCORE = Number(process.env.SIGNAL_SCORE ?? 2);

const client = createPublicClient();
const instruments = new Map();
const histories = new Map();
const cooldowns = new Map();
const subscribed = new Set();

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const firstNum = (...values) => { for (const value of values) { const n = num(value); if (n !== null) return n; } return null; };
const text = (v) => v == null ? '' : String(v);
const pct = (v) => `${(v * 100).toFixed(2)}%`;
const price = (v) => v == null ? 'n/a' : `${(v * 100).toFixed(1)}¢`;

function normalizeTimestamp(value) { const n = num(value); if (n === null) return Date.now(); return n < 1e12 ? n * 1000 : n; }
function instrumentIdOf(event) { const p = event?.payload ?? event?.data ?? event; return firstNum(event?.instrumentId, event?.instrument_id, p?.instrumentId, p?.instrument_id); }
function instrumentNameOf(event, id) { const p = event?.payload ?? event?.data ?? event; return text(p?.symbol ?? p?.ticker ?? p?.instrument ?? p?.instrumentName ?? p?.instrument_name ?? p?.market ?? id); }
function tickerValues(event) {
  const p = event?.payload ?? event?.data ?? event;
  return {
    symbol: text(p?.symbol ?? p?.ticker ?? p?.instrument ?? p?.market ?? ''),
    price: firstNum(p?.markPrice,p?.mark_price,p?.midPrice,p?.mid_price,p?.lastPrice,p?.last_price,p?.price,p?.mark,p?.last),
    openInterest: firstNum(p?.openInterest,p?.open_interest,p?.oi),
    funding: firstNum(p?.fundingRate,p?.funding_rate,p?.funding,p?.currentFundingRate,p?.current_funding_rate),
    timestamp: normalizeTimestamp(firstNum(p?.timestamp,p?.ts,p?.time,Date.now()))
  };
}
function tradeValues(event) {
  const p=event?.payload ?? event?.data ?? event;
  const tradePrice=firstNum(p?.price,p?.tradePrice,p?.trade_price);
  const size=firstNum(p?.size,p?.quantity,p?.qty,p?.baseQuantity,p?.base_quantity);
  return { tradePrice,size,notional:tradePrice!==null&&size!==null?Math.abs(tradePrice*size):0 };
}
function stateFor(id,name='') { if(!histories.has(id)) histories.set(id,{name,points:[],buckets:new Map()}); const s=histories.get(id); if(name)s.name=name; return s; }
function recordTrade(id,event) { const trade=tradeValues(event); if(!trade.notional)return; const s=stateFor(id,instrumentNameOf(event,id)); const bucket=Math.floor(Date.now()/VOLUME_BUCKET_MS)*VOLUME_BUCKET_MS; s.buckets.set(bucket,(s.buckets.get(bucket)??0)+trade.notional); const cutoff=bucket-HISTORY_BUCKETS*VOLUME_BUCKET_MS; for(const key of s.buckets.keys())if(key<cutoff)s.buckets.delete(key); }
function addTickerPoint(id,event) { const t=tickerValues(event); if(t.price===null)return; const s=stateFor(id,t.symbol||instrumentNameOf(event,id)); s.points.push({ts:t.timestamp,price:t.price,oi:t.openInterest,funding:t.funding}); const cutoff=Date.now()-15*60*1000; s.points=s.points.filter(x=>x.ts>=cutoff); return t; }
function pointFiveMinutesAgo(points,now) { const target=now-VOLUME_BUCKET_MS; let best=null,distance=Infinity; for(const p of points){const d=Math.abs(p.ts-target); if(d<distance&&p.ts<=now-60000){best=p;distance=d;}} return best; }
function volumeStats(s,now) { const currentBucket=Math.floor(now/VOLUME_BUCKET_MS)*VOLUME_BUCKET_MS; const current=s.buckets.get(currentBucket)??0; const previous=[...s.buckets.entries()].filter(([bucket])=>bucket<currentBucket).sort((a,b)=>b[0]-a[0]).slice(0,Math.max(1,HISTORY_BUCKETS-1)).map(([,value])=>value).filter(v=>v>0); if(previous.length<MIN_BASELINE_BUCKETS)return{current,average:null,multiplier:null,ready:false}; const average=previous.reduce((a,b)=>a+b,0)/previous.length; return{current,average,multiplier:average>0?current/average:null,ready:average>0}; }
function canAlert(key) { const now=Date.now(); if((cooldowns.get(key)??0)>now)return false; cooldowns.set(key,now+SIGNAL_COOLDOWN_MS); return true; }
async function telegram(message) { if(!ALERTS_ENABLED)return false; if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID){console.log(message);return false;} const response=await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text:message,disable_web_page_preview:true})}); if(!response.ok)console.error('Telegram error:',await response.text()); return response.ok; }

async function evaluateSignal(id,event) {
  const t=addTickerPoint(id,event); if(!t)return;
  const s=stateFor(id,t.symbol||instrumentNameOf(event,id));
  const now=Date.now();
  const old=pointFiveMinutesAgo(s.points,now);
  const volume=volumeStats(s,now);
  if(!old||old.price<=0||!volume.ready)return;
  const priceChange=(t.price-old.price)/old.price;
  const oiChange=t.openInterest!==null&&old.oi!==null&&old.oi>0?(t.openInterest-old.oi)/old.oi:null;
  const funding=t.funding;
  const longChecks=[priceChange>=PRICE_MOVE_5M,oiChange!==null&&oiChange>=OI_MOVE_5M,volume.multiplier!==null&&volume.multiplier>=MIN_VOLUME_MULTIPLIER,funding!==null&&funding>=FUNDING_LONG];
  const shortChecks=[priceChange<=-PRICE_MOVE_5M,oiChange!==null&&oiChange<=-OI_MOVE_5M,volume.multiplier!==null&&volume.multiplier>=MIN_VOLUME_MULTIPLIER,funding!==null&&funding<=FUNDING_SHORT];
  const longScore=longChecks.filter(Boolean).length;
  const shortScore=shortChecks.filter(Boolean).length;
  const direction=longScore>=SIGNAL_SCORE?'LONGS ENTERING':shortScore>=SIGNAL_SCORE?'SHORTS ENTERING':null;
  if(!direction)return;
  const prediction=await findPredictionMarket(s.name,now);
  if(REQUIRE_PREDICTION_MARKET&&!prediction){ console.log(`Signal candidate ${s.name}: score=${Math.max(longScore,shortScore)}/4, but next 5m prediction market was not resolved.`); return; }
  if(!canAlert(`${id}:${direction}`))return;
  const arrow=direction==='LONGS ENTERING'?'🟢':'🔴';
  const predictionPrice=predictionDirectionPrice(prediction,direction);
  await telegram([
    `${arrow} COMPOSITE PERPS SIGNAL`,'',s.name||String(id),'',
    `Perps price move: ${pct(priceChange)} / 5m`,
    `Perps volume: ${volume.multiplier?.toFixed(1)??'n/a'}× baseline`,
    `Perps OI: ${oiChange===null?'n/a':pct(oiChange)}`,
    `Funding: ${funding===null?'n/a':pct(funding)}`,'',
    `Signal: ${direction}`,
    `Score: ${Math.max(longScore,shortScore)}/4`,'',
    `Prediction market: ${prediction?.question??'not found'}`,
    `${direction==='LONGS ENTERING'?'Up':'Down'} price: ${price(predictionPrice)}`,
    prediction?`➡️ ${prediction.url}`:''
  ].filter(Boolean).join('\n'));
}

async function subscribeTrades(id) { if(subscribed.has(id))return; subscribed.add(id); try{const handle=await client.subscribe([{topic:'perps.trades',instrumentId:id}]); for await(const event of handle)recordTrade(id,event);}catch(error){console.error(`Perps trades ${id} stream stopped:`,error);subscribed.delete(id);} }

async function main() {
  console.log('Starting Polymarket Perps Composite Signal Monitor...');
  console.log('BBO / Order Book alerts are disabled.');
  console.log(`Signal: price=${pct(PRICE_MOVE_5M)}/5m, OI=±${pct(OI_MOVE_5M)}/5m, funding=+${pct(FUNDING_LONG)}/${pct(FUNDING_SHORT)}, volume>=${MIN_VOLUME_MULTIPLIER}x, score>=${SIGNAL_SCORE}/4`);
  console.log(`Prediction market required: ${REQUIRE_PREDICTION_MARKET}`);
  const tickerHandle=await client.subscribe([{topic:'perps.tickers'}]);
  for await(const event of tickerHandle){
    const id=instrumentIdOf(event);
    if(id===null)continue;
    const symbol=instrumentNameOf(event,id);
    if(!instruments.has(id)){instruments.set(id,symbol);void subscribeTrades(id);}
    await evaluateSignal(id,event);
  }
}
main().catch(error=>{console.error(error);process.exit(1);});
