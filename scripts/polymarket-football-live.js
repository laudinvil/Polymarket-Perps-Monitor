const GAMMA_URL = "https://gamma-api.polymarket.com";

const POLL_MS = 20_000; // Polymarket-only polling.
const MIN_EDGE = 0.01;
const RUN_MS = 5 * 60 * 60 * 1000 + 50 * 60 * 1000;
const HISTORY_MS = 20 * 60 * 1000;
const ALERT_BUCKET_MS = 60 * 1000;
const PREMATCH_WINDOW_MS = Number.POSITIVE_INFINITY;
const EARLY_WINDOW_MS = 45 * 60 * 1000;
const BALANCE_MAX_DIFF = 0.25; // Wider balanced window so valid near-even matches can reach BUY.
const MIN_DRAW_PROB = 0.22;
const MIN_BTTS_PROB = 0.45;

let stopping = false;
let timer = null;
const known = new Map();
const resolved = new Map();
const history = new Map();
const oneOneState = new Map();
const prematchCandidates = new Map();
const convexLogBuffer = [];
let convexTickCount = 0;

function log(level, event, message, data = undefined) {
  const entry = {
    level, event, message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) }),
    createdAt: Date.now(),
  };
  convexLogBuffer.push(entry);
  console.log(JSON.stringify({
    level,
    event,
    message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) })
  }));
}

async function flushConvexLogs() {
  if (!convexLogBuffer.length && !convexTickCount) return;
  const batch = convexLogBuffer.splice(0, 100);
  const ticks = convexTickCount;
  convexTickCount = 0;
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  try {
    const response = await fetch(base.replace(/\/$/, "") + "/football/logs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ logs: batch, tickCount: ticks }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error("Convex HTTP " + response.status);
  } catch (err) {
    convexLogBuffer.unshift(...batch);
    convexTickCount += ticks;
    console.log(JSON.stringify({ level: "WARN", event: "convex_log_failed", message: err.message }));
  }
}

async function checkpoint(event, data = {}) {
  log("INFO", event, "football monitor checkpoint", data);
  await flushConvexLogs();
}

function text(v) {
  return typeof v === "string" ? v.trim() : "";
}

function norm(v) {
  return text(v).toLowerCase()
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/\b(fc|cf|sc|afc|ac|club|football club)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function parseJson(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

function eventUrl(event){const slug=text(event.slug);return slug?"https://polymarket.com/event/"+slug:"";}

// Discovery must identify football fixtures, not decide whether a fixture is
// suitable for the strategy. Market variants are handled later by the
// strategy/market-selection stage. A title must still contain two sides in a
// normal match form so unrelated soccer events do not enter the fixture list.
const CHILD_MARKET_SUFFIX = /\s+-\s+(?:more markets|player props?|total (?:corners|goals|cards|shots)|first team to score|last team to score|exact score|half[- ]?time result|second half result|1st half result|2nd half result|match result|draw no bet|double chance|both teams to score|btts|to score|team totals?|alternate lines?|correct score|winning margin|clean sheet|win to nil|half[- ]?time|first half|second half).*$/i;

function cleanFixtureSide(value){return text(value).replace(CHILD_MARKET_SUFFIX,"").trim();}
function isPrimaryMatchEvent(event){
  const title=text(event.title||event.question).trim();
  if(!/\s(?:vs\.?|v\.?|versus)\s/i.test(title)) return false;
  // Polymarket exposes many child events for the same fixture. Their titles
  // append market-specific suffixes; those must never become the fixture identity.
  if(/\s-\s(?:1st|2nd)\s+half\b/i.test(title)) return false;
  if(/\s-\s(?:first|second)\s+half\b/i.test(title)) return false;
  if(/\s-\s(?:exact\s+score|correct\s+score|first\s+team\s+to\s+score|team\s+to\s+score|total\s+goals|both\s+teams\s+to\s+score|btts|match\s+result|winner|moneyline)\b/i.test(title)) return false;
  return true;
}
function extractTeams(event){
  const title=text(event.title||event.question);
  const candidates=[event.homeTeam&&event.awayTeam?[event.homeTeam,event.awayTeam]:null,event.home_team&&event.away_team?[event.home_team,event.away_team]:null].filter(Boolean);
  if(candidates.length)return candidates[0].map(cleanFixtureSide);
  const m=title.match(/^(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+)$/i); return m?[cleanFixtureSide(m[1]),cleanFixtureSide(m[2])]:["",""];
}
function fixtureKey(home,away,startTime){
  const teams=[norm(home),norm(away)].sort().join("|");
  const parsed=Date.parse(startTime||"");
  const day=Number.isNaN(parsed)?"unknown":new Date(parsed).toISOString().slice(0,10);
  return teams+"|"+day;
}
function isFootballEvent(event,footballIds){const hay=[event.sport,event.sportSlug,event.sport_slug,event.category,event.tag,event.tags,event.title,event.question,event.series_id,event.seriesId].flat(Infinity).map(text).join(" ").toLowerCase();if(footballIds.size){const ids=[event.series_id,event.seriesId,event.sports_series_id].map(text).filter(Boolean);if(ids.some(id=>footballIds.has(id)))return true;}return /football|soccer|epl|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league/.test(hay);}
async function getJson(url,options={}){const timeoutMs=options.timeoutMs ?? 5_000; const {timeoutMs: _timeoutMs, ...fetchOptions}=options; const r=await fetch(url,{...fetchOptions,headers:{accept:"application/json",...(fetchOptions.headers||{})},signal:AbortSignal.timeout(timeoutMs)});if(!r.ok)throw new Error("HTTP "+r.status+" for "+url);return r.json();}
async function footballSeriesIds(){try{const data=await getJson(GAMMA_URL+"/sports"),rows=Array.isArray(data)?data:(data.sports||data.data||[]),ids=new Set();for(const row of rows){if(!/football|soccer/.test(JSON.stringify(row).toLowerCase()))continue;for(const key of ["series","series_id","seriesId"]){const id=text(row[key]);if(id)ids.add(id);}}return ids;}catch(err){log("WARN","sports_metadata_failed","Could not load sports metadata; using event text fallback",{message:err.message});return new Set();}}
async function activeEventsBySeries(seriesId){const data=await getJson(GAMMA_URL+"/events?series_id="+encodeURIComponent(seriesId)+"&active=true&closed=false&limit=500");return Array.isArray(data)?data:(data.events||data.data||[]);}

async function discoverPolymarket(){
  const groups=new Map();let eventScanned=0,footballEventFound=0,childMarketEventsGrouped=0;
  await checkpoint("discovery_start",{strategy:"football_fixture_first_v9",source:"soccer_tag",note:"Polymarket-only football fixture discovery; no external source matching"});
  const sources=[
    {name:"soccer_newest",baseUrl:GAMMA_URL+"/events?tag_slug=soccer&active=true&closed=false&limit=100&order=id&ascending=false"},
    {name:"sports_newest",baseUrl:GAMMA_URL+"/events?tag_id=100639&active=true&closed=false&limit=100&order=id&ascending=false"}
  ];
  const pagePlan={soccer_newest:3,sports_newest:2};
  const sourcePages=sources.flatMap(source=>Array.from({length:pagePlan[source.name]??1},(_,page)=>({name:source.name,url:source.baseUrl+"&offset="+(page*100),page})));
  const results=await Promise.all(sourcePages.map(async source=>{try{const response=await fetch(source.url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(10_000)}),body=await response.text();if(!response.ok)throw new Error("HTTP "+response.status+" for "+source.url);let data;try{data=JSON.parse(body);}catch(error){throw error;}const rows=Array.isArray(data)?data:(data?.events||data?.data||[]);log("INFO","event_source_response","Raw Polymarket football source response captured",{source:source.name,status:response.status,rowCount:rows.length,bodyBytes:Buffer.byteLength(body,"utf8")});return{name:source.name,rows,error:null};}catch(error){return{name:source.name,rows:[],error};}}));
  for(const result of results){if(result.error){log("WARN","event_source_failed","Polymarket football source failed",{source:result.name,message:result.error.message});continue;}eventScanned+=result.rows.length;for(const event of result.rows){if(!event||event.active===false||event.closed===true)continue;const hay=[event.sport,event.sportSlug,event.sport_slug,event.category,event.tags,event.title,event.question].flat(Infinity).map(text).join(" ");const footballSource=result.name==="soccer_newest"||result.name==="soccer_live";if(!footballSource&&!/football|soccer|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league/i.test(hay))continue;footballEventFound++;if(!isPrimaryMatchEvent(event)){log("INFO","non_fixture_filtered","Football event has no recognizable fixture form; not passed to strategy",{eventId:text(event.id||event.eventId||event.event_id),title:text(event.title||event.question),source:result.name});continue;}const [home,away]=extractTeams(event);if(!home||!away){log("INFO","match_teams_missing","Football event has no recognizable teams",{eventId:text(event.id),title:text(event.title)});continue;}const startTime=event.startDate||event.start_date||event.startTime||null,endTime=event.endDate||event.end_date||event.endTime||null,eventId=text(event.id||event.eventId||event.event_id),slug=text(event.slug),key=eventId||slug;if(!key){log("WARN","match_identity_missing","Football match has teams but no event id/slug",{title:text(event.title||event.question),home,away});continue;}const nestedMarkets=Array.isArray(event.markets)?event.markets.map(market=>({marketId:text(market?.id||market?.marketId),question:text(market?.question||market?.title),outcomes:Array.isArray(parseJson(market?.outcomes))?parseJson(market.outcomes):[],outcomePrices:Array.isArray(parseJson(market?.outcomePrices||market?.outcome_prices))?parseJson(market?.outcomePrices||market?.outcome_prices):[],active:market?.active!==false,closed:market?.closed===true})):[];const groupKey=fixtureKey(home,away,startTime);
      const existing=groups.get(groupKey);
      if(existing){
        childMarketEventsGrouped++;
        // Prefer the true fixture event over a child market event if both were
        // returned for the same teams/date.
        const currentTitle=text(existing.title||"");
        const currentPrimary=isPrimaryMatchEvent({title:currentTitle});
        if(!currentPrimary){
          existing.eventId=eventId;
          existing.slug=slug;
          existing.url=eventUrl(event);
          existing.title=text(event.title||event.question);
          existing.startTime=startTime;
          existing.endTime=endTime;
        }
        const knownMarketIds=new Set(existing.markets.map(m=>m.marketId).filter(Boolean));
        for(const market of nestedMarkets) if(!market.marketId||!knownMarketIds.has(market.marketId)){existing.markets.push(market);if(market.marketId)knownMarketIds.add(market.marketId);}
        existing.relatedEventIds.push(eventId);
        log("INFO","fixture_event_grouped","Child/duplicate football market event grouped into existing fixture",{fixtureKey:groupKey,eventId,teams:[home,away],title:text(event.title||event.question),source:result.name,groupedEventCount:existing.relatedEventIds.length});
      } else {
        groups.set(groupKey,{eventId,slug,url:eventUrl(event),title:text(event.title||event.question),homeTeam:home,awayTeam:away,startTime,endTime,markets:nestedMarkets,relatedEventIds:[eventId]});
        log("INFO","match_discovery_passed","Unique football fixture passed discovery",{source:result.name,eventId,slug,fixtureKey:groupKey,teams:[home,away],startTime,active:event.active,closed:event.closed,marketCount:nestedMarkets.length});
      }}await checkpoint("event_source_done",{source:result.name,rows:result.rows.length,eventScanned,footballEventFound,uniqueFixtures:groups.size,childMarketEventsGrouped});}
  const matches=Array.from(groups.values());
  await checkpoint("discovery_done",{eventScanned,footballEventFound,matchesFound:matches.length,childMarketEventsGrouped,matches:matches.map(m=>({eventId:m.eventId,teams:[m.homeTeam,m.awayTeam],startTime:m.startTime,relatedEventCount:m.relatedEventIds.length,marketCount:m.markets.length}))});
  return matches;
}
function findMatchResultMarket(match) {
  const home=norm(match.homeTeam), away=norm(match.awayTeam);
  for (const market of match.markets || []) {
    if (!market || market.active===false || market.closed===true) continue;
    const outcomes=parseJson(market.outcomes);
    const pricesRaw=parseJson(market.outcomePrices ?? market.outcome_prices);
    if (!Array.isArray(outcomes)||!Array.isArray(pricesRaw)||outcomes.length!==pricesRaw.length||outcomes.length<3) continue;
    const prices=pricesRaw.map(Number);
    if (prices.some(v=>!Number.isFinite(v))) continue;
    const question=norm(market.question||"");
    const looks1x2=/1x2|match result|winner|moneyline|result/.test(question) ||
      question.includes(home) || question.includes(away);
    if(!looks1x2) continue;
    let hi=-1,ai=-1,di=-1;
    for(let i=0;i<outcomes.length;i++){
      const raw=text(outcomes[i]);
      const o=norm(raw);
      if(o==="draw"||o==="tie"||o==="x"||o==="draw (x)") di=i;
      else if(o==="1"||o==="home"||o==="home team"||o===home||o.includes(home)||home.includes(o)) hi=i;
      else if(o==="2"||o==="away"||o==="away team"||o===away||o.includes(away)||away.includes(o)) ai=i;
    }
    if(hi<0&&ai<0&&di<0) continue;
    if(hi<0||ai<0||di<0) {
      log("INFO","one_x_two_shape_unresolved","Polymarket market looks like 1X2 but outcome labels were not fully mapped",{
        eventId:match.eventId,marketId:market.marketId,question:market.question||null,outcomes
      });
      continue;
    }
    return {market,homeProb:prices[hi],drawProb:prices[di],awayProb:prices[ai]};
  }
  return null;
}

function balancedFromPolymarket(market) {
  return Boolean(
    market &&
    Number.isFinite(market.homeProb) &&
    Number.isFinite(market.awayProb) &&
    Math.abs(market.homeProb - market.awayProb) <= BALANCE_MAX_DIFF
  );
}

function isStrictPrematch(match, liveState) {
  if (liveState?.status === "live") return false;
  const kickoff = Date.parse(match.startTime || "");
  if (!Number.isFinite(kickoff)) {
    log("INFO","prematch_time_unknown","No usable Polymarket kickoff; not admitted", {eventId:match.eventId,startTime:match.startTime||null});
    return false;
  }
  const future = kickoff > Date.now();
  if (!future) log("INFO","kickoff_passed_not_prematch","Polymarket kickoff passed; no new BUY", {
    eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],startTime:match.startTime,kickoffPassedMs:Date.now()-kickoff
  });
  return future;
}

async function ensureEventMarkets(match) {
  if (!match.eventId) return false;

  const startedAt = Date.now();
  log("INFO", "event_markets_load_start", "Loading Polymarket event markets", {
    eventId: match.eventId,
    teams: [match.homeTeam, match.awayTeam]
  });

  try {
    const data = await getJson(GAMMA_URL + "/events/" + encodeURIComponent(match.eventId), { timeoutMs: 3_000 });
    const event = data?.event || data;
    const markets = Array.isArray(event?.markets) ? event.markets : [];
    match.markets = markets.map(market => ({
      marketId: text(market?.id || market?.marketId),
      question: text(market?.question || market?.title),
      outcomes: Array.isArray(parseJson(market?.outcomes)) ? parseJson(market.outcomes) : [],
      outcomePrices: Array.isArray(parseJson(market?.outcomePrices || market?.outcome_prices))
        ? parseJson(market?.outcomePrices || market?.outcome_prices)
        : [],
      active: market?.active !== false,
      closed: market?.closed === true
    }));
    log("INFO", "event_markets_loaded", "Refreshed Polymarket event markets for active candidate", {
      eventId: match.eventId,
      marketCount: match.markets.length,
      oneXTwoMarketAvailable: Boolean(findMatchResultMarket(match)),
      elapsedMs: Date.now() - startedAt
    });
    return match.markets.length > 0;
  } catch (err) {
    log("WARN", "event_markets_load_failed", "Could not load event markets", {
      eventId: match.eventId,
      message: err.message,
      elapsedMs: Date.now() - startedAt
    });
    return false;
  }
}

function findOneOneMarket(match) {
  for (const market of match.markets || []) {
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
    const prices = Array.isArray(market.outcomePrices) ? market.outcomePrices : [];
    const question = text(market.question || "");
    if (/(?:exact score|correct score)/i.test(question) &&
        /(?:^|\s)1\s*[-:]\s*1(?:\s|\?|$)/i.test(question)) {
      const yesIndex = outcomes.findIndex(v => /^yes$/i.test(text(v)));
      const index = yesIndex >= 0 ? yesIndex : 0;
      const price = Number(prices[index]);
      if (Number.isFinite(price)) return { market, outcome: text(outcomes[index] || "Yes"), price };
    }
    for (let i = 0; i < outcomes.length; i++) {
      if (/^1\s*[-:]\s*1$/.test(text(outcomes[i]))) {
        const price = Number(prices[i]);
        if (Number.isFinite(price)) return { market, outcome: text(outcomes[i]), price };
      }
    }
  }
  return null;
}

function scoreTotal(match) {
  return Number(match.live?.score?.home || 0) + Number(match.live?.score?.away || 0);
}

async function maybeOneOneAlert(match, priceSource, phase = "live") {
  if (!match.url) return;

  const key = match.eventId || match.slug;
  const home = Number(match.live?.score?.home || 0);
  const away = Number(match.live?.score?.away || 0);

  // BUY is created only while the fixture is still pre-match.
  // A match discovered for the first time already live is never a BUY candidate.
  if (phase === "prematch") {
    oneOneState.set(key, { ...(oneOneState.get(key) || {}), prematchSeen: true });

    const claimKey = key + ":BUY";
    const claim = await claimTelegramAlert(claimKey);
    if (!claim.claimed) return;

    const message = [
      "⚽ 1:1 · BUY", "",
      match.homeTeam + " vs " + match.awayTeam,
      "PRE-MATCH",
      "", "➡️ OPEN MATCH", match.url
    ].join("\n");

    try {
      const sent = await sendTelegram(message);
      if (!sent.ok) throw new Error("Telegram not configured");
      await saveTelegramMessageId(claimKey, sent.messageId);
      await markCandidateBuySent(key);
      log("INFO", "one_one_buy_alert_sent", "1:1 pre-match entry alert sent", {
        eventId: match.eventId, reason: "balanced_polymarket_1x2_prematch", telegramMessageId: sent.messageId
      });
    } catch (err) {
      await releaseTelegramAlert(claimKey);
      log("ERROR", "telegram_send_failed", "BUY alert send failed; claim released", {
        eventId: match.eventId, message: err.message
      });
    }
    return;
  }

  // Only a fixture that was previously admitted as pre-match gets a
  // one-time STARTED reminder when its state changes to live.
  if (phase === "started") {
    const state = oneOneState.get(key);
    if (!state?.prematchSeen) return;

    const claimKey = key + ":STARTED";
    const claim = await claimTelegramAlert(claimKey);
    if (!claim.claimed) return;

    const message = [
      "⚽ MATCH STARTED", "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: " + home + "–" + away,
      "", "➡️ OPEN MATCH", match.url
    ].join("\n");

    try {
      const sent = await sendTelegram(message, claim.replyToMessageId);
      if (!sent.ok) throw new Error("Telegram not configured");
      await markCandidateStartedSent(key);
      log("INFO", "match_started_alert_sent", "Pre-match fixture transitioned to live", {
        eventId: match.eventId, score: { home, away }, replyToMessageId: claim.replyToMessageId
      });
    } catch (err) {
      await releaseTelegramAlert(claimKey);
      log("ERROR", "telegram_send_failed", "MATCH STARTED alert send failed; claim released", {
        eventId: match.eventId, message: err.message
      });
    }
    return;
  }

  // A goal can happen between two 20s cycles. SELL is allowed only after
  // a prior BUY claim; an already-live fixture discovered without a BUY
  // is never converted into an entry.
  const hasGoal = (home + away) > 0;
  if (!hasGoal) return;

  const claimKey = key + ":SELL";
  const claim = await claimTelegramAlert(claimKey);
  if (!claim.claimed) return;

  const message = [
    "⚽ 1:1 · SELL", "",
    match.homeTeam + " vs " + match.awayTeam,
    "SCORE: " + home + "–" + away,
    "", "➡️ OPEN MATCH", match.url
  ].join("\n");

  try {
    const sent = await sendTelegram(message, claim.replyToMessageId);
    if (!sent.ok) throw new Error("Telegram not configured");
    await markCandidateSellSent(key);
    log("INFO", "one_one_sell_alert_sent", "1:1 exit alert sent as Telegram reply to BUY", {
      eventId: match.eventId, score: { home, away }, goalDetected: hasGoal, replyToMessageId: claim.replyToMessageId
    });
  } catch (err) {
    await releaseTelegramAlert(claimKey);
    log("ERROR", "telegram_send_failed", "SELL alert send failed; claim released", {
      eventId: match.eventId, message: err.message
    });
  }
}

async function tick() {
  if(stopping||tick.running)return;
  tick.running=true; convexTickCount+=1;
  try{
    const tickStartedAt=Date.now();
    log("INFO","stage_start","Polymarket discovery stage started",{stage:"polymarket_discovery",source:GAMMA_URL});
    const discovered=await discoverPolymarket();
    await persistPrematchCandidates(discovered);
    for (const match of discovered) {
      const key=match.eventId||match.slug;
      if (key) prematchCandidates.set(key, {...prematchCandidates.get(key), ...match});
    }
    const matches=Array.from(prematchCandidates.values());
    const cycle={discovered:discovered.length,retainedCandidates:matches.length,preMatch:0,live:0,liveZeroZero:0,evaluations:0,buyPassed:0,buyRejected:0,sellEvaluated:0,liveStateUnavailable:0};
    log("INFO","stage_done","Polymarket discovery stage finished",{stage:"polymarket_discovery",elapsedMs:Date.now()-tickStartedAt,candidates:matches.length});
    log("INFO","polymarket_source","Polymarket is the sole football source",{source:GAMMA_URL});
    const evalStarted=Date.now();
    log("INFO","stage_start","Polymarket-only alert evaluation started",{stage:"evaluation",rule:"future PRE-MATCH football candidate = BUY; no market gate"});
    const BATCH=20;
    for(let i=0;i<matches.length;i+=BATCH){
      await Promise.all(matches.slice(i,i+BATCH).map(async match=>{
        cycle.evaluations++;
        const liveState=await refreshPolymarketLiveState(match);
        const isLive=liveState?.status==="live";
        const isPrematch=isStrictPrematch(match,liveState);
        if(isPrematch){
          cycle.preMatch++;
          // A discovered future football fixture is already a strategy candidate.
          // There is no additional market/price gate between candidate admission and BUY.
          cycle.buyPassed++;
          log("INFO","candidate_ready_for_buy","Football candidate reached BUY stage",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],kickoff:match.startTime});
          await maybeOneOneAlert({...match,live:{status:"scheduled",score:{home:0,away:0},minute:0}},null,"prematch");
          return;
        }
        const score=liveState?.score||{home:0,away:0};
        const state=oneOneState.get(match.eventId||match.slug);
        if(isLive)cycle.live++;
        if(isLive&&score.home===0&&score.away===0)cycle.liveZeroZero++;
        if(!liveState&&!isLive)cycle.liveStateUnavailable++;
        if(state?.prematchSeen) await maybeOneOneAlert({...match,live:{...(liveState||{}),status:"live",score}},null,"started");
        log("INFO","live_fixture_not_entry","Already-live Polymarket fixture skipped as BUY entry",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],score,previouslyAdmittedPrematch:Boolean(state?.prematchSeen)});
        if((Number(score.home)+Number(score.away))>0&&state?.prematchSeen){
          cycle.sellEvaluated++;
          await maybeOneOneAlert({...match,live:{...(liveState||{}),status:"live",score}},null,"live");
        }
      }));
    }
    log("INFO","stage_done","Polymarket-only alert evaluation finished",{stage:"evaluation",elapsedMs:Date.now()-evalStarted,candidates:matches.length});
    log("INFO","cycle_summary","Football monitor cycle summary",{elapsedMs:Date.now()-tickStartedAt,...cycle,note:"Polymarket only; discovered fixtures are retained across cycles until lifecycle resolution"});
    return matches.length;
  }catch(err){
    log("ERROR","discovery_failed","Football Polymarket-only tick failed; monitoring continues",{message:err.message});
  }finally{tick.running=false;await flushConvexLogs();}
}

function teamSimilarity(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const xa = new Set(x.split(" ")), ya = new Set(y.split(" "));
  const overlap = [...xa].filter(token => ya.has(token)).length;
  return overlap / Math.max(xa.size, ya.size);
}

async function refreshPolymarketLiveState(match) {
  try {
    const data = await getJson(GAMMA_URL + "/events/" + encodeURIComponent(match.eventId));
    const event = data?.event || data;
    const score = extractPolymarketScore(event);
    const liveFlag = event?.live === true || event?.isLive === true || /live|in progress|playing|ongoing/i.test(text(event?.status));
    if (!score && !liveFlag) return null;
    return {
      status: liveFlag ? "live" : "scheduled",
      score: score || { home: 0, away: 0 },
      minute: Number(event?.minute ?? event?.liveMinute ?? event?.elapsed ?? 0) || 0
    };
  } catch (err) {
    log("WARN", "polymarket_live_state_failed", "Could not refresh live state from Polymarket", {
      eventId: match.eventId, message: err.message
    });
    return null;
  }
}

function extractPolymarketScore(event) {
  const candidates = [
    event?.score,
    event?.scores,
    event?.liveScore,
    event?.live_score,
    event?.currentScore,
    event?.current_score
  ];
  for (const value of candidates) {
    if (!value) continue;
    const home = Number(value.home ?? value.homeScore ?? value.home_score);
    const away = Number(value.away ?? value.awayScore ?? value.away_score);
    if (Number.isFinite(home) && Number.isFinite(away)) return { home, away };
  }
  const home = Number(event?.homeScore ?? event?.home_score);
  const away = Number(event?.awayScore ?? event?.away_score);
  if (Number.isFinite(home) && Number.isFinite(away)) return { home, away };
  return null;
}

async function candidateRequest(path, body = null) {
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  const response = await fetch(base.replace(/\/$/, "") + path, {
    method: body === null ? "GET" : "POST",
    headers: body === null ? undefined : { "content-type": "application/json" },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error("Convex candidate HTTP " + response.status);
  return body === null ? response.json() : null;
}

async function loadPersistedCandidates() {
  try {
    const rows = await candidateRequest("/football/candidates");
    let restored = 0;
    for (const row of Array.isArray(rows) ? rows : []) {
      try {
        const match = JSON.parse(row.data);
        if (!match?.eventId && !match?.slug) continue;
        const key = row.key || match.eventId || match.slug;
        prematchCandidates.set(key, match);
        if (row.buySent || row.startedSent || row.sellSent) oneOneState.set(key, { prematchSeen: true });
        if (row.startedSent) oneOneState.set(key, { ...(oneOneState.get(key) || {}), startedSent: true });
        if (row.sellSent) oneOneState.set(key, { ...(oneOneState.get(key) || {}), sellSent: true });
        restored++;
      } catch {}
    }
    log("INFO", "persistent_candidates_loaded", "Restored PRE-MATCH candidates from Convex", { restored });
    return restored;
  } catch (err) {
    log("WARN", "persistent_candidates_load_failed", "Could not restore PRE-MATCH candidates; discovery continues", { message: err.message });
    return 0;
  }
}

async function persistPrematchCandidates(discovered) {
  let admitted = 0;
  const now = Date.now();
  for (const match of discovered) {
    const kickoff = Date.parse(match.startTime || "");
    if (!Number.isFinite(kickoff) || kickoff <= now) continue;
    const key = match.eventId || match.slug;
    if (!key) continue;
    try {
      await candidateRequest("/football/candidates/admit", { key, data: JSON.stringify(match) });
      admitted++;
    } catch (err) {
      log("WARN", "candidate_persist_failed", "Could not persist PRE-MATCH candidate", { eventId: match.eventId, message: err.message });
    }
  }
  return admitted;
}

async function markCandidateStartedSent(key) {
  try { await candidateRequest("/football/candidates/mark-started", { key }); }
  catch (err) { log("WARN", "candidate_started_state_failed", "Could not persist STARTED state", { key, message: err.message }); }
}

async function markCandidateSellSent(key) {
  try { await candidateRequest("/football/candidates/mark-sell", { key }); }
  catch (err) { log("WARN", "candidate_sell_state_failed", "Could not persist SELL state", { key, message: err.message }); }
}

async function markCandidateBuySent(key) {
  try {
    await candidateRequest("/football/candidates/mark-buy", { key });
  } catch (err) {
    log("WARN", "candidate_buy_state_failed", "Could not persist BUY state", { key, message: err.message });
  }
}

async function claimTelegramAlert(key) {
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  try {
    const response = await fetch(base.replace(/\/$/, "") + "/football/claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ monitor: "polymarket-football", marketSlug: key }),
      signal: AbortSignal.timeout(2_000),
    });
    const body = await response.json().catch(() => ({}));
    if (response.status === 200) return { claimed: true, replyToMessageId: body.replyToMessageId ?? null };
    if (response.status === 409) return { claimed: false, replyToMessageId: null };
    throw new Error("Convex claim HTTP " + response.status);
  } catch (err) {
    log("ERROR", "telegram_claim_failed", "Persistent Telegram dedupe unavailable; alert blocked for safety", { key, message: err.message });
    return { claimed: false, replyToMessageId: null };
  }
}

async function saveTelegramMessageId(key, messageId) {
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  const response = await fetch(base.replace(/\/$/, "") + "/football/telegram-message", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ monitor: "polymarket-football", marketSlug: key, messageId }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error("Convex telegram-message HTTP " + response.status);
}

async function releaseTelegramAlert(key) {
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  try {
    const response = await fetch(base.replace(/\/$/, "") + "/football/release", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ monitor: "polymarket-football", marketSlug: key }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error("Convex release HTTP " + response.status);
  } catch (err) {
    log("WARN", "telegram_release_failed", "Could not release Telegram claim", { key, message: err.message });
  }
}

async function sendTelegram(textMessage, replyToMessageId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) {
    log("WARN", "telegram_not_configured", "Telegram credentials are not configured");
    return { ok: false, messageId: null };
  }
  const url = "https://api.telegram.org/bot" + token + "/sendMessage";
  const payload = {
    chat_id: chatId,
    text: textMessage,
    disable_web_page_preview: false,
    ...(Number.isInteger(replyToMessageId) ? {
      reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true }
    } : {})
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("Telegram HTTP " + response.status);
  const body = await response.json();
  if (!body.ok) throw new Error("Telegram API rejected message");
  return { ok: true, messageId: Number(body.result?.message_id) || null };
}

async function runCycle() {
  return await tick();
}

async function main(){
  console.log(JSON.stringify({event:"monitor_start",message:"football monitor continuous entrypoint started",runMs:RUN_MS,pollMs:POLL_MS,createdAt:Date.now()}));
  await loadPersistedCandidates();
  const deadline=Date.now()+RUN_MS;
  let cycle=0;
  while(!stopping && Date.now()<deadline){
    cycle++;
    const matchesFound=await runCycle();
    const remaining=Math.max(0,deadline-Date.now());
    console.log(JSON.stringify({event:"monitor_cycle_complete",cycle,matchesFound,remainingMs:remaining,createdAt:Date.now()}));
    if(remaining<=0)break;
    await new Promise(resolve=>setTimeout(resolve,Math.min(POLL_MS,remaining)));
  }
  await flushConvexLogs();
  console.log(JSON.stringify({event:"monitor_exit",message:"football continuous monitor window completed",cycles:cycle,createdAt:Date.now()}));
}

process.on("SIGTERM",()=>{stopping=true;});
process.on("SIGINT",()=>{stopping=true;});
main().catch(async(error)=>{
  log("ERROR","monitor_failed","Football monitor terminated unexpectedly",{message:error?.message||String(error),stack:error?.stack});
  await flushConvexLogs();
  process.exitCode=1;
});

// football-monitor-trigger
