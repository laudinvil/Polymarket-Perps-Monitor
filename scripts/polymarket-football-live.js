const GAMMA_URL = "https://gamma-api.polymarket.com";
const SPORTScore_URL = "https://sportscore.com/api/widget";

const POLL_MS = 10_000;
const MIN_EDGE = 0.01;
const RUN_MS = 6 * 60 * 60 * 1000;
const HISTORY_MS = 20 * 60 * 1000;
const ALERT_BUCKET_MS = 60 * 1000;
const PREMATCH_WINDOW_MS = Number.POSITIVE_INFINITY;
const EARLY_WINDOW_MS = 45 * 60 * 1000;
const NUTMEG_CACHE_MS = 5 * 60 * 1000;
const BALANCE_MAX_DIFF = 0.15;
const MIN_DRAW_PROB = 0.22;
const MIN_BTTS_PROB = 0.45;

let stopping = false;
let timer = null;
const known = new Map();
const resolved = new Map();
const history = new Map();
const oneOneState = new Map();
let nutmegCache = { at: 0, rows: [] };
const convexLogBuffer = [];
let convexTickCount = 0;

function log(level, event, message, data = undefined) {
  const entry = { level, event, message, ...(data === undefined ? {} : { data: JSON.stringify(data) }), createdAt: Date.now() };
  convexLogBuffer.push(entry);
  console.log(JSON.stringify({ level, event, message, ...(data === undefined ? {} : { data: JSON.stringify(data) }) }));
}
async function flushConvexLogs() {
  if (!convexLogBuffer.length && !convexTickCount) return;
  const batch = convexLogBuffer.splice(0, 100), ticks = convexTickCount; convexTickCount = 0;
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  try { const response = await fetch(base.replace(/\/$/, "") + "/football/logs", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({logs:batch,tickCount:ticks}), signal:AbortSignal.timeout(2_000)}); if(!response.ok) throw new Error("Convex HTTP "+response.status); }
  catch(err){ convexLogBuffer.unshift(...batch); convexTickCount += ticks; console.log(JSON.stringify({level:"WARN",event:"convex_log_failed",message:err.message})); }
}
async function checkpoint(event,data={}){ log("INFO",event,"football monitor checkpoint",data); await flushConvexLogs(); }
function text(v){return typeof v==="string"?v.trim():"";}
function norm(v){return text(v).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/æ/g,"ae").replace(/œ/g,"oe").replace(/ß/g,"ss").replace(/&/g,"and").replace(/\b(?:fc|cf|sc|afc|ac|fk|sk|bk|sv|ks|cd|ud|rcd|kv|krc)\b/g," ").replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();}
function parseJson(v){if(typeof v!=="string")return v;try{return JSON.parse(v);}catch{return v;}}
function eventUrl(event){const slug=text(event.slug);return slug?"https://polymarket.com/event/"+slug:"";}

// Discovery must identify football fixtures, not decide whether a fixture is
// suitable for the strategy. Market variants are handled later by the
// strategy/market-selection stage. A title must still contain two sides in a
// normal match form so unrelated soccer events do not enter the fixture list.
function isPrimaryMatchEvent(event){
  const title=text(event.title||event.question);
  return /\s(?:vs\.?|v\.?|versus)\s/i.test(title);
}
function extractTeams(event){
  const title=text(event.title||event.question);
  const candidates=[event.homeTeam&&event.awayTeam?[event.homeTeam,event.awayTeam]:null,event.home_team&&event.away_team?[event.home_team,event.away_team]:null].filter(Boolean);
  if(candidates.length)return candidates[0].map(text);
  const m=title.match(/^(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+)$/i); return m?[m[1].trim(),m[2].trim()]:["",""];
}
function isFootballEvent(event,footballIds){const hay=[event.sport,event.sportSlug,event.sport_slug,event.category,event.tag,event.tags,event.title,event.question,event.series_id,event.seriesId].flat(Infinity).map(text).join(" ").toLowerCase();if(footballIds.size){const ids=[event.series_id,event.seriesId,event.sports_series_id].map(text).filter(Boolean);if(ids.some(id=>footballIds.has(id)))return true;}return /football|soccer|epl|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league/.test(hay);}
async function getJson(url,options={}){const r=await fetch(url,{...options,headers:{accept:"application/json",...(options.headers||{})},signal:AbortSignal.timeout(10_000)});if(!r.ok)throw new Error("HTTP "+r.status+" for "+url);return r.json();}
async function footballSeriesIds(){try{const data=await getJson(GAMMA_URL+"/sports"),rows=Array.isArray(data)?data:(data.sports||data.data||[]),ids=new Set();for(const row of rows){if(!/football|soccer/.test(JSON.stringify(row).toLowerCase()))continue;for(const key of ["series","series_id","seriesId"]){const id=text(row[key]);if(id)ids.add(id);}}return ids;}catch(err){log("WARN","sports_metadata_failed","Could not load sports metadata; using event text fallback",{message:err.message});return new Set();}}
async function activeEventsBySeries(seriesId){const data=await getJson(GAMMA_URL+"/events?series_id="+encodeURIComponent(seriesId)+"&active=true&closed=false&limit=500");return Array.isArray(data)?data:(data.events||data.data||[]);}

async function discoverPolymarket(){
  const matches=[],seen=new Set();let eventScanned=0,footballEventFound=0,matchesFound=0;
  await checkpoint("discovery_start",{strategy:"football_fixture_first_v8",source:"soccer_tag",note:"Polymarket discovery identifies football fixtures only; strategy filtering happens after Nutmeg matching"});
  const sources=[
    {name:"soccer_newest",baseUrl:GAMMA_URL+"/events?tag_slug=soccer&active=true&closed=false&limit=100&order=id&ascending=false"},
    {name:"soccer_live",baseUrl:GAMMA_URL+"/events?tag_slug=soccer&live=true&active=true&closed=false&limit=100&order=id&ascending=false"},
    {name:"sports_newest",baseUrl:GAMMA_URL+"/events?tag_id=100639&active=true&closed=false&limit=100&order=id&ascending=false"}
  ];
  const pagePlan={soccer_newest:3,soccer_live:1,sports_newest:2};
  const sourcePages=sources.flatMap(source=>Array.from({length:pagePlan[source.name]??1},(_,page)=>({name:source.name,url:source.baseUrl+"&offset="+(page*100),page})));
  const results=await Promise.all(sourcePages.map(async source=>{try{const response=await fetch(source.url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(10_000)}),body=await response.text();if(!response.ok)throw new Error("HTTP "+response.status+" for "+source.url);let data;try{data=JSON.parse(body);}catch(error){throw error;}const rows=Array.isArray(data)?data:(data?.events||data?.data||[]);log("INFO","event_source_response","Raw Polymarket football source response captured",{source:source.name,status:response.status,rowCount:rows.length,bodyBytes:Buffer.byteLength(body,"utf8")});return{name:source.name,rows,error:null};}catch(error){return{name:source.name,rows:[],error};}}));
  for(const result of results){if(result.error){log("WARN","event_source_failed","Polymarket football source failed",{source:result.name,message:result.error.message});continue;}eventScanned+=result.rows.length;for(const event of result.rows){if(!event||event.active===false||event.closed===true)continue;const hay=[event.sport,event.sportSlug,event.sport_slug,event.category,event.tags,event.title,event.question].flat(Infinity).map(text).join(" ");const footballSource=result.name==="soccer_newest"||result.name==="soccer_live";if(!footballSource&&!/football|soccer|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league/i.test(hay))continue;footballEventFound++;if(!isPrimaryMatchEvent(event)){log("INFO","non_fixture_filtered","Football event has no recognizable fixture form; not passed to Nutmeg",{eventId:text(event.id||event.eventId||event.event_id),title:text(event.title||event.question),source:result.name});continue;}const [home,away]=extractTeams(event);if(!home||!away){log("INFO","match_teams_missing","Football event has no recognizable teams",{eventId:text(event.id),title:text(event.title)});continue;}const startTime=event.startDate||event.start_date||event.startTime||null,endTime=event.endDate||event.end_date||event.endTime||null,eventId=text(event.id||event.eventId||event.event_id),slug=text(event.slug),key=eventId||slug;if(!key){log("WARN","match_identity_missing","Football match has teams but no event id/slug",{title:text(event.title||event.question),home,away});continue;}if(seen.has(key))continue;seen.add(key);matchesFound++;const nestedMarkets=Array.isArray(event.markets)?event.markets.map(market=>({marketId:text(market?.id||market?.marketId),question:text(market?.question||market?.title),outcomes:Array.isArray(parseJson(market?.outcomes))?parseJson(market.outcomes):[],outcomePrices:Array.isArray(parseJson(market?.outcomePrices||market?.outcome_prices))?parseJson(market?.outcomePrices||market?.outcome_prices):[],active:market?.active!==false,closed:market?.closed===true})):[];matches.push({eventId,slug,url:eventUrl(event),title:text(event.title||event.question),homeTeam:home,awayTeam:away,startTime,endTime,markets:nestedMarkets});log("INFO","match_discovery_passed","Football fixture passed discovery",{source:result.name,eventId,slug,teams:[home,away],startTime,active:event.active,closed:event.closed,marketCount:nestedMarkets.length});}await checkpoint("event_source_done",{source:result.name,rows:result.rows.length,eventScanned,footballEventFound,matchesFound});}
  await checkpoint("discovery_done",{eventScanned,footballEventFound,matchesFound,matches:matches.map(m=>({eventId:m.eventId,teams:[m.homeTeam,m.awayTeam],startTime:m.startTime}))});return matches;
}
