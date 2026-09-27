const LIVE_URL = "https://sportscore.com/api/v1/fixtures/?sport=football&status=live&limit=200";
const POLY_URL = "https://gamma-api.polymarket.com/events?active=true&closed=false&tag_slug=soccer&limit=500";
const norm=s=>String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/&/g," and ").replace(/[^a-z0-9]+/g," ").replace(/\b(fc|afc|cf|sc|ac|club|women|w|u19|u20|u21|u23)\b/g," ").replace(/\s+/g," ").trim();
const esc=s=>String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
const sim=(a,b)=>{const A=new Set(norm(a).split(" ").filter(x=>x.length>2)),B=new Set(norm(b).split(" ").filter(x=>x.length>2));if(!A.size||!B.size)return 0;let h=0;for(const x of A)if(B.has(x))h++;return h/Math.max(A.size,B.size)};
const startMs=o=>{const v=o?.startTime??o?.start_time??o?.startDate??o?.start_date??o?.startsAt??o?.starts_at??o?.commenceTime??o?.commence_time??o?.start??o?.start_at??o?.startAt??o?.date??o?.datetime;if(v==null)return null;const n=Number(v);if(Number.isFinite(n))return n<1e12?n*1000:n;const d=Date.parse(String(v));return Number.isFinite(d)?d:null};
const minuteKey=ms=>ms==null?null:Math.floor(ms/60000);
const extract=(n,o=[])=>{if(!n||typeof n!=="object")return o;if(Array.isArray(n)){for(const x of n)extract(x,o);return o}const h=n.home?.name||n.homeTeam?.name||n.homeTeamName||n.home,a=n.away?.name||n.awayTeam?.name||n.awayTeamName||n.away,st=n.status,so=st&&typeof st==="object"?st:{},live=n.live===true||n.isLive===true||(typeof st==="string"&&/live|in.?progress|halftime|break/i.test(st)),started=so.started===true||n.started===true,finished=so.finished===true||n.finished===true;if(h&&a&&!finished&&(live||started)){const scoreVal=v=>{if(v==null)return null;if(typeof v==="number"||typeof v==="string")return v;if(typeof v==="object")return v.current??v.display??v.value??v.goals??v.score??v.total??v.regular??v.home??null;return null}; const sh=scoreVal(n.home?.score)??scoreVal(n.homeScore)??scoreVal(n.score?.home)??scoreVal(n.scoreHome)??scoreVal(n.scores?.home)??scoreVal(n.home?.goals)??scoreVal(n.home?.points)??scoreVal(n.home?.currentScore),sa=scoreVal(n.away?.score)??scoreVal(n.awayScore)??scoreVal(n.score?.away)??scoreVal(n.scoreAway)??scoreVal(n.scores?.away)??scoreVal(n.away?.goals)??scoreVal(n.away?.points)??scoreVal(n.away?.currentScore);const raw=n.liveMinute??n.gameMinute??so.minute??so.liveMinute??so.gameMinute??"—";const sm=startMs(n);const minute=raw;o.push({home:String(h),away:String(a),score:sh!=null&&sa!=null?sh+"–"+sa:"—",minute:String(minute),startMs:sm,slug:String(n.slug??n.matchSlug??n.fixtureSlug??"")});return o}for(const v of Object.values(n))extract(v,o);return o};
const json=async u=>{let last;for(let i=0;i<4;i++){try{const r=await fetch(u,{headers:{accept:"application/json"},signal:AbortSignal.timeout(15000)});console.log("HTTP",r.status,u);if(r.ok)return r.json();last=Error(u+" HTTP "+r.status);if(![429,500,502,503,504].includes(r.status))throw last;}catch(e){last=e}if(i<3)await new Promise(r=>setTimeout(r,1500*(i+1)))}throw last};
const ld=await json(LIVE_URL),live=extract(ld);
const base="https://gamma-api.polymarket.com/events?active=true&closed=false&limit=500";
const unwrap=x=>Array.isArray(x)?x:(x&&Array.isArray(x.data)?x.data:(x&&Array.isArray(x.tags)?x.tags:(x&&Array.isArray(x.series)?x.series:[])));
const safeJson=async u=>{try{return await json(u)}catch(e){console.log("POLY_DISCOVERY_ERROR",u,String(e));return null}};
const tagData=await safeJson("https://gamma-api.polymarket.com/tags?limit=1000");
const sportsData=await safeJson("https://gamma-api.polymarket.com/sports");
const seriesData=await safeJson("https://gamma-api.polymarket.com/series?limit=1000");
const allTags=unwrap(tagData), allSports=unwrap(sportsData), allSeries=unwrap(seriesData);
const slugOf=x=>String(x?.slug??x?.leagueSlug??x?.seriesSlug??x?.tagSlug??"").trim().toLowerCase();
const footballWords=/soccer|football|premier|league|laliga|la liga|serie a|bundesliga|ligue|championship|liga|cup|eredivisie|super lig|primeira|jupiler|mls|brasileirao|argentina|mexico|china|korea|japan|australia|scotland|spain|italy|germany|france|england|turkey|portugal|netherlands|belgium|denmark|sweden|norway|poland|greece|austria|switzerland|ireland|czech|croatia|serbia|ukraine|romania|colombia|ecuador|peru|chile|uruguay|paraguay|bolivia|venezuela/i;
const footballTags=allTags.filter(t=>{const s=slugOf(t),label=String(t?.label??t?.name??"");return s==="soccer"||footballWords.test(s+" "+label);});
const footballSeries=allSeries.filter(s=>{const v=JSON.stringify(s);return footballWords.test(v)&&slugOf(s);});
const leagueSlugs=[...new Set([...footballTags,...footballSeries].map(slugOf).filter(s=>s&&s!=="soccer"&&s!=="football"))];
console.log("POLY_DISCOVERY",JSON.stringify({tags:footballTags.length,series:footballSeries.length,leagueSlugsCount:leagueSlugs.length,leagueSlugs:leagueSlugs.slice(0,200)}));
const discoveredTags=[...new Set(["soccer",...leagueSlugs])];
const pages=[];
for(let i=0;i<discoveredTags.length;i+=5){
  const batch=discoveredTags.slice(i,i+5);
  const got=await Promise.all(batch.map(async tag=>{try{const p=await json(base+"&tag_slug="+encodeURIComponent(tag));return Array.isArray(p)?p:(p?.events||[])}catch(e){console.log("POLY_TAG_ERROR",tag,String(e));return[]}}));
  pages.push(...got);
}
const events=[...new Map(pages.flat().filter(e=>e&&e.id!=null).map(e=>[String(e.id),e])).values()];
console.log("POLY_EVENTS_BY_TAG",JSON.stringify({requestedTags:discoveredTags.length,events:events.length}));
console.log("LIVE_COUNT",live.length); console.log("LIVE_SAMPLE",JSON.stringify(live.slice(0,10))); const sports=events.filter(e=>e.sport==="soccer"||e.sport==="football"||e.eventDate||e.startTime).slice(0,30).map(e=>({id:e.id,title:e.title,slug:e.slug,eventDate:e.eventDate,startTime:e.startTime,live:e.live,score:e.score,period:e.period,teams:e.teams,sport:e.sport,gameId:e.gameId,marketGameStart:Array.isArray(e.markets)&&e.markets[0]?.gameStartTime})); console.log("SPORTS_SAMPLE",JSON.stringify(sports)); console.log("POLY_EVENT_COUNT",events.length); const candidates=[]; for(const e of events){const title=String(e.title||e.name||""); const qs=(Array.isArray(e.markets)?e.markets:[]).map(m=>String(m.question||m.title||"")).filter(q=>/\b(?:vs\.?|v\.?|versus)\b/i.test(q)); if(/\b(?:vs\.?|v\.?|versus)\b/i.test(title)||qs.length)candidates.push({id:e.id,title,slug:e.slug,startDate:e.startDate,endDate:e.endDate,keys:Object.keys(e),questions:qs.slice(0,3),marketKeys:Array.isArray(e.markets)&&e.markets[0]?Object.keys(e.markets[0]):[]});} console.log("MATCH_CANDIDATES",JSON.stringify(candidates.slice(0,30)));
console.log("POLY_SAMPLE",JSON.stringify(events.slice(0,5).map(e=>({id:e.id,title:e.title,name:e.name,slug:e.slug,startTime:e.startTime,startDate:e.startDate,endDate:e.endDate,homeTeamName:e.homeTeamName,awayTeamName:e.awayTeamName,homeTeam:e.homeTeam,awayTeam:e.awayTeam,markets:e.markets})),null,2).slice(0,12000));
const teamNames=e=>{const out=[];const add=v=>{if(typeof v==="string"&&v.trim())out.push(v.trim());else if(v&&typeof v==="object"){const n=v.name||v.teamName||v.title;if(typeof n==="string"&&n.trim())out.push(n.trim());}};add(e.homeTeam);add(e.awayTeam);add(e.home);add(e.away);add(e.homeTeamName);add(e.awayTeamName);if(Array.isArray(e.teams))e.teams.forEach(add);return [...new Set(out)];};
const eventTeams=e=>{const t=teamNames(e);if(t.length>=2)return [t[0],t[1]];const title=String(e.title||e.name||"").replace(/\s+-\s+(?:More Markets|Halftime Result|Second Half Result|Corners|Cards|O\/U.*)$/i,"").trim();const q=(Array.isArray(e.markets)?e.markets:[]).map(m=>String(m.question||m.title||"")).find(x=>/\s+(?:vs\.?|v\.?|versus)\s+/i.test(x));const s=q||title;const p=s.split(/\s+(?:vs\.?|v\.?|versus)\s+/i);return p.length===2?[p[0].trim(),p[1].trim()]:null;};
const matches=[];
for(const l of live){
  let best=null;
  for(const e of events){
    const p=eventTeams(e);if(!p)continue;
    const score=Math.max(sim(l.home,p[0])+sim(l.away,p[1]),sim(l.home,p[1])+sim(l.away,p[0]));
    if(!best||score>best.score)best={l,e,p,score};
  }
  if(best)matches.push(best);
}
matches.sort((a,b)=>b.score-a.score);
console.log("POLY_ALL_LIVE_MATCHES",JSON.stringify(matches.slice(0,30).map(x=>({live:x.l.home+" vs "+x.l.away,poly:x.e.title||x.e.name||x.e.slug,slug:x.e.slug,score:x.score,id:x.e.id}))));
const found=matches.find(x=>x.score>=1.0)||null;
if(found) console.log("BEST_MATCH",JSON.stringify({live:found.l,title:found.e.title,id:found.e.id,slug:found.e.slug,score:found.score,polyHome:found.p[0],polyAway:found.p[1]})); else console.log("BEST_MATCH","NONE");
const statePath="state/live-alerts.json";
const ghToken=process.env.GITHUB_TOKEN;
const repo=process.env.GITHUB_REPOSITORY||"laudinvil/Polymarket-Perps-Monitor";
const ghApi="https://api.github.com/repos/"+repo+"/contents/"+statePath;
const ghHeaders=()=>({"accept":"application/vnd.github+json","authorization":"Bearer "+ghToken,"x-github-api-version":"2022-11-28","user-agent":"live-chain-test"});
const loadState=async()=>{
  if(!ghToken)return {ids:new Set(),sha:null};
  try{
    const r=await fetch(ghApi,{headers:ghHeaders(),signal:AbortSignal.timeout(10000)});
    if(r.status===404)return {ids:new Set(),sha:null};
    if(!r.ok)throw Error("state GET "+r.status);
    const j=await r.json();
    const raw=Buffer.from(String(j.content||"").replace(/\\n/g,""),"base64").toString("utf8");
    const ids=new Set(Array.isArray(JSON.parse(raw).ids)?JSON.parse(raw).ids.map(String):[]);
    return {ids,sha:j.sha};
  }catch(e){console.log("STATE_LOAD_ERROR",String(e));return {ids:new Set(),sha:null}}
};
const saveState=async(state)=>{
  if(!ghToken)return false;
  const body=JSON.stringify({ids:[...state.ids].slice(-5000)});
  const payload={message:"Record sent live match alerts",content:Buffer.from(body).toString("base64"),branch:"main"};
  if(state.sha)payload.sha=state.sha;
  const r=await fetch(ghApi,{method:"PUT",headers:{...ghHeaders(),"content-type":"application/json"},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});
  const j=await r.json();
  console.log("STATE_SAVE",JSON.stringify({status:r.status,ok:r.ok}));
  if(r.ok){state.sha=j.content?.sha||state.sha;return true}
  return false;
};
const explicitMinute=v=>{
  if(v==null)return null;
  const s=String(v).trim();
  if(/^\d{1,3}\+\d+$/.test(s))return s;
  const m=s.match(/(?:2H|1H|ET|AET)\s*[-–:]?\s*(\d{1,3})(?:\+(\d+))?/i);
  if(m)return m[1]+(m[2]?"+"+m[2]:"");
  const n=s.match(/^\d{1,3}$/);
  return n?n[0]:null;
};
const enrichLive=async(l)=>{
  let minute=explicitMinute(l.minute), score=l.score, source=minute?"SportScore":"";
  if(l.slug){
    try{
      const dr=await json("https://sportscore.com/api/widget/match/?sport=football&slug="+encodeURIComponent(l.slug));
      const mins=[];
      const scan=x=>{
        if(!x||typeof x!=="object")return;
        if(Array.isArray(x)){for(const v of x)scan(v);return}
        for(const [k,v] of Object.entries(x)){
          const key=String(k).toLowerCase();
          if(typeof v==="string"){
            const m=explicitMinute(v);
            if(m&&/status_text|statustext|clock|match_time|matchtime|elapsed|minute|currentminute|gameminute|period/.test(key))mins.push(m);
          }else if(typeof v==="number"&&/^(minute|elapsed|currentminute|gameminute)$/.test(key)&&v>=0&&v<=130)mins.push(String(Math.floor(v)));
          else if(v&&typeof v==="object")scan(v);
        }
      };
      scan(dr);
      if(mins.length){minute=mins[0];source="SportScoreDetail"}
    }catch(e){console.log("MINUTE_DETAIL_ERROR",l.home+" vs "+l.away,String(e))}
  }
  return {...l,minute,minuteSource:source,score};
};
const state=await loadState();
console.log("STATE_LOADED",JSON.stringify({count:state.ids.size}));
console.log("POLY_ALL_LIVE_MATCHES",JSON.stringify(matches.slice(0,50).map(x=>({live:x.l.home+" vs "+x.l.away,poly:x.e.title||x.e.name||x.e.slug,slug:x.e.slug,score:x.score,id:x.e.id}))));
let sent=0;
for(const m of matches){
  if(m.score<1.0)continue;
  const live=await enrichLive(m.l);
  const minuteNum=live.minute?Number(String(live.minute).split("+")[0]):NaN;
  if(!Number.isFinite(minuteNum)||minuteNum<1){
    console.log("WAIT_FIRST_MINUTE",JSON.stringify({live:live.home+" vs "+live.away,minute:live.minute,source:live.minuteSource}));
    continue;
  }
  const eventId=String(m.e.id);
  if(state.ids.has(eventId)){
    console.log("ALREADY_ALERTED",eventId,m.e.slug);
    continue;
  }
  const leagueSlug=e=>{
    const direct=e?.leagueSlug??e?.seriesSlug??e?.league?.slug??e?.series?.slug;
    if(typeof direct==="string"&&direct.trim())return direct.trim().toLowerCase();
    const tags=Array.isArray(e?.tags)?e.tags:[];
    for(const t of tags){const s=typeof t==="string"?t:slugOf(t);if(s&&leagueSlugs.includes(s))return s}
    const s=String(e?.slug||"");const parts=s.split("-");
    return parts.length>1?parts[0].toLowerCase():"";
  };
  const league=leagueSlug(m.e),slug=String(m.e.slug||"");
  const link=league&&slug?"https://polymarket.com/sports/"+encodeURIComponent(league)+"/"+encodeURIComponent(slug):"https://polymarket.com/event/"+encodeURIComponent(slug);
  console.log("POLY_LINK",JSON.stringify({league,slug,link}));
  const text="⚽ <b>LIVE</b>\\n\\n"+esc(live.home)+" vs "+esc(live.away)+"\\nLIVE\\nMINUTE: "+esc(live.minute)+"\\nSCORE: "+esc(live.score)+"\\n\\n<a href=\""+esc(link)+"\">ОТКРЫТЬ POLYMARKET</a>";
  try{
    const tr=await fetch("https://api.telegram.org/bot"+process.env.TELEGRAM_BOT_TOKEN+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:process.env.TELEGRAM_CHAT_ID,parse_mode:"HTML",text})});
    const tj=await tr.json();
    console.log("TELEGRAM_RESPONSE",JSON.stringify(tj));
    if(!tj.ok)throw Error("Telegram rejected: "+JSON.stringify(tj));
    state.ids.add(eventId);
    await saveState(state);
    console.log("ALERT_SENT",eventId,slug);
    sent++;
  }catch(e){console.log("ALERT_ERROR",eventId,String(e))}
}
console.log("POLL_RESULT",JSON.stringify({live:live.length,polymatch:matches.length,sent}));
process.exit(0);
