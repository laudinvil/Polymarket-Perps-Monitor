const { fetchSymbolFeed, normalizeTs } = require('../src/liquidation-monitor');
const { findCurrentMarket } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');
const fs = require('fs');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const TIMEFRAME = '5m';
const PERIOD_MS = 5 * 60 * 1000;
const POLL_MS = 4000;
const ALERT_MIN_GAP_MS = 5000;
const STATE_FILE = '.monitor-state.json';
const HISTORY_FILE = 'monitor-history.log';

const state = {
  periodStart: null, longCount: 0, shortCount: 0, periodAlreadyAlerted: false,
  seenLiquidations: new Set(), initialized: false, lastAlertAt: null, lastAlertSymbol: null,
};
let alertSendChain = Promise.resolve();
let lastAlertSentAt = 0;
function periodStart(now) { return Math.floor(now / PERIOD_MS) * PERIOD_MS; }
function eventSide(e) {
  const value = String(e?.side || e?.direction || '').toLowerCase();
  if (value.includes('long') || value === 'buy') return 'LONG';
  if (value.includes('short') || value === 'sell') return 'SHORT';
  return null;
}
function liquidationKey(symbol, ts, side, e) {
  const id = e?.id ?? e?.liquidationId ?? e?.eventId ?? e?.tradeId ?? e?.txHash ?? e?.orderId;
  if (id !== undefined && id !== null && String(id) !== '') return `${symbol}:id:${String(id)}`;
  return [symbol, ts, side, e?.exchange ?? '', e?.price ?? '', e?.qty ?? e?.quantity ?? e?.size ?? '', e?.notional ?? e?.usd ?? e?.value ?? e?.amount ?? ''].join('|');
}
function persistStatus() {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ updatedAt:new Date().toISOString(), timeframe:TIMEFRAME, symbols:SYMBOLS, periodStart:state.periodStart, longCount:state.longCount, shortCount:state.shortCount, periodAlreadyAlerted:state.periodAlreadyAlerted, seenLiquidations:[...state.seenLiquidations].slice(-5000), initialized:state.initialized, lastAlertAt:state.lastAlertAt, lastAlertSymbol:state.lastAlertSymbol }, null, 2)+'\n');
}
function appendHistory(record) { fs.appendFileSync(HISTORY_FILE, JSON.stringify({ts:new Date().toISOString(),...record})+'\n'); }
function restoreState() {
  try {
    const saved=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    if(saved?.timeframe!==TIMEFRAME || !Array.isArray(saved?.symbols) || saved.symbols.join(',')!==SYMBOLS.join(',')) return;
    if(!Number.isFinite(Number(saved?.periodStart))) return;
    state.periodStart=Number(saved.periodStart); state.longCount=Number(saved.longCount||0); state.shortCount=Number(saved.shortCount||0); state.periodAlreadyAlerted=Boolean(saved.periodAlreadyAlerted); state.seenLiquidations=new Set(Array.isArray(saved.seenLiquidations)?saved.seenLiquidations:[]); state.initialized=Boolean(saved.initialized); state.lastAlertAt=saved.lastAlertAt??null; state.lastAlertSymbol=saved.lastAlertSymbol??null;
    console.log(`STATE RESTORED 5m global imbalance period=${new Date(state.periodStart).toISOString()} long=${state.longCount} short=${state.shortCount}`);
  } catch(error) { console.log(`STATE RESTORE: no usable state (${error.message}); starting fresh`); }
}
async function fetchAllFeeds() {
  const entries=await Promise.all(SYMBOLS.map(async symbol=>{ try{return [symbol,await fetchSymbolFeed(symbol)];}catch(error){console.warn(`FEED ${symbol} FAILED: ${error.message}`);return [symbol,[]];} }));
  return new Map(entries);
}
function collectCurrentPeriodEvents(feeds, now) {
  const current=periodStart(now), events=[];
  const counts={};
  for(const symbol of SYMBOLS){
    let valid=0;
    for(const event of feeds.get(symbol)||[]){
      const ts=normalizeTs(event?.ts), side=eventSide(event);
      if(!ts||!side||ts<current||ts>=current+PERIOD_MS) continue;
      valid++;
      const key=liquidationKey(symbol,ts,side,event);
      if(state.seenLiquidations.has(key)) continue;
      events.push({symbol,ts,side,key,event});
    }
    counts[symbol]=valid;
  }
  events.sort((a,b)=>a.ts-b.ts);
  if(events.length || Object.values(counts).some(Boolean)) console.log(`5m EVENTS current=${new Date(current).toISOString()} available=${JSON.stringify(counts)} new=${events.length} totals=${state.longCount}/${state.shortCount}`);
  for(const item of events){
    state.seenLiquidations.add(item.key);
    const beforeLong=state.longCount, beforeShort=state.shortCount;
    if(item.side==='LONG') state.longCount++; else state.shortCount++;
    console.log(`5m EVENT ${new Date(item.ts).toISOString()} ${item.symbol} ${item.side} GLOBAL=${state.longCount}/${state.shortCount}`);
    const crossedLong=beforeLong<beforeShort && state.longCount>state.shortCount;
    const crossedShort=beforeShort<beforeLong && state.shortCount>state.longCount;
    if(!state.periodAlreadyAlerted&&(crossedLong||crossedShort)){
      const direction=crossedLong?'LONG':'SHORT';
      state.periodAlreadyAlerted=true; persistStatus();
      console.log(`5m IMBALANCE CROSS symbol=${item.symbol} direction=${direction} before=${beforeLong}/${beforeShort} after=${state.longCount}/${state.shortCount} GLOBAL_PERIOD_LOCK=CLOSED`);
      enqueueAlert(item.symbol,direction,current,beforeLong,beforeShort,state.longCount,state.shortCount);
    }
  }
  return events.length;
}
function enqueueAlert(symbol,direction,currentPeriod,beforeLong,beforeShort,longCount,shortCount){
  alertSendChain=alertSendChain.then(async()=>{
    const wait=Math.max(0,ALERT_MIN_GAP_MS-(Date.now()-lastAlertSentAt)); if(wait) await new Promise(r=>setTimeout(r,wait));
    try{
      const market=await findCurrentMarket(symbol,Date.now(),'5m');
      const message=[`🔥 ${symbol} · 5M`,`LIQUIDATION IMBALANCE FLIP · ${direction}`,`Before: LONG ${beforeLong} · SHORT ${beforeShort}`,`After: LONG ${longCount} · SHORT ${shortCount}`,`Trigger: ${symbol} liquidation`,`Period: ${new Date(currentPeriod).toLocaleString('en-GB',{timeZone:'Europe/Kyiv',hour12:false})}`,market?.url?`➡️ CURRENT · Polymarket 5M\n${market.url}`:null].filter(Boolean).join('\n');
      await sendTelegramMessage(message); lastAlertSentAt=Date.now(); state.lastAlertAt=new Date(lastAlertSentAt).toISOString(); state.lastAlertSymbol=symbol; persistStatus(); appendHistory({type:'global_liquidation_imbalance_cross',timeframe:'5m',symbol,direction,currentPeriod,beforeLong,beforeShort,longCount,shortCount,marketUrl:market?.url||null}); console.log(`5m GLOBAL IMBALANCE ALERT SENT symbol=${symbol} direction=${direction} before=${beforeLong}/${beforeShort} after=${longCount}/${shortCount} market=${market?.url||'NONE'}`);
    }catch(error){console.warn(`5m GLOBAL IMBALANCE ALERT FAILED ${symbol}: ${error.message}`);}
  }).catch(error=>console.warn(`5m ALERT QUEUE FAILED: ${error.message}`));
}
function initializePeriod(current){
  if(state.periodStart===null){state.periodStart=current;state.longCount=0;state.shortCount=0;state.periodAlreadyAlerted=false;state.seenLiquidations.clear();persistStatus();console.log(`5m GLOBAL IMBALANCE START ${new Date(current).toISOString()} symbols=${SYMBOLS.join(',')}`);return;}
  if(state.periodStart===current)return;
  console.log(`5m PERIOD CLOSE period=${new Date(state.periodStart).toISOString()} long=${state.longCount} short=${state.shortCount}`); state.periodStart=current;state.longCount=0;state.shortCount=0;state.periodAlreadyAlerted=false;state.seenLiquidations.clear();persistStatus();console.log(`5m PERIOD RESET next=${new Date(current).toISOString()}`);
}
async function processTimeframe(feeds,now){const current=periodStart(now);initializePeriod(current);const added=collectCurrentPeriodEvents(feeds,now);if(!state.initialized){state.initialized=true;persistStatus();console.log(`INITIAL 5m GLOBAL IMBALANCE BASELINE READY current=${new Date(current).toISOString()} long=${state.longCount} short=${state.shortCount}`);}else if(added)persistStatus();}
function main(){restoreState();console.log(`5m GLOBAL LIQUIDATION IMBALANCE MONITOR STARTED; symbols=${SYMBOLS.join(',')}; event-count based; alert only on strict crossing of global LONG/SHORT counts; one alert per 5m period.`);(async()=>{while(true){const now=Date.now();try{await processTimeframe(await fetchAllFeeds(),now);}catch(error){console.warn(`MONITOR LOOP FAILED: ${error.message}`);}await new Promise(r=>setTimeout(r,POLL_MS));}})().catch(error=>{console.error(`MONITOR FATAL: ${error.stack||error.message}`);process.exitCode=1;});}
main();