const LIVE_URL="https://sportscore.com/api/v1/fixtures/?sport=football&status=live&limit=200";
const POLY_BASE="https://gamma-api.polymarket.com/events?active=true&closed=false&live=true&limit=500";
const TRACKER_URL="https://sportscore.com/api/widget/tracker/";
const DETAIL_URL="https://sportscore.com/api/widget/match/";
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const norm=s=>String(s??"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").replace(/\b(fc|afc|cf|sc|ac|club|women|w|u19|u20|u21|u23)\b/g," ").replace(/\s+/g," ").trim();
const sim=(a,b)=>{const A=new Set(norm(a).split(" ").filter(x=>x.length>2)),B=new Set(norm(b).split(" ").filter(x=>x.length>2));if(!A.size||!B.size)return 0;let n=0;for(const x of A)if(B.has(x))n++;return n/Math.max(A.size,B.size)};
async function json(url,params){let last;for(let i=0;i<3;i++){try{const u=new URL(url);if(params)for(const [k,v] of Object.entries(params))u.searchParams.set(k,v);const r=await fetch(u,{headers:{accept:"application/json","user-agent":"live-football-monitor/1.0"},signal:AbortSignal.timeout(6000)});console.log("HTTP",r.status,u.toString());if(r.ok)return await r.json();last=new Error("HTTP "+r.status);if(![429,500,502,503,504].includes(r.status))break}catch(e){last=e}await sleep(400)}throw last||new Error("request failed")}
function val(v){if(v==null)return null;if(typeof v==="number"||typeof v==="string")return v;if(typeof v==="object")return v.current??v.display??v.value??v.goals??v.score??null;return null}
function scoreAny(o){if(!o||typeof o!=="object")return "—";for(const [h,a] of [[o.home_score,o.away_score],[o.homeScore,o.awayScore],[o.home?.score,o.away?.score],[o.home?.goals,o.away?.goals],[o.score?.home,o.score?.away],[o.scores?.home,o.scores?.away]]){const x=val(h),y=val(a);if(x!=null&&y!=null&&/^\d+$/.test(String(x))&&/^\d+$/.test(String(y)))return x+"–"+y}const s=o.score??o.result??o.current_score;if(typeof s==="string"&&/^\s*\d+\s*[-–:]\s*\d+\s*$/.test(s))return s.replace(/[-:]/g,"–");return "—"}
function minuteAny(v){if(v==null)return null;if(typeof v==="number"&&Number.isFinite(v)&&v>=0&&v<=130)return Math.floor(v);const s=String(v).trim();let m=s.match(/(?:2H|1H|HT)\s*[-–:]\s*(\d{1,3})/i)||s.match(/(?:^|\b)(\d{1,3})\s*(?:[:'′]|min|minute)/i);if(m)return Number(m[1]);if(/^\d{1,3}$/.test(s)&&Number(s)<=130)return Number(s);return null}
function deepLive(root,out=[]){if(root==null)return out;if(Array.isArray(root)){for(const x of root)deepLive(x,out);return out}if(typeof root!=="object")return out;const h=root.home?.name??root.homeTeam?.name??root.homeTeamName??root.home,a=root.away?.name??root.awayTeam?.name??root.awayTeamName??root.away,st=root.status;const live=root.live===true||root.isLive===true||(typeof st==="string"&&/live|in.?progress|halftime|break/i.test(st))||(typeof root.status_text==="string"&&/live|\d+\s*(?:min|minute|\')/i.test(root.status_text));if(h&&a&&live)out.push({home:String(h),away:String(a),score:scoreAny(root),minute:minuteAny(root.elapsed??root.minute??root.currentMinute??root.gameMinute??root.clockMinute??root.clock??root.matchTime??root.status_text??root.period),id:String(root.id??root.matchId??root.fixtureId??root.gameId??""),slug:String(root.slug??root.matchSlug??root.fixtureSlug??"")});for(const v of Object.values(root))if(v&&typeof v==="object")deepLive(v,out);return out}
function teams(e){const a=[];const add=v=>{if(typeof v==="string"&&v.trim())a.push(v.trim());else if(v&&typeof v==="object"&&v.name)a.push(String(v.name))};for(const k of ["homeTeam","awayTeam","home","away","homeTeamName","awayTeamName"])add(e[k]);if(a.length>=2)return [a[0],a[1]];const t=String(e.title??e.name??"");const p=t.split(/\s+(?:vs\.?|v\.?|versus)\s+/i);return p.length===2?p.map(x=>x.trim()):null}
function eventScore(e){const s=e?.score;if(typeof s==="string"&&/^\s*\d+\s*[-–:]\s*\d+\s*$/.test(s))return s.replace(/[-:]/g,"–");if(s&&typeof s==="object"&&s.home!=null&&s.away!=null)return s.home+"–"+s.away;return "—"}
function findTracker(root,out=[]){if(root==null)return out;if(Array.isArray(root)){for(const x of root)findTracker(x,out);return out}if(typeof root!=="object")return out;const minute=minuteAny(root.elapsed??root.minute??root.currentMinute??root.gameMinute??root.clockMinute??root.clock??root.matchTime??root.status_text??root.period);const score=scoreAny(root);if(minute!=null||score!=="—")out.push({minute,score,period:root.period??root.status??null,raw:root});for(const v of Object.values(root))if(v&&typeof v==="object")findTracker(v,out);return out}
function findDetail(root,out=[]){if(root==null)return out;if(Array.isArray(root)){for(const x of root)findDetail(x,out);return out}if(typeof root!=="object")return out;const minute=minuteAny(root.elapsed??root.minute??root.currentMinute??root.gameMinute??root.clockMinute??root.matchTime??root.status_text??root.period??root.clock);const score=scoreAny(root);const period=typeof root.period==="string"?root.period:(typeof root.status_text==="string"?root.status_text:null);if(minute!=null||score!=="—"||period)out.push({minute,score,period,raw:root});for(const v of Object.values(root))if(v&&typeof v==="object")findDetail(v,out);return out}
async function detail(slug){if(!slug)return null;try{const d=await json(DETAIL_URL,{sport:"football",slug});const all=findDetail(d);const explicit=all.filter(x=>x.minute!=null);const hit=explicit.find(x=>x.period&&/2H|1H|HT|ET|AET/i.test(String(x.period)))||explicit[explicit.length-1]||all.find(x=>x.score!=="—");console.log("DETAIL_RESULT",JSON.stringify(hit??null));return hit??null}catch(e){console.log("DETAIL_ERROR",String(e));return null}}
async function tracker(id){if(!id)return null;try{const d=await json(TRACKER_URL,{sport:"football",id});const all=findTracker(d);const hit=all.find(x=>x.minute!=null)||all.find(x=>x.score!=="—");console.log("TRACKER_RESULT",JSON.stringify(hit??null));return hit??null}catch(e){console.log("TRACKER_ERROR",String(e));return null}}
async function telegram(text){const token=process.env.TELEGRAM_BOT_TOKEN,chat=process.env.TELEGRAM_CHAT_ID;if(!token||!chat)throw Error("Telegram secrets missing");const r=await fetch("https://api.telegram.org/bot"+token+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,parse_mode:"HTML",text})});const j=await r.json();console.log("TELEGRAM_RESPONSE",JSON.stringify(j));if(!j.ok)throw Error("Telegram rejected")}
const esc=s=>String(s??"—").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const seen=new Set();
for(let cycle=1;cycle<=8;cycle++){
 console.log("MONITOR_CYCLE",cycle);
 try{
  const [ld,p1,p2]=await Promise.all([json(LIVE_URL),json(POLY_BASE+"&tag_slug=soccer").catch(()=>[]),json(POLY_BASE+"&tag_slug=football").catch(()=>[])]);
  const live=deepLive(ld),events=[...(Array.isArray(p1)?p1:p1.events??[]),...(Array.isArray(p2)?p2:p2.events??[])];
  const unique=[...new Map(events.map(e=>[String(e.id),e])).values()];
  console.log("LIVE_COUNT",live.length,"POLY_EVENT_COUNT",unique.length);
  let found=null;
  for(const l of live)for(const e of unique){const p=teams(e);if(!p)continue;const s=Math.max(sim(l.home,p[0])+sim(l.away,p[1]),sim(l.home,p[1])+sim(l.away,p[0]));if(s>=1.25&&(!found||s>found.s))found={l,e,s}}
  if(found){
   console.log("MATCH_FOUND",JSON.stringify({home:found.l.home,away:found.l.away,sportScoreId:found.l.id,sportScoreMinute:found.l.minute,sportScoreScore:found.l.score,polyId:found.e.id,slug:found.e.slug,match:found.s}));
   const d=await detail(found.e.slug);\n   const t=d??await tracker(found.l.id);
   const minute=t?.minute!=null?String(t.minute):(found.l.minute!=null?String(found.l.minute):"—");
   const score=t?.score!=="—"?t.score:(found.l.score!=="—"?found.l.score:eventScore(found.e));
   console.log("FINAL_LIVE",JSON.stringify({minute,score,source:d?"SportScore match detail":t?"SportScore tracker":"SportScore live"}));
   const key=String(found.e.id);
   if(!seen.has(key)){
    const link=found.e.slug?"https://polymarket.com/event/"+found.e.slug:"https://polymarket.com/sports/soccer";
    await telegram("⚽ <b>LIVE FOUND</b>\n\n"+esc(found.l.home)+" vs "+esc(found.l.away)+"\nLIVE\nMINUTE: "+esc(minute)+"\nSCORE: "+esc(score)+"\n\n<a href=\""+link+"\">ОТКРЫТЬ POLYMARKET</a>");
    seen.add(key);
   }
  }else console.log("NO_POLY_MATCH");
 }catch(e){console.log("CYCLE_ERROR",String(e?.stack??e))}
 if(cycle<8)await sleep(30000);
}