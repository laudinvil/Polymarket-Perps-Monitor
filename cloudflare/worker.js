const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';
const TELEGRAM_API = 'https://api.telegram.org';
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_MS = 5 * 60 * 1000;
const CLAIM_TTL = 10 * 60;

function bucketStart(ts) { return Math.floor(Number(ts) / WINDOW_MS) * WINDOW_MS; }
function normalizeTs(value) { const n = Number(value); return Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : null; }
function normalizeSymbol(symbol) { return String(symbol || '').toUpperCase().replace(/USDT$|USD$/i, ''); }
function extractEvents(json) {
  if (json && Array.isArray(json.events)) return json.events;
  if (json?.data && Array.isArray(json.data.events)) return json.data.events;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}
function eventKey(e) { return [e.ts,e.exchange,e.symbol,e.side,e.price,e.qty,e.notional].join('|'); }
async function fetchJson(url) {
  const r = await fetch(url, {headers:{accept:'application/json'}, signal:AbortSignal.timeout(10000)});
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
async function fetchEvents() {
  const feed = await fetchJson(FEED_URL);
  const all = [...extractEvents(feed)];
  const results = await Promise.allSettled(SYMBOLS.map(async s => extractEvents(await fetchJson(`${LIVE_URL}?symbol=${encodeURIComponent(s)}&limit=400`))));
  for (const r of results) if (r.status === 'fulfilled') all.push(...r.value);
  const unique = new Map(); for (const e of all) unique.set(eventKey(e),e); return [...unique.values()];
}
function selectWinner(events,targetBucket) {
  const rows=new Map(), allowed=new Set(SYMBOLS);
  for(const e of events){
    const ts=normalizeTs(e.ts), symbol=normalizeSymbol(e.symbol);
    if(!ts||!allowed.has(symbol)||bucketStart(ts)!==targetBucket) continue;
    if(!rows.has(symbol)) rows.set(symbol,{symbol,events:0,longEvents:0,shortEvents:0,notionalUsd:0,longNotionalUsd:0,shortNotionalUsd:0});
    const row=rows.get(symbol), n=Number(e.notional)||0, side=String(e.side||'').toLowerCase();
    row.events++; row.notionalUsd+=n;
    if(side.includes('long')||side==='buy'){row.longEvents++;row.longNotionalUsd+=n;}
    else if(side.includes('short')||side==='sell'){row.shortEvents++;row.shortNotionalUsd+=n;}
  }
  return [...rows.values()].sort((a,b)=>b.notionalUsd-a.notionalUsd||b.events-a.events)[0]||null;
}
function formatUsd(v){return new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:0}).format(v||0);}
async function sendTelegram(env,text){
  if(!env.TELEGRAM_BOT_TOKEN||!env.TELEGRAM_CHAT_ID) throw new Error('Missing Telegram secrets');
  const r=await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:env.TELEGRAM_CHAT_ID,text,disable_web_page_preview:false}),signal:AbortSignal.timeout(10000)});
  const d=await r.json().catch(()=>({})); if(!r.ok||d.ok!==true) throw new Error(`Telegram HTTP ${r.status}: ${d.description||'unknown error'}`); return d.result;
}
async function processBucket(env,now=Date.now()) {
  const target=bucketStart(now)-WINDOW_MS, id=String(target);
  if(await env.STATE.get(`sent:${id}`)) return {ok:true,skipped:true,reason:'already_sent',bucket:id};
  const claimKey=`claim:${id}`;
  const claimed=await env.STATE.get(claimKey);
  if(claimed) return {ok:true,skipped:true,reason:'another_run_claimed',bucket:id};
  await env.STATE.put(claimKey,'1',{expirationTtl:CLAIM_TTL});
  try {
    if(await env.STATE.get(`sent:${id}`)) return {ok:true,skipped:true,reason:'already_sent',bucket:id};
    const winner=selectWinner(await fetchEvents(),target);
    if(!winner||winner.notionalUsd<=0){await env.STATE.put(`sent:${id}`,'no_liquidations');return {ok:true,skipped:true,reason:'no_liquidations',bucket:id};}
    const dominant=winner.longNotionalUsd>=winner.shortNotionalUsd?'LONG liquidations':'SHORT liquidations';
    const text=['🔥 5m Liquidation Leader',`${winner.symbol} — ${formatUsd(winner.notionalUsd)}`,`${dominant}: ${formatUsd(Math.max(winner.longNotionalUsd,winner.shortNotionalUsd))}`,`Events: ${winner.events}`,`Bucket: ${new Date(target).toISOString()}`].join('\n');
    const sent=await sendTelegram(env,text);
    await env.STATE.put(`sent:${id}`,String(sent?.message_id||'ok'),{expirationTtl:7*24*60*60});
    return {ok:true,sent:true,bucket:id,winner,telegramMessageId:sent?.message_id||null};
  } finally { await env.STATE.delete(claimKey).catch(()=>{}); }
}
export default {
  async scheduled(controller,env,ctx){ctx.waitUntil(processBucket(env,controller.scheduledTime).then(r=>console.log(JSON.stringify(r))).catch(e=>console.error(JSON.stringify({ok:false,error:e.message}))));},
  async fetch(request,env){
    const url=new URL(request.url);
    if(url.pathname==='/health'){return Response.json({ok:true,service:'polymarket-perps-monitor',lastSentBucket:await env.STATE.get('last_sent_bucket')});}
    if(url.pathname==='/run'&&request.method==='POST'){try{return Response.json(await processBucket(env));}catch(e){return Response.json({ok:false,error:e.message},{status:500});}}
    return new Response('Polymarket Perps Monitor');
  }
};
