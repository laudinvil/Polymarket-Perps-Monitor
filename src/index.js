const https = require('https');
const { spawn } = require('child_process');
const { fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey, WINDOW_MS } = require('./liquidation-monitor');
const { findCurrentMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

// 5M LIQUIDATION LEADER: all supported coins, no liquidation-count threshold.
const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const MAX_OPPOSITE_LIQUIDATIONS = 0;
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
  const diagnostics=[];
  const allowed=new Set(symbols.map(normalizeSymbol)), rows=new Map(), seen=new Set();
  for(const [requestedSymbol,events] of results){
    const normalizedRequested=normalizeSymbol(requestedSymbol);
    let totalValid=0, bucketValid=0, longBucket=0, shortBucket=0;
    for(const event of events){
      const ts=normalizeTs(event.ts),symbol=normalizeSymbol(event.symbol),side=String(event.side||'').toLowerCase();
      if(!ts||!allowed.has(symbol)||!(side.includes('long')||side.includes('short')||side==='buy'||side==='sell'))continue;
      totalValid++;
      if(bucketStart(ts)!==closedBucket)continue;
      bucketValid++;
      if(side.includes('long')||side==='buy')longBucket++;else shortBucket++;
    }
    diagnostics.push({symbol:normalizedRequested,received:Array.isArray(events)?events.length:0,validLiquidations:totalValid,closed5m:bucketValid,long:longBucket,short:shortBucket,oldestTs:Array.isArray(events)&&events.length?normalizeTs(events[events.length-1]?.ts):null,newestTs:Array.isArray(events)&&events.length?normalizeTs(events[0]?.ts):null});
  }
  console.log(JSON.stringify({type:'liquidation_5m_feed_diagnostics',boundary:new Date(currentBucket).toISOString(),closedBucket:new Date(closedBucket).toISOString(),symbols:diagnostics}));
  for(const [,events] of results)for(const event of events){const ts=normalizeTs(event.ts),symbol=normalizeSymbol(event.symbol),side=String(event.side||'').toLowerCase();if(!ts||bucketStart(ts)!==closedBucket||!allowed.has(symbol))continue;if(!(side.includes('long')||side.includes('short')||side==='buy'||side==='sell'))continue;const key=eventKey(event);if(seen.has(key))continue;seen.add(key);if(!rows.has(symbol))rows.set(symbol,{events:0,longEvents:0,shortEvents:0});const row=rows.get(symbol);row.events+=1;if(side.includes('long')||side==='buy')row.longEvents+=1;else row.shortEvents+=1;}
  processedBuckets.add(bucketKey);
  const candidates=[...rows.entries()].map(([symbol,row])=>({symbol,long:row.longEvents,short:row.shortEvents,total:row.events})).filter(c=>(c.long>0&&c.short===MAX_OPPOSITE_LIQUIDATIONS)||(c.short>0&&c.long===MAX_OPPOSITE_LIQUIDATIONS)).sort((a,b)=>b.total-a.total||Math.max(b.long,b.short)-Math.max(a.long,a.short));
  const best=candidates[0]||null;
  if(!best){console.log(JSON.stringify({type:'liquidation_5m_no_alert',closedBucket:new Date(closedBucket).toISOString(),condition:'exactly_one_side_zero_and_other_side_positive',alertSent:false}));await saveState();return;}
  const winnerSide=best.long>0?'long':'short',winnerCount=winnerSide==='long'?best.long:best.short;
  const alertKey=`5m:${closedBucket}`;if(sentAlerts.has(alertKey)){await saveState();return;}
  const currentMarket=await findCurrentMarket(best.symbol,currentBucket),bucketLabel=formatUtcPlus3(closedBucket),directionEmoji=winnerSide==='long'?'🔴':'🟢';
  const message=[`${directionEmoji} LIQUIDATION LEADER`,`${normalizeSymbol(best.symbol)} · 5M · ${bucketLabel} UTC+3`,'',`Leader: ${winnerSide.toUpperCase()} · ${winnerCount} liquidations`,`Long: ${best.long} · Short: ${best.short}`,`Total: ${best.total}`,'','➡️ NEXT Polymarket 5M',currentMarket?.url||'Market not found yet'].join('\n');
  await sendTelegramMessage(message);sentAlerts.add(alertKey);console.log(JSON.stringify({type:'liquidation_5m_direction_winner',closedBucket:new Date(closedBucket).toISOString(),symbol:normalizeSymbol(best.symbol),leaderSide:winnerSide,leaderCount:winnerCount,liquidations:best.total,longCount:best.long,shortCount:best.short,condition:'exactly_one_side_zero_and_other_side_positive',alertSent:true,currentMarket:currentMarket?.url||null,delayMs:Date.now()-currentBucket}));await saveState();
}

function start15m(){ const child=spawn(process.execPath,['src/btc-15m-monitor.js'],{env:process.env,stdio:'inherit'});child.on('exit',(code,signal)=>{console.error(`15M BTC monitor exited code=${code} signal=${signal}; restarting`);setTimeout(start15m,5000);}); }
async function main(){await loadState();start15m();console.log(`5M liquidation direction-leader monitor started; symbols=${symbols.join(',')}; no count thresholds; opposite=0; exact boundary scheduling; BTC 15M monitor enabled`);while(true){const now=Date.now(),nextBoundary=bucketStart(now)+WINDOW_MS_5M;await sleep(Math.max(0,nextBoundary-Date.now()));try{await checkOnce(nextBoundary);}catch(error){console.error(`MONITOR CYCLE FAILED: ${error.stack||error.message}`);}}}
main().catch(error=>{console.error(`MONITOR FAILED: ${error.stack||error.message}`);process.exitCode=1;});
