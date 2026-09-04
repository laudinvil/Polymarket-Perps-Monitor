const https = require('https');
const { spawn } = require('child_process');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey, DEFAULT_SYMBOLS, WINDOW_MS } = require('./liquidation-monitor');
const { findCurrentMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = DEFAULT_SYMBOLS;
const MIN_LIQUIDATIONS = 21;
const MAX_LIQUIDATIONS = 55;
const MAX_OPPOSITE_LIQUIDATIONS = 2;
const WINDOW_MS_5M = WINDOW_MS;
const STATE_PATH = '.monitor-state.json';
const STATE_API_URL = `https://api.github.com/repos/${process.env.GITHUB_REPOSITORY || 'laudinvil/Polymarket-Perps-Monitor'}/contents/${STATE_PATH}`;
const processedBuckets = new Set();
const sentAlerts = new Set();
let stateSha = null;

function githubRequest(method, body = null) {
  return new Promise((resolve, reject) => {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return reject(new Error('GITHUB_TOKEN is not available'));
    const data = body ? JSON.stringify(body) : null;
    const request = https.request(STATE_API_URL, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'marginpad-monitor', ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, response => {
      let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => { let json = null; try { json = text ? JSON.parse(text) : null; } catch {} if (response.statusCode >= 200 && response.statusCode < 300) return resolve(json); reject(new Error(`GitHub state request failed: ${response.statusCode} ${text}`)); });
    });
    request.on('error', reject); if (data) request.write(data); request.end();
  });
}
async function loadState() { try { const data=await githubRequest('GET'); if(!data||!data.content)return; stateSha=data.sha||null; const state=JSON.parse(Buffer.from(data.content,'base64').toString('utf8')); for(const key of state.processedBuckets||[])processedBuckets.add(key); for(const key of state.alerts||[])sentAlerts.add(key); } catch(error){ console.warn(`STATE LOAD FAILED: ${error.message}`); } }
async function saveState() { if(!process.env.GITHUB_TOKEN)return; const content=Buffer.from(JSON.stringify({processedBuckets:[...processedBuckets].slice(-100),alerts:[...sentAlerts].slice(-200)},null,2)).toString('base64'); const body={message:'Persist monitor state',content,branch:process.env.GITHUB_REF_NAME||'main'}; if(stateSha)body.sha=stateSha; try{const result=await githubRequest('PUT',body);stateSha=result?.content?.sha||stateSha;}catch(error){console.warn(`STATE SAVE FAILED: ${error.message}`);} }
function formatUtcPlus3(ms){return new Date(ms+3*60*60*1000).toISOString().slice(11,16);}
function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}

async function checkOnce(boundary){
  const currentBucket=boundary, closedBucket=currentBucket-WINDOW_MS_5M, bucketKey=`5m:${closedBucket}`;
  if(processedBuckets.has(bucketKey))return;
  const results=await Promise.all(symbols.map(async symbol=>{try{return [symbol,await fetchSymbolFeed(symbol,fetch)];}catch(error){console.warn(`MarginPad live ${symbol}: ${error.message}`);return [symbol,[]];}}));
  const allowed=new Set(symbols.map(normalizeSymbol)), rows=new Map(), seen=new Set();
  for(const [,events] of results)for(const event of events){const ts=normalizeTs(event.ts),symbol=normalizeSymbol(event.symbol),side=String(event.side||'').toLowerCase();if(!ts||bucketStart(ts)!==closedBucket||!allowed.has(symbol))continue;if(!(side.includes('long')||side.includes('short')||side==='buy'||side==='sell'))continue;const key=eventKey(event);if(seen.has(key))continue;seen.add(key);if(!rows.has(symbol))rows.set(symbol,{events:0,longEvents:0,shortEvents:0});const row=rows.get(symbol);row.events+=1;if(side.includes('long')||side==='buy')row.longEvents+=1;else row.shortEvents+=1;}
  processedBuckets.add(bucketKey);
  const longCandidates=[...rows.entries()].map(([symbol,row])=>({symbol,count:row.longEvents,opposite:row.shortEvents,total:row.events})).filter(c=>c.count>=MIN_LIQUIDATIONS&&c.count<=MAX_LIQUIDATIONS&&c.opposite<=MAX_OPPOSITE_LIQUIDATIONS).sort((a,b)=>b.count-a.count||b.total-a.total);
  const shortCandidates=[...rows.entries()].map(([symbol,row])=>({symbol,count:row.shortEvents,opposite:row.longEvents,total:row.events})).filter(c=>c.count>=MIN_LIQUIDATIONS&&c.count<=MAX_LIQUIDATIONS&&c.opposite<=MAX_OPPOSITE_LIQUIDATIONS).sort((a,b)=>b.count-a.count||b.total-a.total);
  const bestLong=longCandidates[0]||null,bestShort=shortCandidates[0]||null;let winner=null;
  if(bestLong&&(!bestShort||bestLong.count>bestShort.count))winner={...bestLong,side:'long'};else if(bestShort&&(!bestLong||bestShort.count>bestLong.count))winner={...bestShort,side:'short'};
  if(!winner){console.log(JSON.stringify({type:'liquidation_5m_no_alert',closedBucket:new Date(closedBucket).toISOString(),minThreshold:MIN_LIQUIDATIONS,maxThreshold:MAX_LIQUIDATIONS,maxOppositeThreshold:MAX_OPPOSITE_LIQUIDATIONS,bestLong:bestLong?.count||0,bestShort:bestShort?.count||0,alertSent:false}));await saveState();return;}
  const alertKey=`5m:${closedBucket}`;if(sentAlerts.has(alertKey)){await saveState();return;}
  const currentMarket=await findCurrentMarket(winner.symbol,currentBucket),winnerRow=rows.get(winner.symbol),bucketLabel=formatUtcPlus3(closedBucket),directionEmoji=winner.side==='long'?'🔴':'🟢';
  const message=[`${directionEmoji} LIQUIDATION LEADER`,`${normalizeSymbol(winner.symbol)} · 5M · ${bucketLabel} UTC+3`,'',`Leader: ${winner.side.toUpperCase()} · ${winner.count} liquidations`,`Long: ${winnerRow.longEvents} · Short: ${winnerRow.shortEvents}`,`Total: ${winnerRow.events}`,'','➡️ NEXT Polymarket 5M',currentMarket?.url||'Market not found yet'].join('\n');
  await sendTelegramMessage(message);sentAlerts.add(alertKey);console.log(JSON.stringify({type:'liquidation_5m_direction_winner',closedBucket:new Date(closedBucket).toISOString(),symbol:normalizeSymbol(winner.symbol),leaderSide:winner.side,leaderCount:winner.count,liquidations:winnerRow.events,longCount:winnerRow.longEvents,shortCount:winnerRow.shortEvents,minThreshold:MIN_LIQUIDATIONS,maxThreshold:MAX_LIQUIDATIONS,maxOppositeThreshold:MAX_OPPOSITE_LIQUIDATIONS,alertSent:true,currentMarket:currentMarket?.url||null,delayMs:Date.now()-currentBucket}));await saveState();
}

function start15m(){ const child=spawn(process.execPath,['src/btc-15m-monitor.js'],{env:process.env,stdio:'inherit'});child.on('exit',(code,signal)=>{console.error(`15M BTC monitor exited code=${code} signal=${signal}; restarting`);setTimeout(start15m,5000);}); }
async function main(){await loadState();start15m();console.log(`5M liquidation direction-leader monitor started; symbols=${symbols.join(',')}; leader=${MIN_LIQUIDATIONS}-${MAX_LIQUIDATIONS}; opposite<=${MAX_OPPOSITE_LIQUIDATIONS}; exact boundary scheduling; BTC 15M monitor enabled`);while(true){const now=Date.now(),nextBoundary=bucketStart(now)+WINDOW_MS_5M;await sleep(Math.max(0,nextBoundary-Date.now()));try{await checkOnce(nextBoundary);}catch(error){console.error(`MONITOR CYCLE FAILED: ${error.stack||error.message}`);}}}
main().catch(error=>{console.error(`MONITOR FAILED: ${error.stack||error.message}`);process.exitCode=1;});
