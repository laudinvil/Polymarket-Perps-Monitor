const fs = require('fs');
const path = require('path');
const configuredUrl = String(process.env.CONVEX_URL || '').trim().replace(/\/$/, '');
const BASE_URL = configuredUrl.replace(/\.convex\.cloud$/i, '.convex.site');
const TOKEN = String(process.env.CONVEX_INGEST_TOKEN || '').trim();
const RUN_ID = Number(process.env.GITHUB_RUN_ID || 0);
const COMMIT_SHA = String(process.env.GITHUB_SHA || '');
const LOG_PATH = path.resolve(process.env.MONITOR_LOG_PATH || (process.env.MONITOR_MODE === 'line' ? 'line-movement-history.log' : 'monitor.log'));
const CURSOR_PATH = path.resolve(process.env.MONITOR_MODE === 'line' ? '.line-convex-log-cursor' : '.convex-log-cursor');
async function post(type, data) {
  if (!BASE_URL || !TOKEN) return false;
  try {
    const response = await fetch(`${BASE_URL}/ingest`, { method:'POST', headers:{accept:'application/json','content-type':'application/json',authorization:`Bearer ${TOKEN}`}, body:JSON.stringify({type,data}) });
    if (!response.ok) { console.warn(`CONVEX ${type} FAILED: ${response.status}`); return false; }
    return true;
  } catch (error) { console.warn(`CONVEX ${type} FAILED: ${error.message}`); return false; }
}
async function start(){ if(!BASE_URL||!TOKEN)return; await post('run.start',{runId:RUN_ID,githubRunId:String(RUN_ID),commitSha:COMMIT_SHA,startedAt:Date.now()}); fs.writeFileSync(CURSOR_PATH,'0'); }
function readNewLines(){ if(!fs.existsSync(LOG_PATH))return[]; const lines=fs.readFileSync(LOG_PATH,'utf8').split(/\r?\n/); const cursor=fs.existsSync(CURSOR_PATH)?Number(fs.readFileSync(CURSOR_PATH,'utf8'))||0:0; const fresh=lines.slice(cursor); fs.writeFileSync(CURSOR_PATH,String(lines.length)); return fresh; }
async function sync(){ if(!BASE_URL||!TOKEN)return; await post('run.heartbeat',{runId:RUN_ID,heartbeatAt:Date.now()}); for(const line of readNewLines()){if(!line.trim())continue;try{const row=JSON.parse(line); if(process.env.MONITOR_MODE==='line'){if(row.type!=='line_move_alert')continue; await post('lineAlert',{runId:RUN_ID,eventId:String(row.eventId),home:String(row.home),away:String(row.away),market:String(row.market),selection:String(row.selection),line:Number(row.line),movePercent:Number(row.movePercent),bookmakers:row.bookmakers||[],polymarketUrl:row.polymarketUrl||null,sentAt:Date.parse(row.ts)||Date.now()});}else{if(!row.timeframe||!row.symbol||!Number.isFinite(Number(row.period)))continue; await post('snapshot',{runId:RUN_ID,timeframe:String(row.timeframe),symbol:String(row.symbol),boundaryTs:Number(row.period),imbalanceUsd:Number(row.imbalanceUsd)||0,longUsd:Number(row.longUsd)||0,shortUsd:Number(row.shortUsd)||0,longEvents:Number(row.longEvents)||0,shortEvents:Number(row.shortEvents)||0,events:(Number(row.longEvents)||0)+(Number(row.shortEvents)||0)});}}catch{}} }
async function finish(status='completed'){if(!BASE_URL||!TOKEN)return;await sync();await post('run.finish',{runId:RUN_ID,finishedAt:Date.now(),status});try{fs.unlinkSync(CURSOR_PATH)}catch{}}
(async()=>{const command=process.argv[2]||'sync';if(command==='start')await start();else if(command==='finish')await finish(process.argv[3]||'completed');else await sync();})().catch(error=>{console.error(`CONVEX SYNC FAILED: ${error.message}`);process.exitCode=0;});
