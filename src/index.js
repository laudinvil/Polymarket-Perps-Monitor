const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const BINANCE_WS_URL = 'wss://fstream.binance.com/market/ws/!forceOrder@arr';
const ASSETS_5M = new Set(['ETH', 'XRP', 'SOL', 'DOGE', 'BNB']);
const ASSETS_15M = new Set();
const QUOTES = new Set(['USDT', 'USDC']);
const MIN_SIZE = 10;
const WINDOW_5M = 5 * 60 * 1000, WINDOW_15M = 15 * 60 * 1000, RECONNECT_MS = 3000;
let windowStart5m=Math.floor(Date.now()/WINDOW_5M)*WINDOW_5M;
let largestLong5m=null,flushTimer,websocket,reconnectTimer,stopping=false,advancing=Promise.resolve();
const num=v=>Number.isFinite(Number(v))?Number(v):0;
function parseSymbol(symbol,assets){const s=String(symbol??'').toUpperCase();for(const quote of QUOTES){if(s.endsWith(quote)){const asset=s.slice(0,-quote.length);if(assets.has(asset))return{asset,quote};}}return null;}
function money(v,q){return `${Number(v).toLocaleString('en-US',{maximumFractionDigits:0})} ${q}`;}
function nextMarketLink(asset,end){const nextStart=Math.ceil(end/WINDOW_5M)*WINDOW_5M;return `https://polymarket.com/event/${asset.toLowerCase()}-updown-5m-${Math.floor(nextStart/1000)}`;}
async function sendTelegram(text){if(!TELEGRAM_BOT_TOKEN||!TELEGRAM_CHAT_ID)return;try{await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:TELEGRAM_CHAT_ID,text,disable_web_page_preview:false})});}catch(e){console.error('Telegram:',e?.message??e);}}
async function sendAlert(start,end,item){if(!item||item.notional<MIN_SIZE)return;await sendTelegram([`🚨 LONG LIQUIDATION — 5M`,'',`${item.asset} — LONG LIQUIDATION`,`💥 Size: ${money(item.notional,item.quote)}`,'',`▶️ NEXT ${item.asset} 5m UP/DOWN`,nextMarketLink(item.asset,end)].join('\n'));}
async function advanceWindows(now){const target5=Math.floor(now/WINDOW_5M)*WINDOW_5M;while(windowStart5m<target5){const s=windowStart5m,e=s+WINDOW_5M,l=largestLong5m;largestLong5m=null;windowStart5m=e;await sendAlert(s,e,l);}}
function requestAdvance(now){advancing=advancing.then(()=>advanceWindows(now)).catch(e=>console.error('Window:',e?.message??e));return advancing;}
function scheduleFlush(){clearTimeout(flushTimer);const next=windowStart5m+WINDOW_5M;flushTimer=setTimeout(async()=>{await requestAdvance(Date.now());if(!stopping)scheduleFlush();},Math.max(100,next-Date.now()+50));}
async function handleForceOrder(payload){const order=payload?.o;if(!order)return;const side=String(order.S??'').toUpperCase();if(side!=='SELL')return;const parsed=parseSymbol(order.s,ASSETS_5M);if(!parsed)return;const price=num(order.ap)||num(order.p),quantity=num(order.q),notional=Math.abs(price*quantity);if(!(price>0)||!(quantity>0)||notional<MIN_SIZE)return;const time=num(payload.E)||num(order.T)||Date.now();await requestAdvance(time);const w=Math.floor(time/WINDOW_5M)*WINDOW_5M;if(w===windowStart5m&&(!largestLong5m||notional>largestLong5m.notional))largestLong5m={asset:parsed.asset,quote:parsed.quote,price,quantity,notional};}
function connect(){if(stopping)return;websocket=new WebSocket(BINANCE_WS_URL);websocket.addEventListener('open',()=>console.log('Binance liquidation stream connected'));websocket.addEventListener('message',e=>{try{const p=JSON.parse(String(e.data));if(p?.e==='forceOrder')void handleForceOrder(p);else if(p?.data?.e==='forceOrder')void handleForceOrder(p.data);}catch(e){console.error('Parse:',e?.message??e);}});websocket.addEventListener('error',e=>console.error('WebSocket:',e?.message??e));websocket.addEventListener('close',()=>{if(!stopping)reconnectTimer=setTimeout(connect,RECONNECT_MS);});}
function shutdown(signal){stopping=true;clearTimeout(flushTimer);clearTimeout(reconnectTimer);try{websocket?.close();}catch{}console.log(`Shutdown: ${signal}`);}
process.on('SIGINT',()=>shutdown('SIGINT'));process.on('SIGTERM',()=>shutdown('SIGTERM'));
console.log('=== POLYMARKET LIQUIDATION MONITOR ===');console.log('15M TEMPORARILY DISABLED');console.log('5M: LONG only | XRP restored | HYPE removed | BTC removed | size threshold: 10 USDT/USDC');console.log('5M: ETH, XRP, SOL, DOGE, BNB');scheduleFlush();connect();
