const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
const ASSETS_5M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const ASSETS_15M = new Set(['BTC', 'ETH', 'XRP', 'SOL', 'DOGE', 'HYPE', 'BNB']);
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_5M = 50000;
const MIN_15M = 25000;
const WINDOW_5M = 5 * 60 * 1000;
const WINDOW_15M = 15 * 60 * 1000;
const RECONNECT_MS = 3000;

let windowStart5m = Math.floor(Date.now() / WINDOW_5M) * WINDOW_5M;
let windowStart15m = Math.floor(Date.now() / WINDOW_15M) * WINDOW_15M;
let largestLong5m = null;
let largestShort5m = null;
let largestLong15m = null;
let largestShort15m = null;
let flushTimer;
let websocket;
let reconnectTimer;
let stopping = false;
let advancing = Promise.resolve();

const num = value => Number.isFinite(Number(value)) ? Number(value) : 0;
function parseSymbol(symbol) {
  const s = String(symbol ?? '').toUpperCase();
  for (const quote of QUOTES) {
    if (s.endsWith(quote)) {
      const asset = s.slice(0, -quote.length);
      if (ASSETS_5M.has(asset)) return { asset, quote };
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
async function flushAlert(start, end, item, durationMs) {
  if (!item) return;
  const tf = durationMs === WINDOW_15M ? '15M' : '5M';
  const direction = item.direction;
  await sendTelegram(['🚨 LARGEST LIQUIDATION — '+tf,'',`${item.asset} — ${direction} LIQUIDATION`,`💥 Size: ${money(item.notional,item.quote)}`,`Price: ${item.price}`,`Qty: ${item.quantity}`,`Window: ${windowText(start,end)}`,'',`▶️ NEXT ${item.asset} ${tf} UP/DOWN`,nextMarketLink(item.asset,end,durationMs)].join('\n'));
}
async function advanceWindows(now) {
  const target5 = Math.floor(now / WINDOW_5M) * WINDOW_5M;
  const target15 = Math.floor(now / WINDOW_15M) * WINDOW_15M;
  while (windowStart5m < target5) {
    const s=windowStart5m,e=s+WINDOW_5M;
    const long=largestLong5m, short=largestShort5m;
    largestLong5m=null; largestShort5m=null; windowStart5m=e;
    await flushAlert(s,e,long,WINDOW_5M); await flushAlert(s,e,short,WINDOW_5M);
  }
  while (windowStart15m < target15) {
    const s=windowStart15m,e=s+WINDOW_15M;
    const long=largestLong15m, short=largestShort15m;
    largestLong15m=null; largestShort15m=null; windowStart15m=e;
    await flushAlert(s,e,long,WINDOW_15M); await flushAlert(s,e,short,WINDOW_15M);
  }
}
function requestAdvance(now) { advancing=advancing.then(()=>advanceWindows(now)).catch(e=>console.error('Window:',e?.message??e)); return advancing; }
function scheduleFlush() { clearTimeout(flushTimer); const next=Math.min(windowStart5m+WINDOW_5M,windowStart15m+WINDOW_15M); flushTimer=setTimeout(async()=>{await requestAdvance(Date.now());if(!stopping)scheduleFlush();},Math.max(100,next-Date.now()+50)); }
function updateLargest(current, candidate) { return !current || candidate.notional > current.notional ? candidate : current; }
async function handleForceOrder(payload) {
  const order=payload?.o;if(!order)return;
  const side=String(order.S??'').toUpperCase();
  if(side!=='SELL'&&side!=='BUY')return;
  const parsed=parseSymbol(order.s);if(!parsed)return;
  const price=num(order.ap)||num(order.p),quantity=num(order.q),notional=Math.abs(price*quantity);if(!(price>0)||!(quantity>0))return;
  const time=num(payload.E)||num(order.T)||Date.now(); await requestAdvance(time);
  const direction = side === 'SELL' ? 'LONG' : 'SHORT';
  const candidate={asset:parsed.asset,quote:parsed.quote,price,quantity,notional,direction};
  if(notional>=MIN_5M){const w5=Math.floor(time/WINDOW_5M)*WINDOW_5M;if(w5===windowStart5m){if(direction==='LONG')largestLong5m=updateLargest(largestLong5m,candidate);else largestShort5m=updateLargest(largestShort5m,candidate);}}
  if(notional>=MIN_15M){const w15=Math.floor(time/WINDOW_15M)*WINDOW_15M;if(w15===windowStart15m){if(direction==='LONG')largestLong15m=updateLargest(largestLong15m,candidate);else largestShort15m=updateLargest(largestShort15m,candidate);}}
}
function connect(){if(stopping)return;websocket=new WebSocket(BINANCE_WS_URL);websocket.addEventListener('open',()=>console.log('Binance liquidation stream connected'));websocket.addEventListener('message',e=>{try{const p=JSON.parse(String(e.data));if(p?.e==='forceOrder')void handleForceOrder(p);else if(p?.data?.e==='forceOrder')void handleForceOrder(p.data);}catch(e){console.error('Parse:',e?.message??e);}});websocket.addEventListener('error',e=>console.error('WebSocket:',e?.message??e));websocket.addEventListener('close',()=>{if(!stopping)reconnectTimer=setTimeout(connect,RECONNECT_MS);});}
function shutdown(signal){stopping=true;clearTimeout(flushTimer);clearTimeout(reconnectTimer);try{websocket?.close();}catch{}console.log(`Shutdown: ${signal}`);}
process.on('SIGINT',()=>shutdown('SIGINT'));process.on('SIGTERM',()=>shutdown('SIGTERM'));
console.log('=== POLYMARKET LIQUIDATION MONITOR ===');
console.log('5M: LONG and SHORT >= 50000 USDT/USDC; BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
console.log('15M: LONG and SHORT >= 25000 USDT/USDC; BTC, ETH, XRP, SOL, DOGE, HYPE, BNB');
console.log('5M and 15M alerts are independent; each alert has exactly one link');
scheduleFlush();connect();
