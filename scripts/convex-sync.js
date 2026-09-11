const fs=require('fs');
const path=require('path');
const base=String(process.env.CONVEX_URL||'').trim().replace(/\/$/,'').replace(/\.convex\.cloud$/i,'.convex.site');
const token=String(process.env.CONVEX_INGEST_TOKEN||'').trim();
const runId=Number(process.env.GITHUB_RUN_ID||0);
const sha=String(process.env.GITHUB_SHA||'');
const lineMode=process.env.MONITOR_MODE==='line';
const log=path.resolve(lineMode?'line-movement-history.log':'monitor.log');
const cursor=path.resolve(lineMode?'.line-convex-log-cursor':'.convex-log-cursor');
async function post(type,data){if(!base||!token)return;try{const r=await fetch(`${base}/ingest`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({type,data})});if(!r.ok)console.warn(`CONVEX ${type} FAILED ${r.status}`);}catch(e){console.warn(`CONVEX ${type} FAILED ${e.message}`);}}
async function start(){await post('run.start',{runId,githubRunId:String(runId),commitSha:sha,startedAt:Date.now()});fs.writeFileSync(cursor,'0');}
async function sync(){await post('run.heartbeat',{runId,heartbeatAt:Date.now()});if(!fs.existsSync(log))return;const a=fs.readFileSync(log,'utf8').split(/\r?\n/);const n=fs.existsSync(cursor)?Number(fs.readFileSync(cursor,'utf8'))||0:0;fs.writeFileSync(cursor,String(a.length));for(const line of a.slice(n)){try{const x=JSON.parse(line);if(lineMode&&x.type==='line_move_alert')await post('snapshot',{runId,timeframe:'line',symbol:String(x.eventId),boundaryTs:Date.parse(x.ts)||Date.now(),imbalanceUsd:Number(x.movePercent)||0,longUsd:0,shortUsd:0,longEvents:0,shortEvents:0,events:1});if(!lineMode&&x.timeframe&&x.symbol)await post('snapshot',{runId,timeframe:String(x.timeframe),symbol:String(x.symbol),boundaryTs:Number(x.period),imbalanceUsd:Number(x.imbalanceUsd)||0,longUsd:Number(x.longUsd)||0,shortUsd:Number(x.shortUsd)||0,longEvents:Number(x.longEvents)||0,shortEvents:Number(x.shortEvents)||0,events:(Number(x.longEvents)||0)+(Number(x.shortEvents)||0)});}catch{}}}
async function finish(status){await sync();await post('run.finish',{runId,finishedAt:Date.now(),status});try{fs.unlinkSync(cursor)}catch{}}
(async()=>{const c=process.argv[2]||'sync';if(c==='start')await start();else if(c==='finish')await finish(process.argv[3]||'completed');else await sync();})().catch(e=>console.error(`CONVEX SYNC FAILED ${e.message}`));
