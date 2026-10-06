const fs = require("fs");
const path = require("path");
const http = require("http");

const VERSION = "1.0.0-SPORTS-ESPORTS-PRED-ELO";
const DATA_API = "https://data-api.polymarket.com";
const STATE_FILE = process.env.SPORTS_ELO_STATE_FILE || "/data/sports-elo-state.json";
const LOG_FILE = process.env.SPORTS_ELO_LOG_FILE || "/data/sports-elo.jsonl";
const HEALTH_PORT = Number(process.env.SPORTS_ELO_HEALTH_PORT || 8082);
const SCAN_MS = 10 * 60 * 1000;
const CANDIDATE_LIMIT = 25;
const CLOSED_LIMIT = 500;\nconst MAX_CLOSED_PAGES = 12;
const MIN_RESOLVED = 10;
const K = 32;
const START_ELO = 1500;
const seenTrades = new Set();

function now(){return new Date().toISOString();}
function ensure(file){fs.mkdirSync(path.dirname(file),{recursive:true});}
function log(event,data={}){const row={ts:now(),version:VERSION,event,...data};try{ensure(LOG_FILE);fs.appendFileSync(LOG_FILE,JSON.stringify(row)+"\n");}catch{}console.log(JSON.stringify(row));}
function load(){try{const s=JSON.parse(fs.readFileSync(STATE_FILE,"utf8"));if(s&&typeof s==="object")return s;}catch{}return{leader:null,leaders:{},lastScan:null,alertsSent:0};}
function save(){try{ensure(STATE_FILE);const t=STATE_FILE+".tmp";fs.writeFileSync(t,JSON.stringify(state,null,2));fs.renameSync(t,STATE_FILE);}catch(e){log("STATE_WRITE_ERROR",{error:String(e.message||e)});}}
let state=load();

const SPORTS_WORDS=/\\b(nfl|nba|wnba|ncaa|mlb|nhl|nfl|ufc|mma|pga|atp|wta|f1|formula.?1|nascar|motogp|cricket|rugby|golf|boxing|baseball|basketball|football|soccer|hockey|tennis|volleyball|fifa|uefa|premier.?league|champions.?league|la.?liga|serie.?a|bundesliga|ligue.?1|epl|mls|nbl|wnba|euroleague|olympics|wimbledon|us.?open|australian.?open|roland.?garros|masters|super.?bowl)\\b/i;
const ESPORTS_WORDS=/\\b(esports?|cs2|counter.?strike|valorant|dota.?2|league.?of.?legends|\\blol\\b|overwatch|rocket.?league|call.?of.?duty|rainbow.?six|r6|starcraft|tekken|street.?fighter|pubg|fortnite|apex.?legends|efootball|ea.?fc|fifa.?esports)\\b/i;
const SPORT_SLUG=/\\b(nfl|nba|wnba|mlb|nhl|ncaaf|ncaab|ufc|mma|atp|wta|f1|formula1|nascar|motogp|cricket|rugby|golf|boxing|soccer|football|hockey|tennis|volleyball|fifa|uefa|epl|mls|nbl|euroleague|olympics)\\b/i;
const ESPORT_SLUG=/\\b(esports?|cs2|counter-strike|valorant|dota-2|league-of-legends|lol|overwatch|rocket-league|call-of-duty|rainbow-six|r6|starcraft|tekken|street-fighter|pubg|fortnite|apex-legends)\\b/i;

function classify(row){
  const s=[row?.title,row?.slug,row?.eventSlug,row?.event_slug,row?.question].filter(Boolean).join(" ");
  if(ESPORTS_WORDS.test(s)||ESPORT_SLUG.test(s))return"ESPORTS";
  if(SPORTS_WORDS.test(s)||SPORT_SLUG.test(s))return"SPORTS";
  if(/\\bvs\\.?\\b|\\bversus\\b/i.test(s))return"SPORTS";
  return null;
}

async function getJson(url){
  const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error("HTTP "+r.status+" "+url);
  return r.json();
}

async function leaderboard(category,orderBy){
  const u=new URL(DATA_API+"/v1/leaderboard");
  u.searchParams.set("category",category);
  u.searchParams.set("timePeriod","ALL");
  u.searchParams.set("orderBy",orderBy);
  u.searchParams.set("limit",String(CANDIDATE_LIMIT));
  u.searchParams.set("offset","0");
  const data=await getJson(u);
  return Array.isArray(data)?data:[];
}

async function closedPositions(wallet){
  const all=[];
  for(let page=0;page<MAX_CLOSED_PAGES;page++){
    const u=new URL(DATA_API+"/closed-positions");
    u.searchParams.set("user",wallet);
    u.searchParams.set("limit",String(CLOSED_LIMIT));
    u.searchParams.set("offset",String(page*CLOSED_LIMIT));
    u.searchParams.set("sortBy","TIMESTAMP");
    u.searchParams.set("sortDirection","DESC");
    const data=await getJson(u);
    if(!Array.isArray(data)||!data.length)break;
    all.push(...data);
    if(data.length<CLOSED_LIMIT)break;
  }
  return all;
}

function scorePositions(rows){
  let elo=START_ELO,wins=0,total=0,longshotWins=0;
  const used=[];
  for(const p of rows){
    const category=classify(p);
    if(!category)continue;
    const price=Number(p.avgPrice);
    if(!Number.isFinite(price)||price<=0||price>=1)continue;
    const cur=Number(p.curPrice);
    const pnl=Number(p.realizedPnl);
    const actual=Number.isFinite(cur)&&cur>=0.999?1:Number.isFinite(cur)&&cur<=0.001?0:(pnl>0?1:pnl<0?0:null);
    if(actual===null)continue;
    const expected=price;
    elo+=K*(actual-expected);
    total++;
    if(actual===1){wins++;if(price<=0.30)longshotWins++;}
    used.push({key:String(p.conditionId||p.condition_id||"")+"|"+String(p.asset||p.token_id||"")+"|"+String(p.timestamp||""),price,actual,category});
  }
  return{elo,wins,total,winRate:total?wins/total:0,longshotWins,used};
}

function fmt(n,d=0){return Number.isFinite(Number(n))?Number(n).toFixed(d):"—";}
function calibratedElo(rawElo){
  const anchor=state.calibration&&Number.isFinite(Number(state.calibration.rawAnchorElo))
    ?Number(state.calibration.rawAnchorElo):null;
  if(anchor===null)return rawElo;
  return rawElo+(CALIBRATION_ANCHOR_ELO-anchor);
}

async function discover(){
  const [spPnl,spVol,esPnl,esVol]=await Promise.all([
    leaderboard("SPORTS","PNL"),
    leaderboard("SPORTS","VOL"),
    leaderboard("ESPORTS","PNL").catch(()=>[]),
    leaderboard("ESPORTS","VOL").catch(()=>[])
  ]);
  const map=new Map();
  for(const [rows,cat,order] of [[spPnl,"SPORTS","PNL"],[spVol,"SPORTS","VOL"],[esPnl,"ESPORTS","PNL"],[esVol,"ESPORTS","VOL"]]){
    for(const r of rows){
      const wallet=String(r.proxyWallet||"").toLowerCase();
      if(!/^0x[a-f0-9]{40}$/.test(wallet))continue;
      const x=map.get(wallet)||{wallet,userName:r.userName||wallet,categories:new Set(),ranks:[]};
      x.categories.add(cat);x.ranks.push({category:cat,order,rank:Number(r.rank)||null,pnl:Number(r.pnl)||0,vol:Number(r.vol)||0});
      map.set(wallet,x);
    }
  }
  return [...map.values()];
}

async function evaluate(candidates){
  const out=[];
  for(const c of candidates){
    try{
      const rows=await closedPositions(c.wallet);
      const score=scorePositions(rows);
      if(score.total<MIN_RESOLVED)continue;
      out.push({...c,...score});
      state.leaders[c.wallet]={
        wallet:c.wallet,userName:c.userName,elo:score.elo,wins:score.wins,total:score.total,
        winRate:score.winRate,longshotWins:score.longshotWins,categories:[...c.categories],updatedAt:now()
      };
    }catch(e){log("CANDIDATE_ERROR",{wallet:c.wallet,error:String(e.message||e)});}
  }
  const anchor=out.find(x=>x.wallet===CALIBRATION_ANCHOR_WALLET);
  if(anchor){
    state.calibration={
      anchorWallet:CALIBRATION_ANCHOR_WALLET,
      targetElo:CALIBRATION_ANCHOR_ELO,
      targetWinRate:CALIBRATION_ANCHOR_WIN_RATE,
      targetResolved:CALIBRATION_ANCHOR_RESOLVED,
      rawAnchorElo:anchor.elo,
      offset:CALIBRATION_ANCHOR_ELO-anchor.elo,
      measuredWinRate:anchor.winRate,
      measuredResolved:anchor.total,
      updatedAt:now()
    };
    for(const x of out)x.elo=calibratedElo(x.elo);
  }else{
    log("CALIBRATION_ANCHOR_NOT_FOUND",{wallet:CALIBRATION_ANCHOR_WALLET});
  }
  out.sort((a,b)=>b.elo-a.elo);
  return out;
}

async function recentTrades(wallet){
  const u=new URL(DATA_API+"/v2/trades");
  u.searchParams.set("user",wallet);
  u.searchParams.set("limit","100");
  const body=await getJson(u);
  return Array.isArray(body?.data)?body.data:[];
}

async function sendTelegram(text){
  const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chat){log("TELEGRAM_NOT_CONFIGURED");return false;}
  try{
    const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,text}),signal:AbortSignal.timeout(8000)});
    if(!r.ok){log("TELEGRAM_ERROR",{status:r.status,body:(await r.text()).slice(0,500)});return false;}
    return true;
  }catch(e){log("TELEGRAM_ERROR",{error:String(e.message||e)});return false;}
}

async function scan(){
  const candidates=await discover();
  const ranked=await evaluate(candidates);
  if(!ranked.length){log("NO_ELIGIBLE_LEADER",{candidateCount:candidates.length,minResolved:MIN_RESOLVED});return;}
  const leader=ranked[0];
  const previous=state.leader;
  const changed=!previous||String(previous.wallet).toLowerCase()!==leader.wallet;
  if(changed){
    const text=[
      "🏆 SPORTS / ESPORTS PRED-ELO LEADER",
      "NEW: "+leader.userName,
      "ELO: "+fmt(leader.elo),
      "WIN RATE: "+fmt(leader.winRate*100,1)+"%",
      "RESOLVED: "+leader.total,
      "LONGSHOT WINS: "+leader.longshotWins,
      "CATEGORY: "+[...leader.categories].join(" / "),
      "WALLET: "+leader.wallet
    ].join("\n");
    if(await sendTelegram(text))state.alertsSent=Number(state.alertsSent||0)+1;
    log("LEADER_CHANGED",{old:previous?.wallet||null,new:leader.wallet,userName:leader.userName,elo:leader.elo,total:leader.total});
  }
  state.leader={wallet:leader.wallet,userName:leader.userName,elo:leader.elo,wins:leader.wins,total:leader.total,winRate:leader.winRate,longshotWins:leader.longshotWins,categories:[...leader.categories],updatedAt:now()};
  try{
    const trades=await recentTrades(leader.wallet);
    for(const t of trades.reverse()){
      const id=String(t.id||t.transaction_hash||t.transactionHash||"")+":"+String(t.timestamp||t.block_timestamp||"")+":"+String(t.asset||t.asset_id||"");
      if(!id||seenTrades.has(id))continue;
      seenTrades.add(id);
      const cat=classify(t);
      if(!cat)continue;
      const side=String(t.side||"").toUpperCase();
      const outcome=t.outcome||"";
      const price=Number(t.price);
      const size=Number(t.size||t.usdcSize||t.usdc_size);
      const text=[
        "🎯 ELO LEADER BET",
        leader.userName,
        "ELO: "+fmt(leader.elo),
        cat,
        t.title||t.event_slug||t.eventSlug||"Polymarket market",
        (outcome?outcome+" ":"")+(side||""),
        Number.isFinite(price)?"PRICE: "+price.toFixed(3):"PRICE: —",
        Number.isFinite(size)?"SIZE: $"+size.toFixed(2):"SIZE: —",
        t.event_slug?"https://polymarket.com/event/"+t.event_slug:""
      ].filter(Boolean).join("\n");
      if(await sendTelegram(text))state.alertsSent=Number(state.alertsSent||0)+1;
      log("LEADER_TRADE_ALERT",{wallet:leader.wallet,category:cat,title:t.title||null,side,outcome,price,size});
    }
    while(seenTrades.size>1000)seenTrades.delete(seenTrades.values().next().value);
  }catch(e){log("TRADE_SCAN_ERROR",{wallet:leader.wallet,error:String(e.message||e)});}
  state.lastScan=now();save();
  log("SCAN_COMPLETE",{candidateCount:candidates.length,eligible:ranked.length,leader:leader.userName,elo:leader.elo,total:leader.total});
}

function startHealth(){
  const server=http.createServer((req,res)=>{
    const p=String(req.url||"/").split("?")[0];
    if(p==="/"||p==="/health"||p==="/status"||p==="/stats"){
      res.writeHead(200,{"content-type":"application/json","cache-control":"no-store"});
      return res.end(JSON.stringify({status:"ok",version:VERSION,lastScan:state.lastScan,leader:state.leader,trackedLeaders:Object.keys(state.leaders).length,alertsSent:state.alertsSent,scanIntervalMs:SCAN_MS,source:DATA_API,scope:["SPORTS","ESPORTS"]}));
    }
    res.writeHead(404);res.end();
  });
  server.listen(HEALTH_PORT,"0.0.0.0",()=>log("HEALTH_LISTENING",{port:HEALTH_PORT}));
}

async function main(){
  log("SPORTS_ELO_MONITOR_STARTING",{version:VERSION,scope:["SPORTS","ESPORTS"],algorithm:"ELO_START_1500_K32_EXPECTED_PRICE_CALIBRATED_TO_ROBERTO73",candidateLimit:CANDIDATE_LIMIT,minResolved:MIN_RESOLVED,calibrationAnchor:CALIBRATION_ANCHOR_WALLET,targetElo:CALIBRATION_ANCHOR_ELO,targetWinRate:CALIBRATION_ANCHOR_WIN_RATE,targetResolved:CALIBRATION_ANCHOR_RESOLVED});
  startHealth();
  try{await scan();}catch(e){log("SCAN_ERROR",{error:String(e.stack||e)});}
  setInterval(async()=>{try{await scan();}catch(e){log("SCAN_ERROR",{error:String(e.stack||e)});}},SCAN_MS);
}
main();
