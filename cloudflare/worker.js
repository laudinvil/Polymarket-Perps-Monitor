const MARGINPAD_BASE='https://marginpad.io/api/v1/liquidations/live';
const GAMMA_BASE='https://gamma-api.polymarket.com';
const POLY_BASE='https://polymarket.com/event';
const TG_BASE='https://api.telegram.org';
const SYMBOLS=['BTC','ETH','SOL','XRP','DOGE','BNB','HYPE'];
const WINDOW=300000;
const BUFFER_TTL=900000;
const SENT_TTL=604800000;
const POLL=30000;
const VERSION='2026-09-03-telegram-recovery-1';

function bucket(ts){return Math.floor(Number(ts)/WINDOW)*WINDOW;}
function ts(v){const n=Number(v);return Number.isFinite(n)?(n<1e12?n*1000:n):null;}
function symbol(v){return String(v||'').toUpperCase().replace(/USDT$|USD$/i,'');}
function eventsOf(j){if(Array.isArray(j?.events))return j.events;if(Array.isArray(j?.data?.events))return j.data.events;if(Array.isArray(j?.data))return j.data;return[];}
function key(e){return [e.ts,e.exchange,e.symbol,e.side,e.price,e.qty,e.notional].join('|');}
async function json(url,opts={}){const r=await fetch(url,{...opts,signal:AbortSignal.timeout(10000)});if(!r.ok)throw new Error(`HTTP ${r.status} for ${url}`);return r.json();}
async function feed(sym){return eventsOf(await json(`${MARGINPAD_BASE}?symbol=${encodeURIComponent(sym)}&limit=400`));}
async function feeds(){const r=await Promise.allSettled(SYMBOLS.map(feed));const ev=[],er=[];r.forEach((x,i)=>x.status==='fulfilled'?ev.push(...x.value):er.push(`${SYMBOLS[i]}: ${x.reason?.message||'failed'}`));if(!ev.length&&er.length===SYMBOLS.length)throw new Error(er.join('; '));return{ev,er};}
function winner(ev,target){const m=new Map();for(const e of ev){const t=ts(e.ts),s=symbol(e.symbol);if(!t||!SYMBOLS.includes(s)||bucket(t)!==target)continue;if(!m.has(s))m.set(s,{symbol:s,events:0,longEvents:0,shortEvents:0,notionalUsd:0,longNotionalUsd:0,shortNotionalUsd:0});const x=m.get(s),n=Number(e.notional)||0,side=String(e.side||'').toLowerCase();x.events++;x.notionalUsd+=n;if(side.includes('long')||side==='buy'){x.longEvents++;x.longNotionalUsd+=n;}else if(side.includes('short')||side==='sell'){x.shortEvents++;x.shortNotionalUsd+=n;}}return[...m.values()].sort((a,b)=>b.notionalUsd-a.notionalUsd||b.events-a.events)[0]||null;}
function usd(v){return `$${Math.round(Number(v)||0).toLocaleString('en-US')}`;}
async function market(s,epoch){const slug=`${String(s).toLowerCase()}-updown-5m-${epoch}`;try{const m=await json(`${GAMMA_BASE}/markets/slug/${slug}`);return m?.slug===slug&&m.active===true&&m.closed!==true?`${POLY_BASE}/${slug}`:null;}catch{return null;}}
async function links(s,now){const cur=Math.floor(bucket(now)/1000),next=cur+300;const [c,n]=await Promise.all([market(s,cur),market(s,next)]);return{c,n};}

async function discoverChatId(token){
  try{
    const r=await json(`${TG_BASE}/bot${token}/getUpdates?limit=20&allowed_updates=%5B%22message%22%2C%22edited_message%22%2C%22channel_post%22%2C%22edited_channel_post%22%5D`);
    const u=Array.isArray(r?.result)?r.result:[];
    for(let i=u.length-1;i>=0;i--){const c=u[i]?.message?.chat||u[i]?.edited_message?.chat||u[i]?.channel_post?.chat||u[i]?.edited_channel_post?.chat;if(c?.id!=null)return String(c.id);}
  }catch(e){console.log(`Telegram chat discovery failed: ${e.message}`);}
  return null;
}
async function telegram(env,storage,text){
  const token=env?.TELEGRAM_BOT_TOKEN;
  if(!token)throw new Error('Missing TELEGRAM_BOT_TOKEN');
  let chat=String(env?.TELEGRAM_CHAT_ID||'').trim();
  if(!chat)chat=String(await storage.get('telegram_chat_id')||'').trim();
  if(!chat){chat=await discoverChatId(token);if(chat)await storage.put('telegram_chat_id',chat);}
  if(!chat)throw new Error('TELEGRAM_CHAT_ID unavailable and no Telegram chat could be discovered');
  const r=await fetch(`${TG_BASE}/bot${token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:chat,text,disable_web_page_preview:false}),signal:AbortSignal.timeout(10000)});
  const d=await r.json().catch(()=>({}));if(!r.ok||d.ok!==true)throw new Error(`Telegram HTTP ${r.status}: ${d.description||'unknown error'}`);return d.result;
}

export class MonitorState{
  constructor(ctx,env){this.ctx=ctx;this.env=env;}
  async run(now){
    const storage=this.ctx.storage;
    const {ev,er}=await feeds();
    const old=(await storage.get('event_buffer'))||[],cut=now-BUFFER_TTL,map=new Map();
    for(const e of old){const t=ts(e.ts);if(t&&t>=cut)map.set(key(e),e);}for(const e of ev){const t=ts(e.ts);if(t&&t>=cut)map.set(key(e),e);}const all=[...map.values()];await storage.put('event_buffer',all);
    const current=bucket(now),targets=[current-WINDOW,current-2*WINDOW,current-3*WINDOW],results=[];
    for(const target of targets){const id=String(target);if(await storage.get(`sent:${id}`))continue;const w=winner(all,target);if(!w||w.notionalUsd<=0){results.push({bucket:new Date(target).toISOString(),sent:false});continue;}
      const {c,n}=await links(w.symbol,now);const label=new Date(target).toISOString().slice(11,16);let text=['🔥 LIQUIDATION SPIKE',`${w.symbol} · 5M · ${label} UTC`,'',`Liquidations: ${w.events}`,`Long: ${w.longEvents} · Short: ${w.shortEvents}`,`Volume: ${usd(w.notionalUsd)}`,`Long volume: ${usd(w.longNotionalUsd)}`,`Short volume: ${usd(w.shortNotionalUsd)}`].join('\n');
      text+=`\n\n🔴 Current Polymarket 5M\n${c||'Market not found'}`;text+=`\n\n➡️ Next Polymarket 5M\n${n||'Market not found yet'}`;
      const sent=await telegram(this.env,storage,text);await storage.put(`sent:${id}`,{at:Date.now(),messageId:sent?.message_id||null});results.push({bucket:new Date(target).toISOString(),sent:true,winner:w,messageId:sent?.message_id||null});
    }
    await storage.put('last_result',{ok:true,at:Date.now(),feedEvents:ev.length,feedErrors:er,results});await storage.setAlarm(Date.now()+POLL);return{ok:true,results,feedEvents:ev.length,feedErrors:er};
  }
  async fetch(req){const u=new URL(req.url);if(u.pathname==='/health')return Response.json({ok:true,version:VERSION,lastResult:await this.ctx.storage.get('last_result'),cachedChatId:Boolean(await this.ctx.storage.get('telegram_chat_id'))});if(u.pathname==='/run'&&req.method==='POST'){try{const b=await req.json().catch(()=>({}));return Response.json(await this.run(Number(b.now)||Date.now()));}catch(e){const x={ok:false,error:e.message,at:Date.now()};await this.ctx.storage.put('last_result',x);return Response.json(x,{status:500});}}return new Response('Not found',{status:404});}
  async alarm(){try{await this.run(Date.now());}catch(e){await this.ctx.storage.put('last_result',{ok:false,error:e.message,at:Date.now()});await this.ctx.storage.setAlarm(Date.now()+POLL);}}
}
function monitor(env){return env.MONITOR.get(env.MONITOR.idFromName('global'));}
export default{async scheduled(_c,env,ctx){ctx.waitUntil(monitor(env).fetch('https://monitor/run',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({now:Date.now()})}));},async fetch(req,env){const u=new URL(req.url);if(u.pathname==='/health')return monitor(env).fetch('https://monitor/health');if(u.pathname==='/run'&&req.method==='POST')return monitor(env).fetch(req);return new Response('Polymarket Perps Monitor',{status:200});}};
