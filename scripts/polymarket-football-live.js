const GAMMA_URL = "https://gamma-api.polymarket.com";

const POLL_MS = 20_000;
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
    .normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "")
    .replace(/&/g, "and")
    .replace(/\\b(fc|cf|sc|afc|ac|club|football club)\\b/g, " ")
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
function isPrimaryMatchEvent(event){const title=text(event.title||event.question);return /\s(?:vs\.?|v\.?|versus)\s/i.test(title);}
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
  await checkpoint("discovery_start",{strategy:"football_fixture_first_v8",source:"soccer_tag",note:"Polymarket discovery identifies football fixtures only; strategy filtering happens after Nutmeg matching"});
  const sources=[
    {name:"soccer_newest",baseUrl:GAMMA_URL+"/events?tag_slug=soccer&active=true&closed=false&limit=100&order=id&ascending=false"},
    {name:"soccer_live",baseUrl:GAMMA_URL+"/events?tag_slug=soccer&live=true&active=true&closed=false&limit=100&order=id&ascending=false"},
    {name:"sports_newest",baseUrl:GAMMA_URL+"/events?tag_id=100639&active=true&closed=false&limit=100&order=id&ascending=false"}
  ];
  const pagePlan={soccer_newest:3,soccer_live:1,sports_newest:2};
  const sourcePages=sources.flatMap(source=>Array.from({length:pagePlan[source.name]??1},(_,page)=>({name:source.name,url:source.baseUrl+"&offset="+(page*100),page})));
  const results=await Promise.all(sourcePages.map(async source=>{try{const response=await fetch(source.url,{headers:{accept:"application/json"},signal:AbortSignal.timeout(10_000)}),body=await response.text();if(!response.ok)throw new Error("HTTP "+response.status+" for "+source.url);let data;try{data=JSON.parse(body);}catch(error){throw error;}const rows=Array.isArray(data)?data:(data?.events||data?.data||[]);log("INFO","event_source_response","Raw Polymarket football source response captured",{source:source.name,status:response.status,rowCount:rows.length,bodyBytes:Buffer.byteLength(body,"utf8")});return{name:source.name,rows,error:null};}catch(error){return{name:source.name,rows:[],error};}}));
  for(const result of results){if(result.error){log("WARN","event_source_failed","Polymarket football source failed",{source:result.name,message:result.error.message});continue;}eventScanned+=result.rows.length;for(const event of result.rows){if(!event||event.active===false||event.closed===true)continue;const hay=[event.sport,event.sportSlug,event.sport_slug,event.category,event.tags,event.title,event.question].flat(Infinity).map(text).join(" ");const footballSource=result.name==="soccer_newest"||result.name==="soccer_live";if(!footballSource&&!/football|soccer|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league/i.test(hay))continue;footballEventFound++;if(!isPrimaryMatchEvent(event)){log("INFO","non_fixture_filtered","Football event has no recognizable fixture form; not passed to Nutmeg",{eventId:text(event.id||event.eventId||event.event_id),title:text(event.title||event.question),source:result.name});continue;}const [home,away]=extractTeams(event);if(!home||!away){log("INFO","match_teams_missing","Football event has no recognizable teams",{eventId:text(event.id),title:text(event.title)});continue;}const startTime=event.startDate||event.start_date||event.startTime||null,endTime=event.endDate||event.end_date||event.endTime||null,eventId=text(event.id||event.eventId||event.event_id),slug=text(event.slug),key=eventId||slug;if(!key){log("WARN","match_identity_missing","Football match has teams but no event id/slug",{title:text(event.title||event.question),home,away});continue;}const nestedMarkets=Array.isArray(event.markets)?event.markets.map(market=>({marketId:text(market?.id||market?.marketId),question:text(market?.question||market?.title),outcomes:Array.isArray(parseJson(market?.outcomes))?parseJson(market.outcomes):[],outcomePrices:Array.isArray(parseJson(market?.outcomePrices||market?.outcome_prices))?parseJson(market?.outcomePrices||market?.outcome_prices):[],active:market?.active!==false,closed:market?.closed===true})):[];const groupKey=fixtureKey(home,away,startTime);
      const existing=groups.get(groupKey);
      if(existing){
        childMarketEventsGrouped++;
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
function stripHtml(value) {
  return text(value).replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
}

async function nutmegRows() {
  if (Date.now() - nutmegCache.at < NUTMEG_CACHE_MS) {
    return { rows: nutmegCache.rows, providerUnavailable: nutmegCache.providerUnavailable };
  }

  const rows = [];
  let successfulPages = 0;
  const pages = [1, 2, 3, 4, 5, 6];

  const results = await Promise.all(pages.map(async page => {
    try {
      const url = "https://nutmegly.com/?competition=all&page=" + page + "&tz=UTC";
      const r = await fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128 Safari/537.36"
        },
        signal: AbortSignal.timeout(8_000)
      });
      if (!r.ok) throw new Error("HTTP " + r.status);

      const raw = await r.text();
      const body = stripHtml(raw)
        .replace(/\u00a0/g, " ")
        .replace(/[ \t]+/g, " ")
        .replace(/\n+/g, " ")
        .trim();

      const out = [];

      // Nutmegly's public fixture pages have changed their rendered spacing
      // several times. Keep the probability parser independent of exact spaces
      // and recover teams from the fixture text immediately before each block.
      const probabilityRe =
        /Home\s*win\s*(\d+(?:\.\d+)?)\s*%\s*Draw\s*(\d+(?:\.\d+)?)\s*%\s*Away\s*win\s*(\d+(?:\.\d+)?)\s*%/gi;

      let m;
      while ((m = probabilityRe.exec(body))) {
        const prefix = body.slice(Math.max(0, m.index - 1800), m.index);
        const team = "[\\p{L}\\p{N}.'’&()\\-]+(?:[ \\t]+[\\p{L}\\p{N}.'’&()\\-]+){0,10}";

        // Match from the end of the prefix so navigation/previous cards do not
        // become the selected fixture.
        const liveMatches = [...prefix.matchAll(new RegExp(
          "(" + team + ")\\s+(\\d+)\\s*-\\s*(\\d+)\\s+(\\d{1,3})['’]\\s+(" + team + ")\\s*$",
          "giu"
        ))];

        const finishedMatches = [...prefix.matchAll(new RegExp(
          "(" + team + ")\\s+(\\d+)\\s*-\\s*(\\d+)\\s+(" + team + ")\\s*$",
          "giu"
        ))];

        const upcomingMatches = [...prefix.matchAll(new RegExp(
          "(" + team + ")\\s+\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}\\s+Kicking\\s+off\\s+soon\\s+(" + team + ")\\s*$",
          "giu"
        ))];

        const vsMatches = [...prefix.matchAll(new RegExp(
          "(" + team + ")\\s+(?:vs\\.?|v\\.?|versus)\\s+(" + team + ")\\s*$",
          "giu"
        ))];

        const live = liveMatches.at(-1) || null;
        const finished = finishedMatches.at(-1) || null;
        const upcoming = upcomingMatches.at(-1) || null;
        const vs = vsMatches.at(-1) || null;
        const candidate = live || finished || upcoming || vs;
        const prefixWindow = prefix.slice(Math.max(0, prefix.length - 900));
        const nutmegLiveMarker = /\bLIVE\b/i.test(prefixWindow);
        if (!candidate) continue;

        let home = "";
        let away = "";
        let score = null;
        let minute = null;

        if (candidate === live) {
          home = live[1].trim();
          away = live[5].trim();
          score = { home: Number(live[2]), away: Number(live[3]) };
          minute = Number(String(live[4]).replace(/[^0-9]/g, ""));
        } else if (candidate === finished) {
          home = finished[1].trim();
          away = finished[4].trim();
          score = { home: Number(finished[2]), away: Number(finished[3]) };
          minute = null;
        } else {
          home = candidate[1].trim();
          away = candidate[2].trim();
        }

        if (!home || !away) continue;

        out.push({
          home,
          away,
          homeProb: Number(m[1]) / 100,
          drawProb: Number(m[2]) / 100,
          awayProb: Number(m[3]) / 100,
          bttsProb: NaN,
          live: Boolean(score) && nutmegLiveMarker,
          finished: Boolean(score) && !nutmegLiveMarker && minute == null,
          score,
          minute
        });
      }

      successfulPages++;
      return out;
    } catch (err) {
      log("WARN", "nutmeg_fetch_failed", "Nutmegly page fetch failed", {
        page, message: err.message
      });
      return [];
    }
  }));

  for (const part of results) rows.push(...part);

  const providerUnavailable = successfulPages === 0;
  nutmegCache = { at: Date.now(), rows, providerUnavailable };

  log("INFO", "nutmeg_refresh", "Nutmegly balance data refreshed", {
    rows: rows.length,
    successfulPages,
    providerUnavailable
  });

  if (rows.length === 0 && successfulPages > 0) {
    log("WARN", "nutmeg_parse_zero", "Nutmegly pages loaded but no probability blocks were parsed", {
      pages: successfulPages
    });
  }

  return { rows, providerUnavailable };
}

function findNutmegMatch(match, rows) {
  let best = null, bestScore = 0, bestSwapped = false;
  for (const row of rows) {
    const direct = teamSimilarity(match.homeTeam, row.home) + teamSimilarity(match.awayTeam, row.away);
    const swapped = teamSimilarity(match.homeTeam, row.away) + teamSimilarity(match.awayTeam, row.home);
    const isSwapped = swapped > direct;
    const score = isSwapped ? swapped : direct;
    if (score > bestScore) { bestScore = score; best = row; bestSwapped = isSwapped; }
  }
  if (!best || bestScore < 1.35) return null;
  const normalizedRow = bestSwapped
    ? {
        ...best,
        home: match.homeTeam,
        away: match.awayTeam,
        homeProb: best.awayProb,
        awayProb: best.homeProb,
        score: best.score ? { home: best.score.away, away: best.score.home } : null,
        finished: Boolean(best.finished)
      }
    : best;
  return { row: normalizedRow, score: bestScore, swapped: bestSwapped };
}

function balancedForOneOne(nutmeg) {
  if (!nutmeg) return false;
  const r = nutmeg.row;
  return Math.abs(r.homeProb - r.awayProb) <= BALANCE_MAX_DIFF &&
    r.drawProb >= MIN_DRAW_PROB &&
    (!Number.isFinite(r.bttsProb) || r.bttsProb >= MIN_BTTS_PROB);
}

async function ensureEventMarkets(match) {
  if (Array.isArray(match.markets) && match.markets.length) return true;
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
    log("INFO", "event_markets_loaded", "Loaded event markets lazily", {
      eventId: match.eventId,
      marketCount: match.markets.length,
      oneOneMarketAvailable: Boolean(findOneOneMarket(match)),
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

async function maybeOneOneAlert(match, nutmeg) {
  if (!match.url) return;

  const key = match.eventId || match.slug;
  const preMatch = Boolean(match.preMatch);
  const home = Number(match.live?.score?.home || 0);
  const away = Number(match.live?.score?.away || 0);

  if (!preMatch && (!match.live || match.live.status === "unresolved" || match.live.status === "provider_error" || match.live.status === "provider_unavailable")) return;

  if (preMatch || (home === 0 && away === 0)) {
    const claimKey = key + ":BUY";
    const claim = await claimTelegramAlert(claimKey);
    if (!claim.claimed) return;

    const message = [
      "⚽ 1:1 · BUY", "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: 0–0",
      "", "➡️ OPEN MATCH", match.url
    ].join("\n");

    try {
      const sent = await sendTelegram(message);
      if (!sent.ok) throw new Error("Telegram not configured");
      await saveTelegramMessageId(claimKey, sent.messageId);
      log("INFO", "one_one_buy_alert_sent", "1:1 entry alert sent", {
        eventId: match.eventId, preMatch, reason: "balanced_nutmeg_candidate", telegramMessageId: sent.messageId
      });
    } catch (err) {
      await releaseTelegramAlert(claimKey);
      log("ERROR", "telegram_send_failed", "BUY alert send failed; claim released", {
        eventId: match.eventId, message: err.message
      });
    }
    return;
  }

  // A BUY that remains 0:0 through full time is a LOSS. Nutmegly is
  // the authoritative score source for this final-state check.
  if (match.live?.finished && home === 0 && away === 0) {
    const claimKey = key + ":LOSS";
    const claim = await claimTelegramAlert(claimKey);
    if (!claim.claimed) return;

    const message = [
      "⚽ 1:1 · LOSS", "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: 0–0",
      "", "➡️ OPEN MATCH", match.url
    ].join("\n");

    try {
      const sent = await sendTelegram(message, claim.replyToMessageId);
      if (!sent.ok) throw new Error("Telegram not configured");
      log("INFO", "one_one_loss_alert_sent", "1:1 loss alert sent as Telegram reply to BUY", {
        eventId: match.eventId, score: { home, away }, replyToMessageId: claim.replyToMessageId
      });
    } catch (err) {
      await releaseTelegramAlert(claimKey);
      log("ERROR", "telegram_send_failed", "LOSS alert send failed; claim released", {
        eventId: match.eventId, message: err.message
      });
    }
    return;
  }

  // SELL requires a BUY first. The first SELL is only at 0:1 or 1:0.
  // A later 1:1 SELL is allowed only after that first-goal state was observed.
  const firstGoal = (home === 1 && away === 0) || (home === 0 && away === 1);
  const recovery = home === 1 && away === 1;
  if (!firstGoal && !recovery) return;

  if (firstGoal) {
    const firstGoalKey = key + ":FIRST_GOAL";
    await claimTelegramAlert(firstGoalKey);
  }

  const claimKey = key + (recovery ? ":SELL_11" : ":SELL");
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
    log("INFO", "one_one_sell_alert_sent", "1:1 exit alert sent as Telegram reply to BUY", {
      eventId: match.eventId, score: { home, away }, recovery, replyToMessageId: claim.replyToMessageId
    });
  } catch (err) {
    await releaseTelegramAlert(claimKey);
    log("ERROR", "telegram_send_failed", "SELL alert send failed; claim released", {
      eventId: match.eventId, message: err.message
    });
  }

}

async function tick() {
  if (stopping || tick.running) return;
  tick.running = true;
  convexTickCount += 1;

  try {
    const tickStartedAt = Date.now();
    log("INFO", "stage_start", "Discovery stage started", { stage: "polymarket_discovery" });
    const matches = await discoverPolymarket();
    const cycle = { matches: matches.length, nutmegMatched: 0, preMatch: 0, live: 0, liveZeroZero: 0, evaluations: 0, buyPassed: 0, buyRejected: 0, sellEvaluated: 0, liveStateUnavailable: 0, buySent: 0, sellSent: 0 };
    log("INFO", "stage_done", "Discovery stage finished", {
      stage: "polymarket_discovery", elapsedMs: Date.now() - tickStartedAt, candidates: matches.length
    });

    const nutmegStartedAt = Date.now();
    log("INFO", "stage_start", "Nutmeg stage started", { stage: "nutmeg" });
    const nutmegResult = await nutmegRows();
    const nutmeg = nutmegResult.rows;
    const candidateFallback = nutmegResult.providerUnavailable;
    log("INFO", "stage_done", "Nutmeg stage finished", {
      stage: "nutmeg",
      elapsedMs: Date.now() - nutmegStartedAt,
      rows: nutmeg.length,
      providerUnavailable: candidateFallback
    });

    log("INFO", "polymarket_discovery", "Event-first football 1:1 candidates discovered", {
      count: matches.length,
      matches: matches.map(m => ({
        eventId: m.eventId,
        teams: [m.homeTeam, m.awayTeam],
        startTime: m.startTime,
        url: m.url
      }))
    });

    const now = Date.now();
    const todayUtc = new Date(now).toISOString().slice(0, 10);
    const fixtureDate = match => {
      const slugMatch = text(match.slug).match(/(?:^|-)((?:20)\d{2}-\d{2}-\d{2})(?:-|$)/);
      if (slugMatch) return slugMatch[1];
      const parsed = Date.parse(match.startTime || "");
      return Number.isNaN(parsed) ? null : new Date(parsed).toISOString().slice(0, 10);
    };
    // Gamma startDate is often the event publication/update timestamp, not
    // the fixture kickoff. The fixture date in the Polymarket slug is the
    // reliable date signal for live-vs-future classification.
    const liveCandidates = matches.filter(m => {
      const d = fixtureDate(m);
      const kickoff = Date.parse(m.startTime || "");
      return d === todayUtc && (Number.isNaN(kickoff) || kickoff <= now);
    });
    const preMatchCandidates = matches.filter(m => {
      const d = fixtureDate(m);
      const kickoff = Date.parse(m.startTime || "");
      return Boolean(d && (d > todayUtc || (d === todayUtc && Number.isFinite(kickoff) && kickoff > now)));
    });
    log("INFO", "match_timing_classified", "Classified football candidates by fixture date", {
      todayUtc,
      total: matches.length,
      liveToday: liveCandidates.length,
      preMatchFuture: preMatchCandidates.length,
      unknownDate: matches.length - liveCandidates.length - preMatchCandidates.length
    });

    const evaluationStartedAt = Date.now();
    log("INFO", "stage_start", "Alert evaluation stage started", {
      stage: "evaluation", candidates: matches.length
    });

    // The 1:1 market is not a discovery or BUY gate. Do not load hundreds
    // of event-market payloads before reaching the alert decision.
    // Evaluate fixtures concurrently in bounded batches. A slow Gamma event
    // endpoint must never serialize hundreds of matches into a multi-minute tick.
    const EVAL_BATCH = 20;
    for (let batchStart = 0; batchStart < matches.length; batchStart += EVAL_BATCH) {
      const batch = matches.slice(batchStart, batchStart + EVAL_BATCH);
      await Promise.all(batch.map(async match => {
      // Nutmegly live state takes precedence over Gamma kickoff timestamps.
      // Gamma startDate can be a publication/update timestamp, so a live card
      // must never be misclassified as pre-match merely because kickoff metadata
      // is stale or inaccurate.
      const nm = findNutmegMatch(match, nutmeg);
      const nmIsLive = Boolean(nm?.row?.live && nm?.row?.score);
      const slugDate = text(match.slug).match(/(?:^|-)((?:20)\d{2}-\d{2}-\d{2})(?:-|$)/)?.[1] || null;
      const kickoff = Date.parse(match.startTime || "");
      const fixtureDay = slugDate || (Number.isNaN(kickoff) ? null : new Date(kickoff).toISOString().slice(0, 10));
      const preMatch = !nmIsLive && Boolean(
        fixtureDay &&
        (fixtureDay > new Date().toISOString().slice(0, 10) ||
         (fixtureDay === new Date().toISOString().slice(0, 10) && Number.isFinite(kickoff) && kickoff > Date.now()))
      );

      if (preMatch) {
        let candidateProvider = "nutmeg";
        let candidate = Boolean(nm && balancedForOneOne(nm));
                log("INFO", "candidate_evaluation", "Pre-match BUY filter evaluated", {
          eventId: match.eventId,
          teams: [match.homeTeam, match.awayTeam],
          preMatch: true,
          candidateProvider,
          nutmegMatched: Boolean(nm),
          nutmegScore: nm?.score ?? null,
          balanced: balancedForOneOne(nm),
          candidate
        });

        if (!candidate) {
          log("INFO", "candidate_rejected_buy_filter", "Pre-match candidate rejected", {
            eventId: match.eventId,
            teams: [match.homeTeam, match.awayTeam],
            candidateProvider,
            nutmeg: nm?.row || null
          });
          return;
        }

        await maybeOneOneAlert({
          ...match,
          live: { status: "scheduled", score: { home: 0, away: 0 }, minute: 0 }
        }, nm);
        return;
      }

      // Nutmegly live cards are the primary live-score source because the
      // same matched fixture already supplies the strategy probabilities.
      // Polymarket is retained only as a fallback if Nutmegly temporarily
      // has no live score for this fixture.
      const nmLive = nm;
      let liveState = null;
      if (nmLive?.row?.live && nmLive.row.score) {
        liveState = {
          status: "live",
          score: nmLive.row.score,
          minute: Number(nmLive.row.minute || 0),
          finished: Boolean(nmLive.row.finished)
        };
        log("INFO", "live_state_from_nutmeg", "Live score received from Nutmegly", {
          eventId: match.eventId,
          teams: [match.homeTeam, match.awayTeam],
          score: liveState.score,
          minute: liveState.minute,
          nutmegScore: nmLive.score,
          nutmegSwapped: Boolean(nmLive.swapped)
        });
      } else {
        liveState = await refreshPolymarketLiveState(match);
        if (liveState) {
          log("INFO", "live_state_from_polymarket_fallback", "Nutmegly live score unavailable; used Polymarket fallback", {
            eventId: match.eventId,
            teams: [match.homeTeam, match.awayTeam],
            score: liveState.score,
            minute: liveState.minute
          });
        }
      }
      if (!liveState) {
        log("INFO", "live_state_unavailable", "No live score available from Nutmegly or Polymarket; live alert evaluation skipped", {
          eventId: match.eventId,
          teams: [match.homeTeam, match.awayTeam],
          nutmegMatched: Boolean(nmLive),
          nutmegLive: Boolean(nmLive?.row?.live)
        });
        return;
      }
      match.live = liveState;
      const score = match.live.score || { home: 0, away: 0 };

      log("INFO", "live_candidate_observed", "Live candidate observed", {
        eventId: match.eventId,
        teams: [match.homeTeam, match.awayTeam],
        score,
        minute: match.live?.minute ?? 0
      });

      // At 0:0, apply BUY filters.
      if (Number(score.home) === 0 && Number(score.away) === 0) {
        const nm = findNutmegMatch(match, nutmeg);
        const candidateProvider = "nutmeg";
        const candidate = Boolean(nm && balancedForOneOne(nm));
        log("INFO", "candidate_evaluation", "Live 0:0 BUY filter evaluated", {
          eventId: match.eventId,
          teams: [match.homeTeam, match.awayTeam],
          preMatch: false,
          score,
          candidateProvider,
          nutmegMatched: Boolean(nm),
          nutmegScore: nm?.score ?? null,
          balanced: balancedForOneOne(nm),
          candidate,
          price: findOneOneMarket(match)?.price ?? null
        });

        if (!candidate) {
          log("INFO", "candidate_rejected_buy_filter", "Live 0:0 candidate rejected", {
            eventId: match.eventId,
            teams: [match.homeTeam, match.awayTeam],
            candidateProvider,
            nutmeg: nm?.row || null
          });
          return;
        }

        await maybeOneOneAlert({ ...match, live: { ...match.live, score }, preMatch: false }, nm);
        return;
      }

      // After kickoff and after a goal, do not run BUY filters.
      // maybeOneOneAlert sends SELL only for exactly 1:0/0:1,
      // and Convex rejects SELL unless the BUY phase was completed.
      cycle.sellEvaluated += 1;
       await maybeOneOneAlert({ ...match, live: { ...match.live, score, finished: Boolean(match.live?.finished) }, preMatch: false }, nmLive);
      }));
    }

    log("INFO", "stage_done", "Alert evaluation stage finished", {
      stage: "evaluation", elapsedMs: Date.now() - evaluationStartedAt, candidates: matches.length
    });
    log("INFO", "cycle_summary", "Football monitor cycle summary", {
      elapsedMs: Date.now() - tickStartedAt,
      ...cycle,
      note: "BUY candidate = only matches that passed Nutmegly balance filter; 1:1 market is not a discovery gate"
    });
    log("INFO", "tick_done", "Football monitor tick completed", {
      elapsedMs: Date.now() - tickStartedAt, candidates: matches.length
    });
    return matches.length;
  } catch (err) {
    log("ERROR", "discovery_failed", "Football 1:1 monitor tick failed; monitoring continues", {
      message: err.message
    });
  } finally {
    tick.running = false;
    await flushConvexLogs();
  }
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

async function claimTelegramAlert(key) {
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  try {
    const response = await fetch(base.replace(/\/$/, "") + "/football/claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ monitor: "polymarket-football-1-1", marketSlug: key }),
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
    body: JSON.stringify({ monitor: "polymarket-football-1-1", marketSlug: key, messageId }),
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error("Convex telegram-message HTTP " + response.status);
}

async function releaseTelegramAlert(key) {
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  try {
    const response = await fetch(base.replace(/\/$/, "") + "/football/release", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ monitor: "polymarket-football-1-1", marketSlug: key }),
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
