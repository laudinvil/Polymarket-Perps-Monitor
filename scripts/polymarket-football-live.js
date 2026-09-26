const GAMMA_URL = "https://gamma-api.polymarket.com";

const POLL_MS = 15_000; // Polymarket-only polling.
const RUN_MS = 5 * 60 * 60 * 1000 + 50 * 60 * 1000;

let stopping = false;
let timer = null;
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
    .replace(/\b(fc|cf|sc|afc|ac|cd|club|football club)\b/g, " ")
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
    // Live soccer cards use /sports/<league>/<event-slug> links.
    // /event/<slug> is not the canonical sports URL used by this page.
    const re = /href=["\'](\/sports\/[^"\']+)["\']/gi;
    let m;
    while ((m = re.exec(html))) hrefs.add(m[1]);
    const eventHrefs = Array.from(hrefs).filter(href => {
      const parts = href.split("/").filter(Boolean);
      return parts.length >= 3 && parts[0] === "sports" && parts[1] !== "live" && /-\d{4}-\d{2}-\d{2}$/i.test(parts[parts.length - 1]);
    });
    const slugs = eventHrefs
      .map(href => href.split("/").filter(Boolean).pop())
      .filter(slug => slug && /-\d{4}-\d{2}-\d{2}$/i.test(slug));
    const rows = [];
    for (const href of eventHrefs.slice(0, 40)) {
      const slug = href.split("/").filter(Boolean).pop();
      try {
        const event = await getJson(GAMMA_URL + "/events/slug/" + encodeURIComponent(slug), {timeoutMs:3_000});
        const league = href.split("/").filter(Boolean)[1] || "";
        const nonSoccerLeague = /^(cfb|nfl|mlb|nba|nhl|wnba|atp|wta|ufc|mma|boxing|cricket|rugby|golf|darts|volleyball|handball|table-tennis|motorsports|formula-1|nascar|esports|chess|poker)$/i.test(league);
        const soccerByMetadata = isFootballEvent(event,new Set());
        const soccerByLiveUrl = !nonSoccerLeague;
        if (event && event.active !== false && event.closed !== true && (soccerByMetadata || soccerByLiveUrl) && isPrimaryMatchEvent(event)) {
          rows.push({...event, _liveSportsHref: href});
          log("INFO","live_page_fixture_accepted","Accepted current Polymarket /sports/live fixture for Soccer monitoring",{
            slug,
            href,
            league,
            soccerByMetadata,
            soccerByLiveUrl,
            title:text(event.title||event.question)
          });
        } else {
          log("INFO","live_page_fixture_rejected","Rejected /sports/live card before monitoring",{
            slug,
            href,
            league,
            soccerByMetadata,
            soccerByLiveUrl,
            active:event?.active,
            closed:event?.closed,
            title:text(event?.title||event?.question)
          });
        }
      } catch (err) { log("WARN","live_page_event_load_failed","Could not load live-page football event from Gamma",{slug,message:err.message}); }
    }
    log("INFO","sports_live_page_discovery","Polymarket /sports/live is the sole football discovery source",{url,hrefCount:hrefs.size,eventHrefCount:eventHrefs.length,footballSlugCount:slugs.length,eventCount:rows.length});
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
      eventId,slug,url:event._liveSportsHref ? "https://polymarket.com" + event._liveSportsHref : eventUrl(event),title:text(event.title||event.question),
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

function classifyFixturePhase(_match, liveState) {
  return liveState?.status === "live" ? "live" : "not_live";
}

async function ensureEventMarkets(match) {
  if (!match.eventId) return false;

  const startedAt = Date.now();
  const attempts = 6;
  log("INFO", "event_markets_load_start", "Loading current Polymarket 1X2 markets before alert", {
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
      // Only the current 1X2 market is required for alerts.
      let directMarkets = [];
      if (!findMatchResultMarket({ ...match, markets: eventMarkets })) {
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
      log("INFO", "event_markets_loaded", "Current Polymarket 1X2 markets refreshed before alert", {
        eventId: match.eventId,
        attempt,
        marketCount: match.markets.length,
        oneXTwoMarketAvailable: Boolean(oneXTwo),
        oneXTwo: oneXTwo ? {
          homeProb: oneXTwo.homeProb,
          drawProb: oneXTwo.drawProb,
          awayProb: oneXTwo.awayProb
        } : null,
        elapsedMs: Date.now() - startedAt
      });

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

  log("ERROR", "alert_markets_unavailable_after_retries", "Could not obtain current Polymarket 1X2 market; alert will not be sent with missing market data", {
    eventId: match.eventId,
    teams: [match.homeTeam, match.awayTeam],
    attempts,
    elapsedMs: Date.now() - startedAt
  });
  return false;
}


async function maybeOneOneAlert(match, _priceSource, phase = "live_entry") {
  if (!match.url && match.eventId) {
    try {
      const data = await getJson(GAMMA_URL + "/events/" + encodeURIComponent(match.eventId), { timeoutMs: 3_000 });
      const event = data?.event || data;
      if (text(event?.slug)) { match.url = eventUrl(event); match.slug = text(event.slug); }
    } catch (err) {
      log("WARN","candidate_url_recovery_failed","Could not recover Polymarket event URL before alert",{eventId:match.eventId,message:err.message});
    }
  }
  if (!match.url) {
    log("ERROR","candidate_alert_blocked_no_url","Live Soccer fixture has no Polymarket event URL",{eventId:match.eventId,slug:match.slug||null,teams:[match.homeTeam,match.awayTeam]});
    return;
  }
  const key=String(match.url || "").trim().replace(/\/$/, "");
  if (!key) { log("ERROR","alert_blocked_no_dedupe_url","Alert blocked because the Polymarket event URL is required for URL-based dedupe",{eventId:match.eventId,slug:match.slug||null}); return; }
  const liveHome=match.live?.score?.home, liveAway=match.live?.score?.away, liveMinute=match.live?.minute;
  if (!Number.isInteger(liveHome) || !Number.isInteger(liveAway) || liveMinute === null || liveMinute === undefined) { log("WARN","alert_blocked_missing_live_data","Alert blocked: score and minute are mandatory",{eventId:match.eventId,score:match.live?.score??null,minute:liveMinute??null}); return; }
  const home=liveHome, away=liveAway;
  const marketsLoaded=await ensureEventMarkets(match);
  const oneXTwo=findMatchResultMarket(match);
  if(!marketsLoaded||!oneXTwo){
    log("WARN","live_waiting_for_1x2","Live Soccer fixture is waiting for current 1X2 market",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],phase});
    return;
  }
  const oneXTwoLine=`1: ${Math.round(oneXTwo.homeProb*100)}% · X: ${Math.round(oneXTwo.drawProb*100)}% · 2: ${Math.round(oneXTwo.awayProb*100)}%`;
  if(phase==="live_entry"){
    const claimKey=key, claim=await claimTelegramAlert(claimKey);
    if(!claim.claimed)return;
    const message=["⚽ LIVE","",match.homeTeam+" vs "+match.awayTeam,"MINUTE: "+liveMinute,"SCORE: "+home+"–"+away,"",oneXTwoLine,"","➡️ OPEN MATCH",match.url].join("\n");
    try{
      const sent=await sendTelegram(message,claim.replyToMessageId);
      if(!sent.ok)throw new Error("Telegram not configured");
      await saveTelegramMessageId(claimKey,sent.messageId);
      log("INFO","live_alert_sent","First LIVE alert sent for Soccer fixture found on Polymarket /sports/live",{eventId:match.eventId,score:{home,away},telegramMessageId:sent.messageId});
    }catch(err){
      await releaseTelegramAlert(claimKey);
      log("ERROR","telegram_send_failed","LIVE alert send failed; claim released",{eventId:match.eventId,message:err.message});
    }
    return;
  }
  if(home+away<=0)return;
  const claimKey=key, claim=await claimTelegramAlert(claimKey);
  if(!claim.claimed)return;
  const message=["⚽ SELL","",match.homeTeam+" vs "+match.awayTeam,"SCORE: "+home+"–"+away,"",oneXTwoLine,"","➡️ OPEN MATCH",match.url].join("\n");
  try{
    const sent=await sendTelegram(message,claim.replyToMessageId);
    if(!sent.ok)throw new Error("Telegram not configured");
    log("INFO","one_one_sell_alert_sent","SELL alert sent as Telegram reply to LIVE",{eventId:match.eventId,score:{home,away},replyToMessageId:claim.replyToMessageId});
  }catch(err){
    await releaseTelegramAlert(claimKey);
    log("ERROR","telegram_send_failed","SELL alert send failed; claim released",{eventId:match.eventId,message:err.message});
  }
}

async function tick() {
  if(await stopIfSuperseded())return;
  if(stopping||tick.running)return;
  tick.running=true; convexTickCount+=1;
  try{
    const tickStartedAt=Date.now();
    log("INFO","stage_start","Polymarket Soccer live discovery started",{stage:"polymarket_discovery",source:"https://polymarket.com/sports/live"});
    const matches=await discoverPolymarket(), evaluationCandidates=matches;
    const cycle={discovered:matches.length,evaluationCandidates:evaluationCandidates.length,live:0,liveZeroZero:0,evaluations:0,liveStateUnavailable:0};
    log("INFO","stage_done","Current Polymarket Soccer live snapshot discovered",{stage:"polymarket_discovery",elapsedMs:Date.now()-tickStartedAt,matches:matches.length,evaluationCandidates:evaluationCandidates.length});
    livePagePromise=loadPolymarketLivePage();
    const evalStarted=Date.now();
    log("INFO","stage_start","Polymarket live-page alert evaluation started",{stage:"evaluation",rule:"only currently LIVE Soccer fixtures from /sports/live can alert; 1X2 is included in every alert",evaluationCandidates:evaluationCandidates.length});
    const BATCH=20;
    for(let i=0;i<evaluationCandidates.length;i+=BATCH){
      await Promise.all(evaluationCandidates.slice(i,i+BATCH).map(async match=>{
        cycle.evaluations++;
        const liveState=await refreshPolymarketLiveState(match), isLive=classifyFixturePhase(match,liveState)==="live";
        const score=liveState?.score||null;
        if(isLive)cycle.live++;
        if(isLive&&score.home===0&&score.away===0)cycle.liveZeroZero++;
        if(!liveState)cycle.liveStateUnavailable++;
        if(!isLive){log("INFO","not_live_ignored","Fixture is not currently live; ignored",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam]});return;}
        if(!liveState?.score || liveState.minute === null){ log("WARN","alert_blocked_missing_live_data","LIVE alert blocked because real score and minute are mandatory",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],score:liveState?.score??null,minute:liveState?.minute??null}); return; } const alertMatch={...match,live:{...(liveState||{}),status:"live",score}};
        await maybeOneOneAlert(alertMatch,null,score.home===0&&score.away===0?"live_entry":"live");
      }));
    }
    log("INFO","stage_done","Polymarket-only live alert evaluation finished",{stage:"evaluation",elapsedMs:Date.now()-evalStarted,matches:matches.length});
    log("INFO","cycle_summary","Football monitor cycle summary",{elapsedMs:Date.now()-tickStartedAt,...cycle,note:"Only the current Polymarket /sports/live Soccer snapshot is evaluated"});
    return matches.length;
  }catch(err){log("ERROR","discovery_failed","Football Polymarket-only tick failed; monitoring continues",{message:err.message});}
  finally{livePagePromise=null;tick.running=false;await flushConvexLogs();}
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
function finiteScore(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 20 ? n : null;
}

function finiteMinute(v) {
  if (v === null || v === undefined || v === "") return null;
  const m = String(v).match(/^\s*(\d{1,3})(?:\s*['′]|\s*(?:min|mins|minute|minutes))?\s*$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isInteger(n) && n >= 0 && n <= 130 ? n : null;
}

function extractStructuredScore(row) {
  const candidates = [
    [row?.homeScore, row?.awayScore],
    [row?.home_score, row?.away_score],
    [row?.score?.home, row?.score?.away],
    [row?.score?.homeScore, row?.score?.awayScore],
    [row?.scores?.home, row?.scores?.away],
    [row?.scores?.homeScore, row?.scores?.awayScore],
    [row?.home?.score, row?.away?.score],
    [row?.homeTeam?.score, row?.awayTeam?.score],
    [row?.home_team?.score, row?.away_team?.score],
  ];
  for (const [h, a] of candidates) {
    const home = finiteScore(h);
    const away = finiteScore(a);
    if (home !== null && away !== null) return { home, away };
  }
  return null;
}

function extractStructuredMinute(row) {
  const candidates = [
    row?.minute, row?.minutes, row?.matchMinute, row?.match_minute,
    row?.elapsed, row?.elapsedMinutes, row?.elapsed_minutes,
    row?.clock?.minute, row?.clock?.minutes,
    row?.status?.minute, row?.status?.elapsed,
    row?.period?.minute
  ];
  for (const value of candidates) {
    const minute = finiteMinute(value);
    if (minute !== null) return minute;
  }
  return null;
}

function extractGameTeams(row) {
  const pairs = [
    [row?.homeTeam?.name, row?.awayTeam?.name],
    [row?.home_team?.name, row?.away_team?.name],
    [row?.home?.name, row?.away?.name],
    [row?.teams?.home?.name, row?.teams?.away?.name],
    [row?.teams?.homeTeam?.name, row?.teams?.awayTeam?.name],
    [row?.home, row?.away],
    [row?.homeTeam, row?.awayTeam]
  ];
  for (const [h, a] of pairs) {
    const home = text(h);
    const away = text(a);
    if (home && away) return [home, away];
  }
  return null;
}

function isExplicitLiveGame(row) {
  const statusValues = [
    row?.status, row?.state, row?.gameStatus, row?.game_status,
    row?.matchStatus, row?.match_status, row?.status?.type, row?.status?.short
  ].map(text).filter(Boolean).map(v => v.toLowerCase());

  if (statusValues.some(v => /^(live|inplay|in-play|playing|1h|2h|ht|et|aet|halftime|half-time|in progress)$/.test(v))) {
    return true;
  }

  const liveFlags = [row?.live, row?.isLive, row?.inPlay, row?.in_play, row?.is_live];
  if (liveFlags.some(v => v === true || String(v).toLowerCase() === "true")) return true;

  // A structured minute is also a valid LIVE signal. A bare final score is not.
  return extractStructuredMinute(row) !== null;
}

function findStructuredLiveGame(rows, match) {
  const targetHome = norm(match.homeTeam);
  const targetAway = norm(match.awayTeam);
  if (!targetHome || !targetAway) return null;

  let best = null;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== "object") continue;
    const teams = extractGameTeams(row);
    if (!teams) continue;

    const [home, away] = teams;
    const direct = teamSimilarity(home, match.homeTeam) >= 0.8 &&
      teamSimilarity(away, match.awayTeam) >= 0.8;
    const reversed = teamSimilarity(home, match.awayTeam) >= 0.8 &&
      teamSimilarity(away, match.homeTeam) >= 0.8;
    if (!direct && !reversed) continue;
    if (!isExplicitLiveGame(row)) continue;

    let score = extractStructuredScore(row);
    const minute = extractStructuredMinute(row);
    if (score && reversed) score = { home: score.away, away: score.home };

    const live = {
      status: "live",
      score: score || { home: null, away: null },
      minute,
      source: "gamma_games_structured"
    };

    if (!best || (score && !best.score?.home && !best.score?.away) || (minute !== null && best.minute === null)) {
      best = live;
    }

    log("INFO", "gamma_games_match_candidate", "Structured /games row matched the Polymarket fixture", {
      eventId: match.eventId,
      teams: [match.homeTeam, match.awayTeam],
      gameTeams: teams,
      score,
      minute,
      status: row?.status ?? row?.state ?? null,
      scoreSource: score ? "gamma_games_structured" : null,
      minuteSource: minute !== null ? "gamma_games_structured" : null
    });
  }

  return best;
}

async function loadGammaGames() {
  const url = GAMMA_URL + "/games";
  try {
    const data = await getJson(url, { timeoutMs: 5_000 });
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data?.games)
        ? data.games
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.data?.games)
            ? data.data.games
            : [];

    log("INFO", "gamma_games_loaded", "Gamma /games structured LIVE source refreshed", {
      url,
      rows: rows.length
    });

    return rows;
  } catch (err) {
    log("WARN", "gamma_games_failed", "Gamma /games structured LIVE source failed", {
      url,
      message: err.message
    });
    return [];
  }
}

function extractLiveCardData(page, match) {
  const p = norm(page), h = norm(match.homeTeam), a = norm(match.awayTeam);
  if (!p || !h || !a) return null;
  const esc = v => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const aliases = v => [...new Set([v, v.replace(/\b(?:fc|cf|sc|afc|ac|cd)\b/g, "").replace(/\s+/g, " ").trim()].filter(Boolean))];
  for (const hh of aliases(h)) {
    let pos = 0;
    while (true) {
      const hi = p.indexOf(hh, pos); if (hi < 0) break;
      for (const aa of aliases(a)) {
        const ai = p.indexOf(aa, hi + hh.length);
        if (ai < 0 || ai - hi > 1200) continue;
        const card = p.slice(Math.max(0, hi - 500), Math.min(p.length, ai + aa.length + 500));
        if (!/\b(?:live|1h|2h|ht|et|aet|playing|in progress)\b/i.test(card)) continue;
        const local = p.slice(hi, Math.min(p.length, ai + aa.length + 500));
        let score = null;
        let m = local.match(new RegExp(esc(hh) + "\\s+(\\d{1,2})\\s*[–-]\\s*(\\d{1,2})\\s+" + esc(aa), "i"));
        if (m) score = {home:Number(m[1]), away:Number(m[2])};
        if (!score) {
          m = local.match(new RegExp(esc(hh) + "\\s+(\\d{1,2})\\s+" + esc(aa) + "\\s+(\\d{1,2})\\b", "i"));
          if (m) score = {home:Number(m[1]), away:Number(m[2])};
        }
        let minute = null;
        for (const re of [/\b(\d{1,3})\s*[\x27′]/, /\b(\d{1,3})\s*(?:min|mins|minute|minutes)\b/i]) {
          const x = local.match(re); if (x && Number(x[1]) <= 130) { minute=Number(x[1]); break; }
        }
        if (score && minute !== null && score.home <= 20 && score.away <= 20) return {status:"live",score,minute,scoreSource:"polymarket_live_card",minuteSource:"polymarket_live_card"};
        log("INFO","live_card_incomplete","Matched fixture card lacks real score or minute",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],score,minute});
      }
      pos = hi + hh.length;
    }
  }
  return null;
}

async function refreshPolymarketLiveState(match) {
  try {
    if (!livePagePromise) livePagePromise = loadPolymarketLivePage();
    const page = await livePagePromise;
    const live = page ? extractLiveCardData(page, match) : null;
    if (!live) { log("INFO","live_card_not_complete","LIVE alert blocked: real score AND minute were not found",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],scoreSource:null,minuteSource:null}); return null; }
    log("INFO","live_card_complete","Real score and minute extracted from matched LIVE fixture card",{eventId:match.eventId,teams:[match.homeTeam,match.awayTeam],score:live.score,minute:live.minute,scoreSource:live.scoreSource,minuteSource:live.minuteSource});
    return live;
  } catch (err) { log("WARN","live_state_failed","Could not read score and minute from matched LIVE fixture card",{eventId:match.eventId,message:err.message}); return null; }
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