const GAMMA_URL = "https://gamma-api.polymarket.com";

const POLL_MS = 15_000; // Polymarket-only polling.
const MIN_EDGE = 0.01;
const RUN_MS = 5 * 60 * 60 * 1000 + 50 * 60 * 1000;
const HISTORY_MS = 20 * 60 * 1000;
const ALERT_BUCKET_MS = 60 * 1000;
const PREMATCH_WINDOW_MS = 0;
const EARLY_WINDOW_MS = 0;
const BALANCE_MAX_DIFF = 0.15; // BUY only when 1X2 home/away probabilities differ by at most 15 percentage points.
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

const STALE_RUN_CHECK_MS = 15_000;
let staleRunCheckPromise = null;
let lastStaleRunCheckAt = 0;

async function stopIfSuperseded() {
  if (stopping) return true;
  const currentRunId = Number(process.env.GITHUB_RUN_ID || 0);
  const token = process.env.GITHUB_TOKEN || "";
  if (!currentRunId || !token) return false;

  const now = Date.now();
  if (now - lastStaleRunCheckAt < STALE_RUN_CHECK_MS) return false;
  if (staleRunCheckPromise) return staleRunCheckPromise;

  lastStaleRunCheckAt = now;
  staleRunCheckPromise = (async () => {
    try {
      const url = "https://api.github.com/repos/laudinvil/Polymarket-Perps-Monitor/actions/workflows/polymarket-football-live.yml/runs?branch=main&per_page=20";
      const response = await fetch(url, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: "Bearer " + token,
          "x-github-api-version": "2022-11-28",
          "user-agent": "PolymarketFootballMonitor"
        },
        signal: AbortSignal.timeout(3_000)
      });
      if (!response.ok) throw new Error("GitHub Actions HTTP " + response.status);
      const body = await response.json();
      const newer = (Array.isArray(body.workflow_runs) ? body.workflow_runs : [])
        .find(run => Number(run.id) > currentRunId);

      if (newer) {
        stopping = true;
        log("WARN", "superseded_run_detected", "Newer football monitor run detected; stopping this run before another alert can be sent", {
          currentRunId,
          newerRunId: newer.id,
          newerRunNumber: newer.run_number,
          newerStatus: newer.status,
          newerHeadSha: newer.head_sha
        });
        return true;
      }
    } catch (err) {
      log("WARN", "stale_run_check_failed", "Could not verify whether a newer football monitor run exists; continuing current run", {
        currentRunId,
        message: err.message
      });
    } finally {
      staleRunCheckPromise = null;
    }
    return stopping;
  })();

  return staleRunCheckPromise;
}

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

function eventUrl(event){
  let slug=text(event.slug);
  if(!slug) return "";
  // Child-market events can carry the market suffix in their slug
  // (for example "-total-corners"). Alerts must always open the parent
  // fixture event, not a child market such as corners/goals/cards.
  slug=slug
    .replace(/-(?:more-markets|player-props?|total-(?:corners|goals|cards|shots)|first-team-to-score|last-team-to-score|exact-score|half-time-result|half-time|second-half-result|second-half|1st-half-result|1st-half|2nd-half-result|2nd-half|full-time-result|match-result|draw-no-bet|double-chance|both-teams-to-score|btts|to-score|team-totals?|alternate-lines?|correct-score|winning-margin|clean-sheet|win-to-nil)(?:-(?:home|away|draw))?(?:-.*)?$/i,"")
    .replace(/-starting-eleven-(?:home|away)(?:-.*)?$/i,"");
  return "https://polymarket.com/event/"+slug;
}

// Discovery must identify football fixtures, not decide whether a fixture is
// suitable for the strategy. Market variants are handled later by the
// strategy/market-selection stage. A title must still contain two sides in a
// normal match form so unrelated soccer events do not enter the fixture list.
const CHILD_MARKET_SUFFIX = /\s+-\s+(?:more markets|player props?|total (?:corners|goals|cards|shots)|first team to score|last team to score|exact score|half[- ]?time result|second half result|1st half result|2nd half result|match result|draw no bet|double chance|both teams to score|btts|to score|team totals?|alternate lines?|correct score|winning margin|clean sheet|win to nil|half[- ]?time|first half|second half).*$/i;

function cleanFixtureSide(value){return text(value).replace(CHILD_MARKET_SUFFIX,"").trim();}
function isStartingElevenEvent(event){
  const slug=text(event.slug||"").toLowerCase();
  const title=text(event.title||event.question||"").toLowerCase();
  return /(?:^|-)starting-eleven(?:-|$)/.test(slug) || /\bstarting\s+eleven\b/.test(title);
}
function parentFixtureSlug(slug){
  return text(slug).replace(/-starting-eleven-(?:home|away)(?:-.+)?$/i,"").replace(/-starting-eleven$/i,"");
}
function isPrimaryMatchEvent(event){
  if(isStartingElevenEvent(event)) return false;
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


async function discoverLivePageFixtures() {
  const url = "https://polymarket.com/sports/live";
  try {
    const response = await fetch(url, {headers:{accept:"text/html,application/xhtml+xml","user-agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/150 Safari/537.36"},signal:AbortSignal.timeout(8_000)});
    const html = await response.text();
    if (!response.ok) throw new Error("HTTP " + response.status + " for " + url);
    const hrefs = new Set();
    const re = /href=["\'](\/sports\/[^"\']+)["\']/gi;
    let m;
    while ((m = re.exec(html))) hrefs.add(m[1]);
    const soccerHrefs = Array.from(hrefs).filter(href => /\/sports\/soccer(?:\/|$)/i.test(href));
    const slugs = soccerHrefs.map(href => href.split("/").filter(Boolean).pop()).filter(slug => slug && /-\d{4}-\d{2}-\d{2}$/i.test(slug));
    const rows = [];
    for (const slug of slugs.slice(0, 40)) {
      try {
        const event = await getJson(GAMMA_URL + "/events/slug/" + encodeURIComponent(slug), {timeoutMs:3_000});
        if (event && event.active !== false && event.closed !== true && isFootballEvent(event,new Set()) && isPrimaryMatchEvent(event)) rows.push(event);
      } catch (err) { log("WARN","live_page_event_load_failed","Could not load live-page football event from Gamma",{slug,message:err.message}); }
    }
    log("INFO","sports_live_page_discovery","Polymarket /sports/live is the sole football discovery source",{url,hrefCount:hrefs.size,soccerHrefCount:soccerHrefs.length,footballSlugCount:slugs.length,eventCount:rows.length});
    return rows;
  } catch (err) { log("WARN","sports_live_page_discovery_failed","Could not discover football fixtures from Polymarket live sports page",{url,message:err.message}); return []; }
}
async function discoverPolymarket(){
  const groups=new Map();
  const livePageRows=await discoverLivePageFixtures();

  for(const event of livePageRows){
    if(!event||event.active===false||event.closed===true) continue;
    if(!isFootballEvent(event,new Set())){
      log("INFO","non_soccer_live_filtered","Live-page event is not soccer/football; ignored",{
        eventId:text(event.id||event.eventId||event.event_id),
        slug:text(event.slug),
        title:text(event.title||event.question)
      });
      continue;
    }
    if(!isPrimaryMatchEvent(event)){
      log("INFO","non_fixture_filtered","Live-page soccer event has no recognizable fixture form; ignored",{
        eventId:text(event.id||event.eventId||event.event_id),
        title:text(event.title||event.question)
      });
      continue;
    }

    const [home,away]=extractTeams(event);
    if(!home||!away){
      log("INFO","match_teams_missing","Live-page soccer event has no recognizable teams",{
        eventId:text(event.id||event.eventId||event.event_id),
        title:text(event.title||event.question)
      });
      continue;
    }

    const startTime=event.startDate||event.start_date||event.startTime||null;
    const endTime=event.endDate||event.end_date||event.endTime||null;
    const eventId=text(event.id||event.eventId||event.event_id);
    const slug=text(event.slug);
    const key=eventId||slug;
    if(!key) continue;

    const nestedMarkets=Array.isArray(event.markets)?event.markets.map(market=>({
      marketId:text(market?.id||market?.marketId),
      question:text(market?.question||market?.title),
      outcomes:Array.isArray(parseJson(market?.outcomes))?parseJson(market.outcomes):[],
      outcomePrices:Array.isArray(parseJson(market?.outcomePrices||market?.outcome_prices))?parseJson(market?.outcomePrices||market?.outcome_prices):[],
      active:market?.active!==false,
      closed:market?.closed===true
    })):[];

    const groupKey=fixtureKey(home,away,startTime);
    const existing=groups.get(groupKey);
    if(existing){
      existing.relatedEventIds.push(eventId);
      const knownMarketIds=new Set(existing.markets.map(m=>m.marketId).filter(Boolean));
      for(const market of nestedMarkets){
        if(!market.marketId||!knownMarketIds.has(market.marketId)){
          existing.markets.push(market);
          if(market.marketId) knownMarketIds.add(market.marketId);
        }
      }
      continue;
    }

    groups.set(groupKey,{
      eventId,slug,url:eventUrl(event),title:text(event.title||event.question),
      homeTeam:home,awayTeam:away,startTime,endTime,
      active:event.active!==false,closed:event.closed===true,
      polymarketLiveHint:true,markets:nestedMarkets,relatedEventIds:[eventId]
    });

    log("INFO","live_fixture_discovered","Soccer fixture discovered directly from Polymarket /sports/live",{
      eventId,slug,teams:[home,away],startTime,marketCount:nestedMarkets.length
    });
  }

  const matches=Array.from(groups.values());
  await checkpoint("discovery_done",{
    source:"polymarket_sports_live_only",
    livePageRows:livePageRows.length,
    matchesFound:matches.length,
    matches:matches.map(m=>({eventId:m.eventId,teams:[m.homeTeam,m.awayTeam],startTime:m.startTime,marketCount:m.markets.length}))
  });
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

function classifyFixturePhase(match, liveState) {
  const kickoff = Date.parse(match.startTime || "");
  if (liveState?.status === "live") return "live";
  if (!Number.isFinite(kickoff)) {
    log("INFO","fixture_time_unknown","No usable Polymarket kickoff; candidate kept for diagnostics", {eventId:match.eventId,startTime:match.startTime||null});
    return "unknown";
  }
  if (kickoff > Date.now()) return "prematch";
  log("INFO","kickoff_passed_not_live","Kickoff passed but Polymarket did not report the fixture as live; not a live candidate", {
    eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],startTime:match.startTime,
    active:match.active !== false,closed:match.closed === true,kickoffPassedMs:Date.now()-kickoff
  });
  log("INFO","kickoff_passed_not_active","Kickoff passed and event is not active; not a live candidate", {
    eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],startTime:match.startTime
  });
  return "finished";
}

async function ensureEventMarkets(match) {
  if (!match.eventId) return false;

  const startedAt = Date.now();
  const attempts = 6;
  log("INFO", "event_markets_load_start", "Loading current Polymarket markets before BUY", {
    eventId: match.eventId,
    teams: [match.homeTeam, match.awayTeam],
    attempts
  });

  const normalizeMarkets = markets => (Array.isArray(markets) ? markets : []).map(market => ({
    marketId: text(market?.id || market?.marketId),
    question: text(market?.question || market?.title),
    outcomes: Array.isArray(parseJson(market?.outcomes)) ? parseJson(market.outcomes) : [],
    outcomePrices: Array.isArray(parseJson(market?.outcomePrices || market?.outcome_prices))
      ? parseJson(market?.outcomePrices || market?.outcome_prices)
      : [],
    active: market?.active !== false,
    closed: market?.closed === true
  }));

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      // Primary source: refresh the complete parent fixture event.
      const data = await getJson(
        GAMMA_URL + "/events/" + encodeURIComponent(match.eventId),
        { timeoutMs: 3_000 }
      );
      const event = data?.event || data;
      const eventMarkets = normalizeMarkets(event?.markets);

      // Fallback source: query Gamma's markets endpoint directly for this event.
      // We need both the current 1X2 and the Exact Score (1:1) market for alerts.
      let directMarkets = [];
      if (
        !findMatchResultMarket({ ...match, markets: eventMarkets }) ||
        !findOneOneMarket({ ...match, markets: eventMarkets })
      ) {
        try {
          const marketData = await getJson(
            GAMMA_URL + "/markets?event_id=" + encodeURIComponent(match.eventId) + "&active=true&closed=false&limit=500",
            { timeoutMs: 3_000 }
          );
          directMarkets = normalizeMarkets(
            Array.isArray(marketData) ? marketData : (marketData?.markets || marketData?.data || [])
          );
        } catch (directErr) {
          log("WARN", "direct_markets_load_failed", "Direct Polymarket markets lookup failed", {
            eventId: match.eventId,
            attempt,
            message: directErr.message
          });
        }
      }

      const byId = new Map();
      for (const market of [...eventMarkets, ...directMarkets]) {
        const key = market.marketId || JSON.stringify([market.question, market.outcomes]);
        if (!byId.has(key)) byId.set(key, market);
      }
      match.markets = [...byId.values()];

      const oneXTwo = findMatchResultMarket(match);
      log("INFO", "event_markets_loaded", "Current Polymarket markets refreshed before BUY", {
        eventId: match.eventId,
        attempt,
        marketCount: match.markets.length,
        oneXTwoMarketAvailable: Boolean(oneXTwo),
        oneXTwo: oneXTwo ? {
          homeProb: oneXTwo.homeProb,
          drawProb: oneXTwo.drawProb,
          awayProb: oneXTwo.awayProb
        } : null,
        exactScoreOneOne: findOneOneMarket(match) ? {
          outcome: findOneOneMarket(match).outcome,
          price: findOneOneMarket(match).price,
          question: findOneOneMarket(match).market.question || null
        } : null,
        elapsedMs: Date.now() - startedAt
      });

      const exactScoreOneOne = findOneOneMarket(match);
      if (oneXTwo) return true;

      log("WARN", "alert_markets_retry", "Current Polymarket event has not yielded 1X2; retrying before alert", {
        eventId: match.eventId,
        attempt,
        maxAttempts: attempts,
        oneXTwoAvailable: Boolean(oneXTwo)
      });
    } catch (err) {
      log("WARN", "event_markets_load_failed", "Could not load current Polymarket event markets; retrying", {
        eventId: match.eventId,
        attempt,
        maxAttempts: attempts,
        message: err.message,
        elapsedMs: Date.now() - startedAt
      });
    }

    if (attempt < attempts) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  log("ERROR", "alert_markets_unavailable_after_retries", "Could not obtain both current 1X2 and Exact Score 1:1 from Polymarket; alert will not be sent with missing market data", {
    eventId: match.eventId,
    teams: [match.homeTeam, match.awayTeam],
    attempts,
    elapsedMs: Date.now() - startedAt
  });
  return false;
}

function findOneOneMarket(match) {
  const normalizeScoreQuestion = value => text(value)
    .replace(/[–—−]/g, "-")
    .replace(/\\s+/g, " ")
    .trim();

  for (const market of match.markets || []) {
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
    const prices = Array.isArray(market.outcomePrices) ? market.outcomePrices : [];
    if (!outcomes.length || prices.length !== outcomes.length) continue;

    const question = normalizeScoreQuestion(market.question || "");
    const isExactScore = /(?:exact\\s+score|correct\\s+score)/i.test(question);
    const isOneOneQuestion = /(?:^|[^0-9])1\\s*[:\\-]\\s*1(?:[^0-9]|$)/.test(question);
    if (isExactScore && isOneOneQuestion) {
      const yesIndex = outcomes.findIndex(v => /^yes$/i.test(text(v)));
      if (yesIndex >= 0) {
        const price = Number(prices[yesIndex]);
        if (Number.isFinite(price) && price >= 0 && price <= 1) {
          return { market, outcome: text(outcomes[yesIndex]), price };
        }
      }
    }

    // Some Gamma representations expose the score as an outcome instead of
    // embedding it in the question. Support both 1-1 and 1:1 spellings.
    for (let i = 0; i < outcomes.length; i++) {
      const outcome = text(outcomes[i]).replace(/[–—−]/g, "-").trim();
      if (/^1\\s*[:\\-]\\s*1$/.test(outcome)) {
        const price = Number(prices[i]);
        if (Number.isFinite(price) && price >= 0 && price <= 1) {
          return { market, outcome, price };
        }
      }
    }
  }

  return null;
}

function scoreTotal(match) {
  return Number(match.live?.score?.home || 0) + Number(match.live?.score?.away || 0);
}

async function maybeOneOneAlert(match, priceSource, phase = "live") {
  if (!match.url && match.eventId) {
    try {
      const data = await getJson(GAMMA_URL + "/events/" + encodeURIComponent(match.eventId), { timeoutMs: 3_000 });
      const event = data?.event || data;
      if (text(event?.slug)) {
        match.url = eventUrl(event);
        match.slug = text(event.slug);
        log("INFO", "candidate_url_recovered", "Recovered Polymarket event URL before alert", {
          eventId: match.eventId, url: match.url
        });
      }
    } catch (err) {
      log("WARN", "candidate_url_recovery_failed", "Could not recover Polymarket event URL before alert", {
        eventId: match.eventId, message: err.message
      });
    }
  }
  if (!match.url) {
    log("ERROR", "candidate_alert_blocked_no_url", "Football candidate reached BUY but has no Polymarket event URL", {
      eventId: match.eventId, slug: match.slug || null, teams: [match.homeTeam, match.awayTeam]
    });
    return;
  }

  const key = match.eventId || match.slug;
  const home = Number(match.live?.score?.home || 0);
  const away = Number(match.live?.score?.away || 0);

  // Refresh Polymarket immediately before BUY and do not permit an empty 1X2.
  // ensureEventMarkets retries both the event endpoint and the direct markets endpoint.
  const marketsLoaded = await ensureEventMarkets(match);
  const oneXTwo = findMatchResultMarket(match);

  if (phase === "prematch" || phase === "live_entry") {
    if (!oneXTwo) {
      log("WARN","live_waiting_for_1x2","LIVE fixture reached alert stage but current 1X2 is unavailable; retrying next cycle",{
        eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],phase
      });
      return;
    }

    const oneXTwoLine = `1: ${Math.round(oneXTwo.homeProb * 100)}% · X: ${Math.round(oneXTwo.drawProb * 100)}% · 2: ${Math.round(oneXTwo.awayProb * 100)}%`;
    const claimKey = key + ":LIVE";
    const claim = await claimTelegramAlert(claimKey);
    if (!claim.claimed) return;

    const message = [
      "⚽ LIVE",
      "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: " + home + "–" + away,
      "", oneXTwoLine, "", "➡️ OPEN MATCH", match.url
    ].join("\n");

    try {
      const sent = await sendTelegram(message, claim.replyToMessageId);
      if (!sent.ok) throw new Error("Telegram not configured");
      await saveTelegramMessageId(key + ":LIVE", sent.messageId);
      oneOneState.set(key, { ...(oneOneState.get(key) || {}), startedSent: true });
      await markCandidateStartedSent(key);
      log("INFO","live_alert_sent","First LIVE alert sent for soccer fixture found on Polymarket /sports/live",{
        eventId:match.eventId,score:{home,away},telegramMessageId:sent.messageId
      });
    } catch (err) {
      await releaseTelegramAlert(claimKey);
      log("ERROR","telegram_send_failed","LIVE alert send failed; claim released",{
        eventId:match.eventId,message:err.message
      });
    }
    return;
  }

  if (phase === "started") {
    const state = oneOneState.get(key);
    if (!state?.prematchSeen || state?.startedSent) return;

    // Refresh current markets so the LIVE reply carries the current 1X2
    // and Exact Score 1:1 price. The reply is linked to the original BUY.
    const marketsLoadedForLive = await ensureEventMarkets(match);
    const liveOneXTwo = findMatchResultMarket(match);
    if (!marketsLoadedForLive || !liveOneXTwo) {
      log("WARN", "live_waiting_for_1x2", "Fixture started but current 1X2 is not available yet; LIVE reply will be retried", {
        eventId: match.eventId,
        teams: [match.homeTeam, match.awayTeam]
      });
      return;
    }

    const liveOneXTwoLine = `1: ${Math.round(liveOneXTwo.homeProb * 100)}% · X: ${Math.round(liveOneXTwo.drawProb * 100)}% · 2: ${Math.round(liveOneXTwo.awayProb * 100)}%`;
    const exactScoreOneOne = findOneOneMarket(match);
    if (!exactScoreOneOne || !Number.isFinite(exactScoreOneOne.price)) {
      log("WARN", "live_waiting_for_one_one", "LIVE reply is waiting for the current Exact Score 1:1 YES price; retrying next cycle", {
        eventId: match.eventId,
        teams: [match.homeTeam, match.awayTeam],
        retryRequired: true
      });
      return;
    }
    const exactScoreOneOneLine = `1:1 YES: ${exactScoreOneOne.price.toFixed(2)}`;

    const claimKey = key + ":STARTED";
    const claim = await claimTelegramAlert(claimKey);
    if (!claim.claimed) return;

    const message = [
      "⚽ LIVE",
      exactScoreOneOneLine,
      "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: " + home + "–" + away,
      "", liveOneXTwoLine, "", "➡️ OPEN MATCH", match.url
    ].join("\n");

    try {
      const sent = await sendTelegram(message, claim.replyToMessageId);
      if (!sent.ok) throw new Error("Telegram not configured");
      await saveTelegramMessageId(key + ":LIVE", sent.messageId);
      oneOneState.set(key, { ...(oneOneState.get(key) || {}), startedSent: true });
      await markCandidateStartedSent(key);
      log("INFO", "match_started_alert_sent", "LIVE reply sent to original BUY alert", {
        eventId: match.eventId, score: { home, away }, replyToMessageId: claim.replyToMessageId, telegramMessageId: sent.messageId
      });
    } catch (err) {
      await releaseTelegramAlert(claimKey);
      log("ERROR", "telegram_send_failed", "LIVE reply send failed; claim released", {
        eventId: match.eventId, message: err.message
      });
    }
    return;
  }

  const hasGoal = (home + away) > 0;
  if (!hasGoal) return;

  // Refresh the event markets immediately before SELL so the alert carries
  // the current Exact Score 1:1 YES price from the live match.
  await ensureEventMarkets(match);
  const exactScoreOneOne = findOneOneMarket(match);
  if (!exactScoreOneOne || !Number.isFinite(exactScoreOneOne.price)) {
    log("WARN", "sell_waiting_for_current_one_one", "SELL is waiting for current Exact Score 1:1 YES price; retrying next cycle", {
      eventId: match.eventId,
      teams: [match.homeTeam, match.awayTeam],
      currentPrice: exactScoreOneOne?.price ?? null
    });
    return;
  }

  let buyOneOnePrice = oneOneState.get(key)?.buyOneOnePrice;
  if (!Number.isFinite(buyOneOnePrice)) {
    try {
      const persisted = await candidateRequest("/football/candidates/buy-price?key=" + encodeURIComponent(key));
      buyOneOnePrice = Number(persisted?.buyOneOnePrice);
      if (Number.isFinite(buyOneOnePrice)) {
        oneOneState.set(key, { ...(oneOneState.get(key) || {}), prematchSeen: true, buyOneOnePrice });
        log("INFO", "sell_buy_price_restored", "Restored original BUY 1:1 YES price from persistent Convex state", {
          eventId: match.eventId,
          buyPrice: buyOneOnePrice
        });
      }
    } catch (err) {
      log("ERROR", "sell_buy_price_lookup_failed", "Persistent BUY 1:1 price lookup failed; SELL will retry next cycle", {
        eventId: match.eventId,
        message: err.message
      });
      return;
    }
  }

  if (!Number.isFinite(buyOneOnePrice)) {
    log("ERROR", "sell_buy_price_missing_persistent", "Persistent BUY 1:1 YES price is missing for an already admitted BUY; SELL will retry after state restoration", {
      eventId: match.eventId,
      teams: [match.homeTeam, match.awayTeam]
    });
    return;
  }
  const sellPriceLine = `${buyOneOnePrice.toFixed(2)}c ➡️ ${exactScoreOneOne.price.toFixed(2)}c`;
  log("INFO", "exact_score_one_one_snapshot", "Captured BUY and current Exact Score 1:1 YES prices for SELL alert", {
    eventId: match.eventId,
    teams: [match.homeTeam, match.awayTeam],
    buyPrice: buyOneOnePrice,
    currentPrice: exactScoreOneOne.price,
    outcome: exactScoreOneOne.outcome,
    question: exactScoreOneOne.market?.question ?? null
  });

  const scoreKey = home + "-" + away;
  const claimKey = key + ":SELL:" + scoreKey;
  const claim = await claimTelegramAlert(claimKey);
  if (!claim.claimed) return;

  const message = [
    "⚽ SELL",
    sellPriceLine,
    "",
    match.homeTeam + " vs " + match.awayTeam,
    "SCORE: " + home + "–" + away,
    "", "➡️ OPEN MATCH", match.url
  ].join("\n");

  try {
    const sent = await sendTelegram(message, claim.replyToMessageId);
    if (!sent.ok) throw new Error("Telegram not configured");
    await markCandidateSellSent(key);
    log("INFO", "one_one_sell_alert_sent", "SELL alert sent as Telegram reply to BUY", {
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
  if (await stopIfSuperseded()) return;
  if(stopping||tick.running)return;
  tick.running=true; convexTickCount+=1;
  try{
    const tickStartedAt=Date.now();
    log("INFO","stage_start","Polymarket discovery stage started",{stage:"polymarket_discovery",source:GAMMA_URL});
    const discovered=await discoverPolymarket();
    for (const match of discovered) {
      const key=match.eventId||match.slug;
    }
    // The candidate set is a fresh snapshot of the current Polymarket /sports/live
    // soccer page. Persistent alert state is kept separately in oneOneState/Convex.
    // Never carry old prematch/line candidates into a new cycle.
    const matches=discovered.slice();
    const evaluationCandidates=matches;
    const deferredCandidates=0;
    const cycle={discovered:discovered.length,retainedCandidates:matches.length,evaluationCandidates:evaluationCandidates.length,deferredCandidates,preMatch:0,live:0,liveZeroZero:0,evaluations:0,buyPassed:0,buyRejected:0,sellEvaluated:0,liveStateUnavailable:0};
    log("INFO","stage_done","Polymarket discovery stage finished",{stage:"polymarket_discovery",elapsedMs:Date.now()-tickStartedAt,candidates:matches.length,evaluationCandidates:evaluationCandidates.length,deferredCandidates});
    log("INFO","polymarket_source","Polymarket is the sole football source",{source:GAMMA_URL});
    livePagePromise = loadPolymarketLivePage();
    const evalStarted=Date.now();
    log("INFO","stage_start","Polymarket live-page alert evaluation started",{stage:"evaluation",rule:"only currently LIVE soccer fixtures from /sports/live can alert; 1X2 is included in every alert",evaluationCandidates:evaluationCandidates.length,deferredCandidates});
    const BATCH=20;
    for(let i=0;i<evaluationCandidates.length;i+=BATCH){
      await Promise.all(evaluationCandidates.slice(i,i+BATCH).map(async match=>{
        cycle.evaluations++;
        const liveState=await refreshPolymarketLiveState(match);
        const phase=classifyFixturePhase(match,liveState);
        const isLive=phase==="live";
        const isPrematch=phase==="prematch";
        const score=liveState?.score||{home:0,away:0};
        const state=oneOneState.get(match.eventId||match.slug);
        if(isLive)cycle.live++;
        if(isLive&&score.home===0&&score.away===0)cycle.liveZeroZero++;
        if(!liveState)cycle.liveStateUnavailable++;

        if(!isLive){
          log("INFO","not_live_ignored","Fixture is not currently live; pre-match/line monitoring is disabled",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],phase});
          return;
        }
        if(!state?.startedSent){
          cycle.buyPassed++;
          log("INFO","live_fixture_ready_for_alert","Already-started football fixture reached alert stage from Polymarket /sports/live",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],score});
          await maybeOneOneAlert({...match,live:{...(liveState||{}),status:"live",score}},null,"live_entry");
          return;
        }
        if((Number(score.home)+Number(score.away))>0){
          cycle.sellEvaluated++;
          await maybeOneOneAlert({...match,live:{...(liveState||{}),status:"live",score}},null,"live");
        } else {
          log("INFO","live_fixture_waiting_for_score_change","Live fixture already alerted; waiting for score change",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],score});
        }
      }));
    }
    log("INFO","stage_done","Polymarket-only alert evaluation finished",{stage:"evaluation",elapsedMs:Date.now()-evalStarted,candidates:matches.length});
    log("INFO","cycle_summary","Football monitor cycle summary",{elapsedMs:Date.now()-tickStartedAt,...cycle,note:"Polymarket only; discovered fixtures are retained across cycles until lifecycle resolution"});
    return matches.length;
  }catch(err){
    log("ERROR","discovery_failed","Football Polymarket-only tick failed; monitoring continues",{message:err.message});
  }finally{livePagePromise=null;tick.running=false;await flushConvexLogs();}
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


let livePagePromise = null;
function decodeHtml(value) {
  return text(value).replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&#x2013;/gi,"–").replace(/&#x2014;/gi,"—");
}
function visiblePolymarketText(html) {
  const s=html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<noscript[\s\S]*?<\/noscript>/gi," ");
  return decodeHtml(s.replace(/<[^>]+>/g," ").replace(/\s+/g," "));
}
function scoreAfterTeam(page, team) {
  const normalizedPage = norm(page);
  const normalizedTeam = norm(team);
  if (!normalizedPage || !normalizedTeam) return null;
  const escaped = normalizedTeam.replace(/[.*+?^\$\{\}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "\\s+(\\d{1,2})-(\\d{1,2})(?=\\s|$)", "i");
  const m = normalizedPage.match(re);
  if (!m) return null;
  const home = Number(m[1]), away = Number(m[2]);
  if (![home, away].every(Number.isInteger) || home < 0 || away < 0 || home > 20 || away > 20) return null;
  return {home, away};
}

function findLivePageMatch(page, match) {
  const normalizedPage = norm(page);
  const homeTeam = norm(match.homeTeam);
  const awayTeam = norm(match.awayTeam);
  if (!normalizedPage || !homeTeam || !awayTeam) return null;

  let from = 0;
  while (from < normalizedPage.length) {
    const hi = normalizedPage.indexOf(homeTeam, from);
    if (hi < 0) break;
    const ai = normalizedPage.indexOf(awayTeam, hi + homeTeam.length);
    if (ai < 0 || ai - hi > 900) {
      from = hi + homeTeam.length;
      continue;
    }

    const cardStart = Math.max(0, hi - 260);
    const cardEnd = Math.min(normalizedPage.length, ai + awayTeam.length + 320);
    const card = normalizedPage.slice(cardStart, cardEnd);
    const liveStatus = /\b(?:1h|2h|ht|et|aet|live|in progress|playing|penalties|pen)\b/i.test(card);

    if (liveStatus) {
      // Polymarket's rendered live card does not always serialize a football
      // score as "HOME 1-0 AWAY". Depending on the page payload it may appear
      // as "HOME 1 AWAY 0", or the away score may be omitted from the extracted
      // text altogether. LIVE membership must therefore not depend on one
      // brittle score layout.
      const betweenTeams = normalizedPage.slice(hi + homeTeam.length, ai);
      const afterAway = normalizedPage.slice(ai + awayTeam.length, cardEnd);
      const homeScoreMatch = betweenTeams.match(/\b(\d{1,2})\b/);
      const awayScoreMatch = afterAway.match(/^\s*(\d{1,2})\b/);

      let home = homeScoreMatch ? Number(homeScoreMatch[1]) : null;
      let away = awayScoreMatch ? Number(awayScoreMatch[1]) : null;

      if (home === null || away === null) {
        const compact = normalizedPage.slice(hi, cardEnd);
        const compactMatch = compact.match(
          new RegExp(homeTeam + "\\s+(\\d{1,2})\\s+" + awayTeam + "\\s+(\\d{1,2})\\b", "i")
        );
        if (compactMatch) {
          home = Number(compactMatch[1]);
          away = Number(compactMatch[2]);
        }
      }

      if (![home, away].every(Number.isInteger) || home < 0 || away < 0 || home > 20 || away > 20) {
        log("WARN", "polymarket_live_score_unparsed", "Polymarket live card confirmed the fixture but its score layout could not be parsed; keeping LIVE state", {
          teams: [match.homeTeam, match.awayTeam],
          card: card.slice(0, 500)
        });
        home = 0;
        away = 0;
      }

      return {
        status: "live",
        score: {home, away},
        minute: 0
      };
    }

    from = hi + homeTeam.length;
  }

  return null;
}

async function loadPolymarketLivePage() {
  const url="https://polymarket.com/sports/live";
  try {
    const r=await fetch(url,{headers:{accept:"text/html,application/xhtml+xml","user-agent":"Mozilla/5.0 (compatible; PolymarketFootballMonitor/1.0)"},signal:AbortSignal.timeout(6000)});
    if(!r.ok)throw new Error("HTTP "+r.status+" for "+url);
    const html=await r.text(), page=visiblePolymarketText(html);
    log("INFO","polymarket_live_page_loaded","Polymarket live sports page refreshed",{url,bodyBytes:Buffer.byteLength(html,"utf8"),textBytes:Buffer.byteLength(page,"utf8")});
    return page;
  } catch(err) {
    log("WARN","polymarket_live_page_failed","Could not refresh Polymarket /sports/live page",{url,message:err.message});
    return null;
  }
}
async function refreshPolymarketLiveState(match) {
  try {
    if(!livePagePromise)livePagePromise=loadPolymarketLivePage();
    const page=await livePagePromise; if(!page)return null;
    const live=findLivePageMatch(page,match); if(!live)return null;
    log("INFO","polymarket_live_match_found","Previously admitted football candidate found on Polymarket live page",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],score:live.score,source:"https://polymarket.com/ru/sports/live"});
    return live;
  } catch(err) {
    log("WARN","polymarket_live_state_failed","Could not determine live state from Polymarket /sports/live",{eventId:match.eventId,message:err.message});
    return null;
  }
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
        if (row.buySent || row.startedSent || row.sellSent) {
          oneOneState.set(key, {
            prematchSeen: true,
            ...(Number.isFinite(Number(row.buyOneOnePrice)) ? { buyOneOnePrice: Number(row.buyOneOnePrice) } : {})
          });
        }
        if (row.startedSent) oneOneState.set(key, { ...(oneOneState.get(key) || {}), startedSent: true });
        if (row.sellSent) oneOneState.set(key, { ...(oneOneState.get(key) || {}), sellSent: true });
        restored++;
      } catch {}
    }
    log("INFO", "persistent_candidates_loaded", "Restored persisted football candidates", { restored });
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

async function markCandidateBuySent(key, buyOneOnePrice) {
  try {
    await candidateRequest("/football/candidates/mark-buy", { key, buyOneOnePrice });
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
    if (response.status === 200) {
      log("INFO", "telegram_claim_granted", "Persistent Telegram dedupe claim granted", {
        key,
        status: 200
      });
      return { claimed: true, replyToMessageId: body.replyToMessageId ?? null };
    }
    if (response.status === 409) {
      log("WARN", "telegram_claim_denied", "Telegram dedupe already claimed this alert", {
        key,
        status: 409,
        body
      });
      return { claimed: false, replyToMessageId: null };
    }
    throw new Error("Convex claim HTTP " + response.status + " " + JSON.stringify(body));
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
  console.log(JSON.stringify({event:"monitor_start",message:"football monitor continuous entrypoint started",runMs:RUN_MS,pollMs:POLL_MS,createdAt:Date.now(),githubRunId:process.env.GITHUB_RUN_ID||null}));
  await stopIfSuperseded();
  if (stopping) {
    await flushConvexLogs();
    return;
  }
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