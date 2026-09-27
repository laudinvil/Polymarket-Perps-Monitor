const LIVE_URL="https://sportscore.com/api/v1/fixtures/?sport=football&status=live&limit=200";
const POLY_BASE="https://gamma-api.polymarket.com/events?active=true&closed=false&live=true&limit=500";
const SPORTSCORE_MATCH="https://sportscore.com/api/widget/match/?sport=football&slug=";
const WS_URL="wss://sports-api.polymarket.com/ws";

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const norm=s=>String(s??"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").replace(/\b(fc|afc|cf|sc|ac|club|women|w|u19|u20|u21|u23)\b/g," ").replace(/\s+/g," ").trim();
const sim=(a,b)=>{
  const A=new Set(norm(a).split(" ").filter(x=>x.length>2));
  const B=new Set(norm(b).split(" ").filter(x=>x.length>2));
  if(!A.size||!B.size)return 0;
  let n=0; for(const x of A)if(B.has(x))n++;
  return n/Math.max(A.size,B.size);
};
async function json(url){
  let last;
  for(let i=0;i<3;i++){
    try{
      const r=await fetch(url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(10000)});
      console.log("HTTP",r.status,url);
      if(r.ok)return await r.json();
      last=new Error("HTTP "+r.status);
      if(![429,500,502,503,504].includes(r.status))break;
    }catch(e){last=e}
    await sleep(1000*(i+1));
  }
  throw last||new Error("request failed");
}
function value(v){
  if(v==null)return null;
  if(typeof v==="number"||typeof v==="string")return v;
  if(typeof v==="object")return v.current??v.display??v.value??v.goals??v.score??v.total??null;
  return null;
}
function parseMinute(v){
  if(v==null)return null;
  if(typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=130)return Math.floor(v);
  const s=String(v).trim();
  let m=s.match(/(?:^|\b)(\d{1,3})\s*(?:[:'′]|min|minute)/i);
  if(m)return Number(m[1]);
  m=s.match(/(?:2H|1H|HT)\s*[-–:]\s*(\d{1,3})/i);
  if(m)return Number(m[1]);
  if(/^\d{1,3}$/.test(s)){
    const n=Number(s); if(n>=0&&n<=130)return n;
  }
  return null;
}
function scoreFromAny(root){
  if(!root||typeof root!=="object")return "—";
  const pairs=[
    [root.home_score,root.away_score],[root.homeScore,root.awayScore],
    [root.home?.score,root.away?.score],[root.home?.goals,root.away?.goals],
    [root.score?.home,root.score?.away],[root.scores?.home,root.scores?.away]
  ];
  for(const [h,a] of pairs){
    const hh=value(h),aa=value(a);
    if(hh!=null&&aa!=null&&/^\d+$/.test(String(hh))&&/^\d+$/.test(String(aa)))return String(hh)+"–"+String(aa);
  }
  const s=root.score??root.result??root.current_score;
  if(typeof s==="string"&&/^\s*\d+\s*[-–:]\s*\d+\s*$/.test(s))return s.replace(/[-:]/g,"–");
  return "—";
}
function extractLive(root,out=[]){
  if(root==null)return out;
  if(Array.isArray(root)){for(const x of root)extractLive(x,out);return out}
  if(typeof root!=="object")return out;
  const h=root.home?.name??root.homeTeam?.name??root.homeTeamName??root.home;
  const a=root.away?.name??root.awayTeam?.name??root.awayTeamName??root.away;
  const st=root.status;
  const live=root.live===true||root.isLive===true||(typeof st==="string"&&/live|in.?progress|halftime|break/i.test(st))||(typeof root.status_text==="string"&&/live|\d+\s*(?:min|minute|\')/i.test(root.status_text));
  const finished=st&&typeof st==="object"?st.finished===true:false;
  if(h&&a&&live&&!finished){
    const candidates=[
      root.status_text,root.statusText,root.elapsed,root.minute,root.currentMinute,
      root.gameMinute,root.clockMinute,root.clock,root.matchTime,root.time,
      root.period
    ];
    let minute=null;
    for(const c of candidates){const n=parseMinute(c);if(n!=null){minute=n;break}}
    out.push({
      home:String(h),away:String(a),
      score:scoreFromAny(root),
      minute,
      slug:String(root.slug??root.matchSlug??root.fixtureSlug??""),
      id:String(root.id??root.matchId??root.fixtureId??""),
      statusText:String(root.status_text??root.statusText??"")
    });
  }
  for(const v of Object.values(root))if(v&&typeof v==="object")extractLive(v,out);
  return out;
}
function eventTeams(e){
  const names=[];
  const add=v=>{
    if(typeof v==="string"&&v.trim())names.push(v.trim());
    else if(v&&typeof v==="object"){
      const n=v.name??v.teamName??v.title;
      if(typeof n==="string"&&n.trim())names.push(n.trim());
    }
  };
  add(e.homeTeam);add(e.awayTeam);add(e.home);add(e.away);add(e.homeTeamName);add(e.awayTeamName);
  if(Array.isArray(e.teams))for(const t of e.teams)add(t);
  const u=[...new Set(names)];
  if(u.length>=2)return [u[0],u[1]];
  const title=String(e.title??e.name??"");
  const q=(Array.isArray(e.markets)?e.markets:[]).map(m=>String(m.question??m.title??"")).find(x=>/\s+(?:vs\.?|v\.?|versus)\s+/i.test(x));
  const p=(q||title).split(/\s+(?:vs\.?|v\.?|versus)\s+/i);
  return p.length===2?[p[0].trim(),p[1].trim()]:null;
}
function gameId(e){
  if(e?.gameId!=null)return String(e.gameId);
  for(const m of Array.isArray(e?.markets)?e.markets:[])if(m?.gameId!=null)return String(m.gameId);
  return "";
}
function scoreFromEvent(e){
  const s=e?.score;
  if(typeof s==="string"&&/^\s*\d+\s*[-–:]\s*\d+\s*$/.test(s))return s.replace(/[-:]/g,"–");
  if(s&&typeof s==="object"){
    const h=s.home??s.homeScore??s.currentHome;
    const a=s.away??s.awayScore??s.currentAway;
    if(h!=null&&a!=null)return String(h)+"–"+String(a);
  }
  return "—";
}
function parseSportsRows(rows){
  const out=[];
  for(const d of rows){
    if(!d||typeof d!=="object")continue;
    if(d.type==="sport_result"||d.gameId!=null||d.slug){
      const minute=parseMinute(d.elapsed??d.minute??d.clock??d.period);
      out.push({gameId:d.gameId!=null?String(d.gameId):"",slug:String(d.slug??"").toLowerCase(),home:String(d.homeTeam??d.home??""),away:String(d.awayTeam??d.away??""),score:d.score??null,period:d.period??null,status:d.status??null,minute});
    }
  }
  return out;
}
async function sportsSnapshot(){
  return new Promise(resolve=>{
    const rows=[];
    let ws=null,done=false;
    const finish=()=>{if(done)return;done=true;try{ws?.close()}catch{};resolve(parseSportsRows(rows))};
    try{
      ws=new WebSocket(WS_URL);
      const timer=setTimeout(finish,5000);
      ws.onmessage=ev=>{
        try{
          const raw=String(ev.data??"");
          if(raw==="ping"){ws.send("pong");return}
          const d=JSON.parse(raw);
          if(d&&typeof d==="object")rows.push(d);
        }catch{}
      };
      ws.onerror=()=>{clearTimeout(timer);finish()};
      ws.onclose=()=>{clearTimeout(timer);finish()};
    }catch{finish()}
  });
}
function wsFor(e,rows){
  const gid=gameId(e),slug=String(e?.slug??"").toLowerCase();
  return rows.find(x=>(gid&&x.gameId===gid)||(slug&&x.slug===slug))??null;
}
function sportScoreFor(live){
  if(!live?.slug)return null;
  return json(SPORTSCORE_MATCH+encodeURIComponent(live.slug)).catch(()=>null);
}
function detailExtract(root){
  const candidates=[];
  const walk=v=>{
    if(v==null)return;
    if(Array.isArray(v)){for(const x of v)walk(x);return}
    if(typeof v!=="object")return;
    const minute=parseMinute(v.status_text??v.statusText??v.elapsed??v.minute??v.currentMinute??v.clockMinute??v.clock??v.matchTime??v.period);
    const score=scoreFromAny(v);
    if(minute!=null||score!=="—")candidates.push({minute,score,statusText:v.status_text??v.statusText??null,period:v.period??v.status??null});
    for(const x of Object.values(v))if(x&&typeof x==="object")walk(x);
  };
  walk(root);
  return candidates.find(x=>x.minute!=null)||candidates.find(x=>x.score!=="—")||null;
}
async function sendTelegram(text){
  const token=process.env.TELEGRAM_BOT_TOKEN;
  const chat=process.env.TELEGRAM_CHAT_ID;
  if(!token||!chat)throw new Error("Telegram secrets missing");
  const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,parse_mode:"HTML",text})});
  const j=await r.json();
  console.log("TELEGRAM_RESPONSE",JSON.stringify(j));
  if(!j.ok)throw new Error("Telegram rejected");
}
const esc=s=>String(s??"—").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");

const seen=new Set();
for(let cycle=1;cycle<=8;cycle++){
  console.log("MONITOR_CYCLE",cycle);
  try{
    const [ld,polySports]=await Promise.all([json(LIVE_URL),sportsSnapshot()]);
    const live=extractLive(ld);
    const pages=await Promise.all(["soccer","football"].map(async tag=>{
      try{
        const p=await json(POLY_BASE+"&tag_slug="+encodeURIComponent(tag));
        return Array.isArray(p)?p:(p.events??[]);
      }catch{return[]}
    }));
    const events=[...new Map(pages.flat().map(e=>[String(e.id),e])).values()];
    console.log("LIVE_COUNT",live.length);
    console.log("POLY_EVENT_COUNT",events.length);
    console.log("POLY_SPORTS_WS_COUNT",polySports.length);
    console.log("POLY_SPORTS_WS_SAMPLE",JSON.stringify(polySports.slice(0,5)));

    let found=null;
    for(const l of live){
      for(const e of events){
        const p=eventTeams(e); if(!p)continue;
        const s=Math.max(sim(l.home,p[0])+sim(l.away,p[1]),sim(l.home,p[1])+sim(l.away,p[0]));
        if(s<1.25)continue;
        if(!found||s>found.matchScore)found={l:{...l},e,matchScore:s};
      }
    }

    if(found){
      const ws=wsFor(found.e,polySports);
      let detail=null;
      if(found.l.slug)detail=detailExtract(await sportScoreFor(found.l));
      const minute=detail?.minute!=null?String(detail.minute):(ws?.minute!=null?String(ws.minute):(found.l.minute!=null?String(found.l.minute):"—"));
      const score=detail?.score!=="—"?detail.score:(ws?.score&&/^\s*\d+\s*[-–:]\s*\d+\s*$/.test(String(ws.score))?String(ws.score).replace(/[-:]/g,"–"):(found.l.score!=="—"?found.l.score:scoreFromEvent(found.e)));
      console.log("SPORTSCORE_LIVE",JSON.stringify(found.l));
      console.log("SPORTSCORE_DETAIL",JSON.stringify(detail));
      console.log("POLY_SPORTS_MATCH",JSON.stringify(ws));
      console.log("BEST_MATCH",JSON.stringify({home:found.l.home,away:found.l.away,matchScore:found.matchScore,id:found.e.id,slug:found.e.slug,gameId:gameId(found.e),minute,score,period:ws?.period??found.e.period??null}));
      const key=String(found.e.id);
      if(!seen.has(key)){
        const link=found.e.slug?"https://polymarket.com/event/"+found.e.slug:"https://polymarket.com/sports/soccer";
        const text="⚽ <b>LIVE FOUND</b>\n\n"+esc(found.l.home)+" vs "+esc(found.l.away)+"\nLIVE\nMINUTE: "+esc(minute)+"\nSCORE: "+esc(score)+"\n\n<a href=\""+esc(link)+"\">ОТКРЫТЬ POLYMARKET</a>";
        await sendTelegram(text);
        seen.add(key);
      }else console.log("SKIP_SEEN",key);
    }else{
      console.log("NO_POLY_MATCH");
    }
  }catch(e){
    console.log("CYCLE_ERROR",String(e?.stack??e));
  }
  if(cycle<8)await sleep(30000);
}
