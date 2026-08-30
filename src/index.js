const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
const ASSETS_5M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const ASSETS_15M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_LONG_5M = 50000;
const MIN_SHORT_15M = 25000;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const RECONNECT_MS = 3000;

let windowStart5m = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
let windowStart15m = Math.floor(Date.now() / WINDOW_15M) * WINDOW_15M;
let largestLong5m = null;
let largestShort15m = null;
let flushTimer;
let websocket;
let reconnectTimer;
let stopping = false;
let advancing = Promise.resolve();

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
function parseSymbol(symbol, assets) {
  const s = String(symbol ?? '').toUpperCase();
  for (const quote of QUOTES) {
    if (s.endsWith(quote)) {
      const asset = s.slice(0, -quote.length);
      if (assets.has(asset)) return { asset, quote };
    }
  }
  return null;
}
function money(value, quote) { return `${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${quote}`; }
function windowText(start, end) { return `${new Date(start).toISOString().slice(11, 16)}–${new Date(end).toISOString().slice(11, 16)} UTC`; }
function nextMarketLink(asset, windowEnd, durationMs) {
  const nextStart = Math.ceil(windowEnd / durationMs) * durationMs;
  const minutes = durationMs === WINDOW_15M ? '15m' : '5m';
  return `https://polymarket.com/event/${asset.toLowerCase()}-updown-${minutes}-${Math.floor(nextStart / 1000)}`;
}
async function sendTelegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  try { await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:false}) }); }
  catch (e) { console.error('Telegram:', e?.message ?? e); }
}
async function flush5m(start,end,item) {
  if (!item) return;
  await sendTelegram(['🚨 LARGEST LONG LIQUIDATION — 5M','',`${item.asset} — LONG LIQUIDATION`,`💥 Size: ${money(item.notional,item.quote)}`,`Price: ${item.price}`,`Qty: ${item.quantity}`,`Window: ${windowText(start,end)}`,'',`▶️ NEXT ${item.asset} 5M UP/DOWN`,nextMarketLink(item.asset,end,WINDOW_5M)].join('\n'));
}
async function flush15m(start,end,item) {
  if (!item) return;
  await sendTelegram(['🚨 LARGEST SHORT LIQUIDATION — 15M','',`${item.asset} — SHORT LIQUIDATION`,`💥 Size: ${money(item.notional,item.quote)}`,`Price: ${item.price}`,`Qty: ${item.quantity}`,`Window: ${windowText(start,end)}`,'',`▶️ NEXT ${item.asset} 15M UP/DOWN`,nextMarketLink(item.asset,end,WINDOW_15M)].join('\n'));
}
async function advanceWindows(now) {
  const target5 = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const target15 = Math.floor(now / WINDOW_15M) * WINDOW_15M;
  while (windowStart5m < target5) { const s=windowStart5m,e=s+WINDOW_5M,i=largestLong5m; largestLong5m=null; windowStart5m=e; await flush5m(s,e,i); }
  while (windowStart15m < target15) { const s=windowStart15m,e=s+WINDOW_15M,i=largestShort15m; largestShort15m=null; windowStart15m=e; await flush15m(s,e,i); }
}
function requestAdvance(now) { advancing=advancing.then(()=>advanceWindows(now)).catch(e=>console.error('Window:',e?.message??e)); return advancing; }
function scheduleFlush() { clearTimeout(flushTimer); const next=Math.min(windowStart5m+WINDOW_5M,windowStart15m+WINDOW_15M); flushTimer=setTimeout(async()=>{await requestAdvance(Date.now());if(!stopping)scheduleFlush();},Math.max(100,next-Date.now()+50)); }
async function handleForceOrder(payload) {
  const order=payload?.o;if(!order)return;
  const side=String(order.S??'').toUpperCase();
  const assets=side==='SELL'?ASSETS_5M:side==='BUY'?ASSETS_15M:null;
  if(!assets)return;
  const parsed=parseSymbol(order.s,assets);if(!parsed)return;
  const price=num(order.ap)||num(order.p),quantity=num(order.q),notional=Math.abs(price*quantity);if(!(price>0)||!(quantity>0))return;
  const time=num(payload.E)||num(order.T)||Date.now(); await requestAdvance(time);
  if(side==='SELL'&&notional>=MIN_LONG_5M){const w=Math.floor(time/WINDOW_5M)*WINDOW_5M;if(w===windowStart5m){const c={asset:parsed.asset,quote:parsed.quote,price,quantity,notional};if(!largestLong5m||notional>largestLong5m.notional)largestLong5m=c;}}
  if(side==='BUY'&&notional>=MIN_SHORT_15M){const w=Math.floor(time/WINDOW_15M)*WINDOW_15M;if(w===windowStart15m){const c={asset:parsed.asset,quote:parsed.quote,price,quantity,notional};if(!largestShort15m||notional>largestShort15m.notional)largestShort15m=c;}}
}
function connect(){if(stopping)return;websocket=new WebSocket(BINANCE_WS_URL);websocket.addEventListener('open',()=>console.log('Binance liquidation stream connected'));websocket.addEventListener('message',e=>{try{const p=JSON.parse(String(e.data));if(p?.e==='forceOrder')void handleForceOrder(p);else if(p?.data?.e==='forceOrder')void handleForceOrder(p.data);}catch(e){console.error('Parse:',e?.message??e);}});websocket.addEventListener('error',e=>console.error('WebSocket:',e?.message??e));websocket.addEventListener('close',()=>{if(!stopping)reconnectTimer=setTimeout(connect,RECONNECT_MS);});}
function shutdown(signal){stopping=true;clearTimeout(flushTimer);clearTimeout(reconnectTimer);try{websocket?.close();}catch{}console.log(`Shutdown: ${signal}`);}
process.on('SIGINT',()=>shutdown('SIGINT'));process.on('SIGTERM',()=>shutdown('SIGTERM'));
console.log('=== POLYMARKET LIQUIDATION MONITOR ===');console.log('5M: LONG >= 50000 USDT/USDC; BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');console.log('15M: SHORT >= 25000 USDT/USDC; BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');console.log('5M and 15M alerts are independent; one link per alert');
scheduleFlush();connect();
