const GAMMA_URL = "https://gamma-api.polymarket.com";
const SPORTScore_URL = "https://sportscore.com/api/widget";

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
  return text(v).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
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
async function getJson(url,options={}){const r=await fetch(url,{...options,headers:{accept:"application/json",...(options.headers||{})},signal:AbortSignal.timeout(10_000)});if(!r.ok)throw new Error("HTTP "+r.status+" for "+url);return r.json();}
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
  if (Date.now() - nutmegCache.at < NUTMEG_CACHE_MS) return nutmegCache.rows;
  const rows = [];
  const pages = [1, 2, 3, 4, 5];
  const statuses = ["upcoming", "live"];
  const jobs = [];
  for (const status of statuses) for (const page of pages) jobs.push({ status, page });

  const results = await Promise.all(jobs.map(async ({ status, page }) => {
    try {
      const url = "https://nutmegly.com/?competition=all&page=" + page + "&status=" + status + "&tz=UTC";
      const r = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(8_000) });
      if (!r.ok) return [];
      const body = stripHtml(await r.text());
      const out = [];
      const re = /(.{2,100}?)\s+VS\s+(.{2,100}?)\s+Home win\s*(\d+(?:\.\d+)?)%\s+Draw\s*(\d+(?:\.\d+)?)%\s+Away win\s*(\d+(?:\.\d+)?)%/gi;
      let m;
      while ((m = re.exec(body))) out.push({
        home: m[1].trim(), away: m[2].trim(),
        homeProb: Number(m[3]) / 100, drawProb: Number(m[4]) / 100,
        awayProb: Number(m[5]) / 100, bttsProb: NaN
      });
      return out;
    } catch (err) {
      log("WARN", "nutmeg_fetch_failed", "Nutmegly page fetch failed", { status, page, message: err.message });
      return [];
    }
  }));
  for (const part of results) rows.push(...part);
  nutmegCache = { at: Date.now(), rows };
  log("INFO", "nutmeg_refresh", "Nutmegly balance data refreshed", { rows: rows.length });
  return rows;
}

function findNutmegMatch(match, rows) {
  let best = null, bestScore = 0;
  for (const row of rows) {
    const direct = teamSimilarity(match.homeTeam, row.home) + teamSimilarity(match.awayTeam, row.away);
    const swapped = teamSimilarity(match.homeTeam, row.away) + teamSimilarity(match.awayTeam, row.home);
    const score = Math.max(direct, swapped);
    if (score > bestScore) { bestScore = score; best = row; }
  }
  return best && bestScore >= 1.35 ? { row: best, score: bestScore } : null;
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
    const data = await getJson(GAMMA_URL + "/events/" + encodeURIComponent(match.eventId));
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
    const claimed = await claimTelegramAlert(claimKey);
    if (!claimed) return;

    const message = [
      "⚽ 1:1 · BUY", "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: 0–0",
      "", "➡️ OPEN MATCH", match.url
    ].join("\n");

    try {
      if (!await sendTelegram(message)) throw new Error("Telegram not configured");
      log("INFO", "one_one_buy_alert_sent", "1:1 entry alert sent", {
        eventId: match.eventId, preMatch, reason: "balanced_nutmeg_candidate"
      });
    } catch (err) {
      await releaseTelegramAlert(claimKey);
      log("ERROR", "telegram_send_failed", "BUY alert send failed; claim released", {
        eventId: match.eventId, message: err.message
      });
    }
    return;
  }

  // SELL is a second phase. First exit at 0:1 or 1:0; once that
  // transition has happened, 1:1 is also a valid later SELL state.
  if ((home === 1 && away === 0) || (home === 0 && away === 1) || (home === 1 && away === 1)) {
    const claimKey = key + ":SELL";
    const claimed = await claimTelegramAlert(claimKey);
    if (!claimed) return;

    const message = [
      "⚽ 1:1 · SELL", "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: " + home + "–" + away,
      "", "➡️ OPEN MATCH", match.url
    ].join("\n");

    try {
      if (!await sendTelegram(message)) throw new Error("Telegram not configured");
      log("INFO", "one_one_sell_alert_sent", "1:1 exit alert sent after first goal", {
        eventId: match.eventId,
        score: { home, away },
        recovery: home === 1 && away === 1
      });
    } catch (err) {
      await releaseTelegramAlert(claimKey);
      log("ERROR", "telegram_send_failed", "SELL alert send failed; claim released", {
        eventId: match.eventId, message: err.message
      });
    }
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
    log("INFO", "stage_done", "Discovery stage finished", {
      stage: "polymarket_discovery", elapsedMs: Date.now() - tickStartedAt, candidates: matches.length
    });

    const nutmegStartedAt = Date.now();
    log("INFO", "stage_start", "Nutmeg stage started", { stage: "nutmeg" });
    const nutmeg = await nutmegRows();
    log("INFO", "stage_done", "Nutmeg stage finished", {
      stage: "nutmeg", elapsedMs: Date.now() - nutmegStartedAt, rows: nutmeg.length
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
      const m = text(match.slug).match(/(?:^|-)((?:20)\d{2}-\d{2}-\d{2})(?:-|$)/);
      return m ? m[1] : null;
    };
    // Gamma startDate is often the event publication/update timestamp, not
    // the fixture kickoff. The fixture date in the Polymarket slug is the
    // reliable date signal for live-vs-future classification.
    const liveCandidates = matches.filter(m => fixtureDate(m) === todayUtc);
    const preMatchCandidates = matches.filter(m => {
      const d = fixtureDate(m);
      return Boolean(d && d > todayUtc);
    });
    log("INFO", "match_timing_classified", "Classified football candidates by fixture date", {
      todayUtc,
      total: matches.length,
      liveToday: liveCandidates.length,
      preMatchFuture: preMatchCandidates.length,
      unknownDate: matches.length - liveCandidates.length - preMatchCandidates.length
    });

    const sportscoreStartedAt = Date.now();
    log("INFO", "stage_start", "SportScore stage started", {
      stage: "sportscore", liveCandidates: liveCandidates.length
    });
    await enrichLiveMatches(liveCandidates);
    log("INFO", "stage_done", "SportScore stage finished", {
      stage: "sportscore", elapsedMs: Date.now() - sportscoreStartedAt, liveCandidates: liveCandidates.length
    });

    const evaluationStartedAt = Date.now();
    log("INFO", "stage_start", "Alert evaluation stage started", {
      stage: "evaluation", candidates: matches.length
    });

    // Load missing event markets concurrently before evaluation. The old
    // per-match lazy loading could serialize up to 10s per candidate and
    // prevent the monitor from ever reaching the alert decision.
    const marketLoads = matches.filter(m =>
      (!Array.isArray(m.markets) || !m.markets.length) && m.eventId
    );
    if (marketLoads.length) {
      log("INFO", "event_markets_batch_start", "Preloading missing Polymarket event markets", {
        count: marketLoads.length
      });
      await Promise.all(marketLoads.map(match => ensureEventMarkets(match)));
      log("INFO", "event_markets_batch_done", "Finished preloading Polymarket event markets", {
        count: marketLoads.length
      });
    }

    for (const match of matches) {
      const slugDate = text(match.slug).match(/(?:^|-)((?:20)\d{2}-\d{2}-\d{2})(?:-|$)/)?.[1] || null;
      const preMatch = Boolean(slugDate && slugDate > new Date().toISOString().slice(0, 10));

      if (preMatch) {
        const nm = findNutmegMatch(match, nutmeg);
        log("INFO", "candidate_match_found", "Pre-match 1:1 candidate evaluated", {
          eventId: match.eventId,
          teams: [match.homeTeam, match.awayTeam],
          preMatch: true,
          nutmegMatched: Boolean(nm),
          nutmegScore: nm?.score ?? null,
          balanced: balancedForOneOne(nm),
                  });

        if (!nm || !balancedForOneOne(nm)) {
          log("INFO", "candidate_rejected_buy_filter", "Pre-match candidate rejected by Nutmegly", {
            eventId: match.eventId,
            teams: [match.homeTeam, match.awayTeam],
            nutmeg: nm?.row || null
          });
          continue;
        }

        await maybeOneOneAlert({
          ...match,
          live: { status: "scheduled", score: { home: 0, away: 0 }, minute: 0 }
        }, nm);
        continue;
      }

      // Live phase is deliberately split from BUY filtering.
      // SELL must never depend on Nutmegly or on the BUY filters.
      if (match.live?.status === "provider_error") continue;
      if (match.live?.status === "unresolved") {
        log("INFO", "match_unresolved", "Started candidate has no SportScore fixture match", {
          eventId: match.eventId,
          teams: [match.homeTeam, match.awayTeam]
        });
        continue;
      }

      const score = match.live?.score || { home: 0, away: 0 };

      log("INFO", "live_candidate_observed", "Live candidate observed", {
        eventId: match.eventId,
        teams: [match.homeTeam, match.awayTeam],
        score,
        minute: match.live?.minute ?? 0
      });

      // At 0:0, apply BUY filters.
      if (Number(score.home) === 0 && Number(score.away) === 0) {
        const nm = findNutmegMatch(match, nutmeg);
        log("INFO", "candidate_match_found", "Live 0:0 candidate evaluated for BUY", {
          eventId: match.eventId,
          teams: [match.homeTeam, match.awayTeam],
          preMatch: false,
          score,
          nutmegMatched: Boolean(nm),
          nutmegScore: nm?.score ?? null,
          balanced: balancedForOneOne(nm),
          price: findOneOneMarket(match)?.price ?? null
        });

        if (!nm || !balancedForOneOne(nm)) {
          log("INFO", "candidate_rejected_buy_filter", "Live 0:0 candidate rejected by Nutmegly", {
            eventId: match.eventId,
            teams: [match.homeTeam, match.awayTeam],
            nutmeg: nm?.row || null
          });
          continue;
        }

        await maybeOneOneAlert({ ...match, live: { ...match.live, score }, preMatch: false }, nm);
        continue;
      }

      // After kickoff and after a goal, do not run BUY filters.
      // maybeOneOneAlert sends SELL only for exactly 1:0/0:1,
      // and Convex rejects SELL unless the BUY phase was completed.
      await maybeOneOneAlert({ ...match, live: { ...match.live, score }, preMatch: false }, null);
    }

    log("INFO", "stage_done", "Alert evaluation stage finished", {
      stage: "evaluation", elapsedMs: Date.now() - evaluationStartedAt, candidates: matches.length
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


function participants(fixture) {
  return Array.isArray(fixture?.participants) ? fixture.participants : [];
}

function fixtureTeams(fixture) {
  const parts = participants(fixture);
  const home = parts.find(p => p.meta?.location === "home") || parts.find(p => p.location === "home");
  const away = parts.find(p => p.meta?.location === "away") || parts.find(p => p.location === "away");
  return { home: text(home?.name), away: text(away?.name) };
}

function sportscoreSlug(url) {
  const m = text(url).match(/\/football\/match\/([^/?#]+)\/?$/i);
  return m ? m[1] : "";
}

async function sportscoreLatest() {
  const url = SPORTScore_URL + "/matches/?sport=football&limit=50";
  const data = await getJson(url);
  return Array.isArray(data?.matches) ? data.matches : [];
}

async function sportscoreMatch(slug) {
  const url = SPORTScore_URL + "/match/?sport=football&slug=" + encodeURIComponent(slug);
  const data = await getJson(url);
  return data?.match || null;
}

function normalizeSportScore(match) {
  const parts = participants(match);
  const partHome = parts.find(p => p.meta?.location === "home") || parts.find(p => p.location === "home");
  const partAway = parts.find(p => p.meta?.location === "away") || parts.find(p => p.location === "away");
  const home = text(match.home || match.homeTeam || partHome?.name);
  const away = text(match.away || match.awayTeam || partAway?.name);
  const scoreHome = Number(match.home_score ?? match.score?.home ?? match.scores?.home ?? 0);
  const scoreAway = Number(match.away_score ?? match.score?.away ?? match.scores?.away ?? 0);
  const minute = Number(match.live_minute ?? match.minute ?? 0);
  return {
    fixtureId: text(match.url) || home + ":" + away,
    name: home + " vs " + away,
    homeTeam: home, awayTeam: away, minute: Number.isFinite(minute) ? minute : 0,
    score: { home: scoreHome, away: scoreAway },
    startingAt: match.time || match.start_time || null,
    stateId: text(match.status),
    events: Array.isArray(match.incidents) ? match.incidents : []
  };
}

function resolveSportScore(match, fixtures) {
  let best = null, bestScore = 0;
  for (const fixture of fixtures) {
    const direct = teamSimilarity(match.homeTeam, fixture.home) + teamSimilarity(match.awayTeam, fixture.away);
    const swapped = teamSimilarity(match.homeTeam, fixture.away) + teamSimilarity(match.awayTeam, fixture.home);
    const score = Math.max(direct, swapped);
    if (score > bestScore) { bestScore = score; best = fixture; }
  }
  if (!best || bestScore < 1.4) return null;
  return { fixture: best, score: bestScore };
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

async function enrichLiveMatches(polymarketMatches) {
  let fixtures = [];
  try {
    fixtures = await sportscoreLatest();
  } catch (err) {
    // SportScore is enrichment only. A provider failure must not abort the
    // discovery/evaluation pipeline; pre-match candidates can still continue.
    log("WARN", "sportscore_unavailable", "SportScore unavailable; continuing without live enrichment", {
      message: err.message
    });
    for (const match of polymarketMatches) {
      match.live = { status: "provider_unavailable" };
    }
    return;
  }

  const candidateFixtures = fixtures.filter(f =>
    /live|in progress|1st half|2nd half|halftime|playing|started|ongoing|scheduled|upcoming|not started|fixture/i
      .test(text(f.status) + " " + text(f.status_text))
  );

  // Resolve and refresh live fixtures concurrently. The old sequential loop
  // could spend up to 10s per fixture, turning a normal scan into an hours-long
  // run before the alert logic was reached.
  const work = polymarketMatches.map(async match => {
    const key = match.eventId || match.slug;
    let resolvedMatch = resolved.get(key);
    if (!resolvedMatch) {
      const found = resolveSportScore(match, candidateFixtures);
      if (found) {
        const slug = sportscoreSlug(found.fixture.url);
        if (!slug) {
          log("WARN", "sportscore_slug_missing", "SportScore fixture has no usable slug", { fixture: found.fixture });
        } else {
          resolvedMatch = { fixtureId: slug, confidence: found.score };
          resolved.set(key, resolvedMatch);
          log("INFO", "match_resolved", "Polymarket match linked to SportScore", {
            eventId: match.eventId, polymarketTeams: [match.homeTeam, match.awayTeam],
            sportscoreTeams: [found.fixture.home, found.fixture.away], confidence: found.score, fixture: slug
          });
        }
      }
    }

    if (!resolvedMatch) {
      match.live = { status: "unresolved" };
      return;
    }

    const detail = await sportscoreMatch(resolvedMatch.fixtureId).catch(err => {
      log("WARN", "fixture_failed", "SportScore match refresh failed", { fixture: resolvedMatch.fixtureId, message: err.message });
      return null;
    });

    if (!detail) {
      match.live = { status: "provider_error" };
      return;
    }

    match.provider = "sportscore";
    match.providerFixtureId = resolvedMatch.fixtureId;
    match.live = normalizeSportScore(detail);
  });

  await Promise.all(work);
}

async function claimTelegramAlert(key) {
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  try {
    const response = await fetch(base.replace(/\/$/, "") + "/football/claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ monitor: "polymarket-football-1-1", marketSlug: key }),
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status === 200) return true;
    if (response.status === 409) return false;
    throw new Error("Convex claim HTTP " + response.status);
  } catch (err) {
    log("ERROR", "telegram_claim_failed", "Persistent Telegram dedupe unavailable; alert blocked for safety", { key, message: err.message });
    return false;
  }
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

async function sendTelegram(textMessage) {
  const token = process.env.TELEGRAM_BOT_TOKEN || "";
  const chatId = process.env.TELEGRAM_CHAT_ID || "";
  if (!token || !chatId) {
    log("WARN", "telegram_not_configured", "Telegram credentials are not configured");
    return false;
  }
  const url = "https://api.telegram.org/bot" + token + "/sendMessage";
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: textMessage, disable_web_page_preview: false }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error("Telegram HTTP " + response.status);
  const body = await response.json();
  if (!body.ok) throw new Error("Telegram API rejected message");
  return true;
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
