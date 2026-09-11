const fs = require('fs');
const path = require('path');
const { sendTelegramMessage } = require('../src/telegram');
const API_KEY=String(process.env.ODDS_API_KEY||'').trim();
const BASE='https://api.odds-api.io/v3';
const SPORT=String(process.env.ODDS_SPORT||'football');
const LEAGUE=String(process.env.ODDS_LEAGUE||'england-premier-league');
const BOOKMAKERS=String(process.env.ODDS_BOOKMAKERS||'Bet365,Unibet').split(',').map(x=>x.trim()).filter(Boolean);
const MARKET=String(process.env.ODDS_MARKET||'Totals');
const SELECTION=String(process.env.ODDS_SELECTION||'over');
const LINE=Number(process.env.ODDS_LINE||2.5);
const THRESHOLD=Number(process.env.ODDS_MOVE_THRESHOLD_PERCENT||5);
const MIN_BOOKS=Math.max(1,Number(process.env.ODDS_MIN_BOOKMAKERS||2));
const POLL_MS=Math.max(60000,Number(process.env.ODDS_POLL_SECONDS||600)*1000);
const EVENTS_MS=Math.max(300000,Number(process.env.ODDS_EVENTS_REFRESH_MINUTES||30)*60000);
const LOOKAHEAD_HOURS=Math.max(1,Number(process.env.ODDS_LOOKAHEAD_HOURS||48));
const MAX_EVENTS=Math.min(10,Math.max(1,Number(process.env.ODDS_MAX_EVENTS||10)));
const STATE=path.resolve('.monitor-state.json');
const HISTORY=path.resolve('monitor-history.log');
if(!API_KEY)throw new Error('ODDS_API_KEY is not configured');
const state={eventsAt:0,events:{},prices:{},alerted:{}};
function save(){fs.writeFileSync(STATE,JSON.stringify(state,null,2)+'\n');}
function load(){try{const s=JSON.parse(fs.readFileSync(STATE,'utf8'));if(s&&s.lineMovement)Object.assign(state,s);}catch{}state.events=state.events||{};state.prices=state.prices||{};state.alerted=state.alerted||{};}
function hist(x){fs.appendFileSync(HISTORY,JSON.stringify({ts:new Date().toISOString(),...x})+'\n');}
async function get(endpoint,params={}){const u=new URL(`${BASE}/${endpoint}`);u.searchParams.set('apiKey',API_KEY);for(const[k,v]of Object.entries(params))if(v!==undefined&&v!==null&&v!=='')u.searchParams.set(k,String(v));const r=await fetch(u);const t=await r.text();if(!r.ok)throw new Error(`Odds API ${r.status}: ${t.slice(0,200)}`);return JSON.parse(t);}
function allowed(e){const t=Date.parse(e?.date||'');return e&&(!e.status||e.status==='pending')&&Number.isFinite(t)&&t>=Date.now()&&t<=Date.now()+LOOKAHEAD_HOURS*3600000;}
async function refresh(){if(Date.now()-state.eventsAt<EVENTS_MS&&Object.keys(state.events).length)return;const a=await get('events',{sport:SPORT,league:LEAGUE,status:'pending'});state.events={};for(const e of(Array.isArray(a)?a:[]).filter(allowed).sort((a,b)=>Date.parse(a.date)-Date.parse(b.date)).slice(0,MAX_EVENTS))state.events[e.id]={id:e.id,home:e.home,away:e.away,date:e.date,urls:e.urls||{},polymarketUrl:e.urls?.Polymarket||null};state.eventsAt=Date.now();save();console.log(`EVENTS ${Object.keys(state.events).length}`);}
function selected(m){for(const r of(Array.isArray(m?.odds)?m.odds:[])){if(r.hdp!==undefined&&Math.abs(Number(r.hdp)-LINE)>1e-9)continue;const p=Number(r[SELECTION]);if(Number.isFinite(p)&&p>1)return{price:p,line:r.hdp,updatedAt:m.updatedAt};}return null;}
function prices(payload){const out={};for(const b of BOOKMAKERS){const ms=Array.isArray(payload?.bookmakers?.[b])?payload.bookmakers[b]:[];const m=ms.find(x=>String(x?.name||'').toLowerCase()===MARKET.toLowerCase());const s=selected(m);if(s)out[b]=s;}return out;}
function move(a,b){return a>0?((b/a)-1)*100:null;}
function key(e){return`${e.id}|${MARKET}|${SELECTION}|${LINE}`;}
function msg(e,rows,avg){const s=['⚡ LINE MOVE','',`${e.home} — ${e.away}`,`Market: ${SELECTION==='over'?'Over':SELECTION==='under'?'Under':SELECTION} ${LINE}`,''];for(const r of rows)s.push(`${r.bookmaker.padEnd(10)} ${r.previous.toFixed(2)} → ${r.current.toFixed(2)}`);s.push('',`Move: ${avg>=0?'+':''}${avg.toFixed(1)}%`);if(e.polymarketUrl)s.push('',`➡️ MARKET · Polymarket`,e.polymarketUrl);return s.join('\n');}
async function poll(){await refresh();const events=Object.values(state.events);if(!events.length)return;const data=await get('odds/multi',{eventIds:events.map(e=>e.id).join(','),bookmakers:BOOKMAKERS.join(',')});const by=new Map((Array.isArray(data)?data:[]).map(e=>[String(e.id),e]));for(const e of events){const p=by.get(String(e.id));if(!p)continue;const k=key(e),now=prices(p),old=state.prices[k]||{},rows=[];for(const b of BOOKMAKERS){if(!now[b]||!old[b])continue;const mv=move(Number(old[b].price),Number(now[b].price));if(mv!==null&&mv<=-THRESHOLD)rows.push({bookmaker:b,previous:Number(old[b].price),current:Number(now[b].price),move:mv});}if(rows.length>=MIN_BOOKS&&!state.alerted[k]){const avg=rows.reduce((a,r)=>a+r.move,0)/rows.length;await sendTelegramMessage(msg(e,rows,avg));hist({type:'line_move_alert',eventId:e.id,home:e.home,away:e.away,market:MARKET,selection:SELECTION,line:LINE,movePercent:avg,bookmakers:rows,polymarketUrl:e.polymarketUrl});state.alerted[k]={sentAt:Date.now()};console.log(`LINE MOVE ALERT ${e.home} vs ${e.away} move=${avg.toFixed(1)}% polymarket=${e.polymarketUrl||'NONE'}`);}if(rows.length===0)delete state.alerted[k];state.prices[k]=now;}state.lineMovement=true;save();console.log(`POLL events=${events.length} books=${BOOKMAKERS.join(',')} threshold=-${THRESHOLD}%`);}
async function main(){load();console.log(`LINE MOVEMENT MONITOR STARTED sport=${SPORT} league=${LEAGUE} market=${MARKET} selection=${SELECTION} line=${LINE} books=${BOOKMAKERS.join(',')} poll=${POLL_MS/1000}s`);while(true){const t=Date.now();try{await poll();}catch(e){console.error(`LOOP FAILED: ${e.stack||e.message}`);}await new Promise(r=>setTimeout(r,Math.max(1000,POLL_MS-(Date.now()-t))));}}
main().catch(e=>{console.error(e);process.exitCode=1;});
