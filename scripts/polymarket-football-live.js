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
      signal: AbortSignal.timeout(10_000),
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

function eventUrl(event) {
  const slug = text(event.slug);
  return slug ? "https://polymarket.com/event/" + slug : "";
}

function extractTeams(event) {
  const title = text(event.title || event.question);
  const candidates = [
    event.homeTeam && event.awayTeam ? [event.homeTeam, event.awayTeam] : null,
    event.home_team && event.away_team ? [event.home_team, event.away_team] : null
  ].filter(Boolean);

  if (candidates.length) return candidates[0].map(text);

  const m = title.match(/^(.+?)\s+(?:vs\.?|v\.?|versus)\s+(.+)$/i);
  return m ? [m[1].trim(), m[2].trim()] : ["", ""];
}

function isFootballEvent(event, footballIds) {
  const hay = [
    event.sport,
    event.sportSlug,
    event.sport_slug,
    event.category,
    event.tag,
    event.tags,
    event.title,
    event.question,
    event.series_id,
    event.seriesId
  ].flat(Infinity).map(text).join(" ").toLowerCase();

  if (footballIds.size) {
    const ids = [event.series_id, event.seriesId, event.sports_series_id]
      .map(text).filter(Boolean);
    if (ids.some(id => footballIds.has(id))) return true;
  }

  return /football|soccer|epl|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league/.test(hay);
}

async function getJson(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(10_000)
  });
  if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
  return r.json();
}

async function footballSeriesIds() {
  try {
    const data = await getJson(GAMMA_URL + "/sports");
    const rows = Array.isArray(data) ? data : (data.sports || data.data || []);
    const ids = new Set();

    for (const row of rows) {
      const hay = JSON.stringify(row).toLowerCase();
      if (!/football|soccer/.test(hay)) continue;
      for (const key of ["series", "series_id", "seriesId"]) {
        const id = text(row[key]);
        if (id) ids.add(id);
      }
    }

    return ids;
  } catch (err) {
    log("WARN", "sports_metadata_failed", "Could not load sports metadata; using event text fallback", { message: err.message });
    return new Set();
  }
}

async function activeEventsBySeries(seriesId) {
  const url = GAMMA_URL +
    "/events?series_id=" + encodeURIComponent(seriesId) +
    "&active=true&closed=false&limit=500";
  const data = await getJson(url);
  return Array.isArray(data) ? data : (data.events || data.data || []);
}

async function discoverPolymarket() {
  const now = Date.now();
  const candidates = [];
  const seen = new Set();
  let marketScanned = 0, footballMarketFound = 0, exactScoreFound = 0, oneOneFound = 0, matchRecognized = 0;

  await checkpoint("match_discovery_start", { strategy: "exact_score_1_1_market_first_v2" });

  for (let offset = 0; offset < 10000; offset += 500) {
    try {
      const data = await getJson(
        GAMMA_URL + "/markets?active=true&closed=false&limit=500&offset=" + offset
      );
      const rows = Array.isArray(data) ? data : (data.markets || data.data || []);
      marketScanned += rows.length;

      for (const market of rows) {
        if (!market || market.active === false || market.closed === true) continue;

        const question = text(market.question || market.title);
        const hay = JSON.stringify(market).toLowerCase();
        if (!/(football|soccer|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league)/i.test(hay)) continue;
        footballMarketFound += 1;

        const outcomes = parseJson(market.outcomes);
        const prices = parseJson(market.outcomePrices || market.outcome_prices);
        const outcomeList = Array.isArray(outcomes) ? outcomes : [];
        const priceList = Array.isArray(prices) ? prices : [];

        const oneOneIndex = outcomeList.findIndex(v => /^1\s*[-:]\s*1$/i.test(text(v)));
        const questionOneOne = /(?:^|\s)1\s*[-:]\s*1(?:\s|\?|$)/i.test(question);
        if (oneOneIndex < 0 && !questionOneOne) continue;
        if (oneOneIndex < 0 && !priceList.length) continue;

        exactScoreFound += 1;
        const priceIndex = oneOneIndex >= 0 ? oneOneIndex : 0;
        const price = Number(priceList[priceIndex]);
        if (!Number.isFinite(price)) continue;
        oneOneFound += 1;

        let event = Array.isArray(market.events) && market.events.length ? market.events[0] : null;
        const eventIdFromMarket = text(market.eventId || market.event_id);
        if (!event && eventIdFromMarket) {
          try { event = await getJson(GAMMA_URL + "/events/" + encodeURIComponent(eventIdFromMarket)); }
          catch (err) {
            log("WARN", "market_event_fetch_failed", "Could not load parent event", { eventId: eventIdFromMarket, message: err.message });
          }
        }
        if (!event) continue;

        const startValue = event.startDate || event.start_date || event.startTime || null;
        const start = Date.parse(startValue || "");
        if (Number.isFinite(start) && start <= now && now > start + EARLY_WINDOW_MS) continue;
        if (!isFootballEvent(event, new Set())) continue;

        const [home, away] = extractTeams(event);
        if (!home || !away) {
          log("INFO", "match_teams_missing", "Football 1:1 market has no recognizable teams", {
            marketId: text(market.id), question, eventId: text(event.id || eventIdFromMarket), title: text(event.title)
          });
          continue;
        }

        const eventId = text(event.id || event.eventId || event.event_id || eventIdFromMarket);
        const slug = text(event.slug || market.eventSlug || market.event_slug);
        const key = eventId || slug || text(market.id);
        if (!key || seen.has(key)) continue;

        const item = {
          eventId, slug,
          url: eventUrl(event),
          title: text(event.title || event.question || question),
          homeTeam: home, awayTeam: away,
          startTime: startValue,
          endTime: event.endDate || event.end_date || event.endTime || null,
          markets: [{
            marketId: text(market.id || market.marketId),
            conditionId: text(market.conditionId || market.condition_id),
            question, slug: text(market.slug),
            active: market.active !== false, closed: market.closed === true,
            outcomes: outcomeList, outcomePrices: priceList
          }]
        };

        seen.add(key);
        candidates.push(item);
        matchRecognized += 1;

        log("INFO", "one_one_market_found", "Exact-score 1:1 market recognized", {
          eventId, teams: [home, away], startTime: startValue, price,
          marketId: text(market.id), marketQuestion: question, slug
        });
      }

      await checkpoint("market_page_done", {
        offset, rows: rows.length, marketScanned, footballMarketFound,
        exactScoreFound, oneOneFound, matchRecognized,
        hasMore: data?.has_more ?? data?.hasMore ?? null
      });

      const hasMore = data?.has_more ?? data?.hasMore;
      if (hasMore === false || rows.length === 0) break;
    } catch (err) {
      log("WARN", "market_page_failed", "Polymarket market discovery failed", { offset, message: err.message });
      break;
    }
  }

  await checkpoint("match_discovery_done", {
    marketScanned, footballMarketFound, exactScoreFound, oneOneFound,
    matchRecognized, candidates: candidates.length
  });
  return candidates;
}
function stripHtml(value) {
  return text(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
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
  let best = null;
  let bestScore = 0;
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

function findOneOneMarket(match) {
  for (const market of match.markets || []) {
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
    const prices = Array.isArray(market.outcomePrices) ? market.outcomePrices : [];

    // Polymarket exact-score markets are commonly separate Yes/No markets,
    // with the score embedded in the question, e.g.:
    // "Exact Score: Home 1 - 1 Away?"
    const question = text(market.question || "");
    if (/(?:exact score|correct score)/i.test(question) &&
        /(?:^|\s)1\s*[-:]\s*1(?:\s|\?|$)/i.test(question)) {
      const yesIndex = outcomes.findIndex(v => /^yes$/i.test(text(v)));
      const index = yesIndex >= 0 ? yesIndex : 0;
      const price = Number(prices[index]);
      if (Number.isFinite(price)) {
        return { market, outcome: text(outcomes[index] || "Yes"), price };
      }
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
  const market = findOneOneMarket(match);
  if (!market) {
    log("INFO", "one_one_market_missing", "No 1:1 exact-score market found", { eventId: match.eventId, teams: [match.homeTeam, match.awayTeam] });
    return;
  }

  const key = match.eventId || match.slug;
  const preMatch = Number.isFinite(Date.parse(match.startTime || "")) && Date.parse(match.startTime) > Date.now();
  const total = preMatch ? 0 : scoreTotal(match);
  if (!preMatch && (!match.live || match.live.status === "unresolved" || match.live.status === "provider_error")) return;
  const state = oneOneState.get(key) || { first: false, second: false, lastTotal: -1 };

  if (!balancedForOneOne(nutmeg)) {
    log("INFO", "one_one_rejected_balance", "Match rejected by Nutmegly balance filter", {
      eventId: match.eventId,
      teams: [match.homeTeam, match.awayTeam],
      nutmeg: nutmeg?.row || null
    });
    oneOneState.set(key, state);
    return;
  }

  if (total === 0 && !state.first && state.lastTotal <= 0) {
    const message = [
      "⚽ 1:1 · BUY",
      "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: 0–0",
      "1:1 PRICE: " + (market.price * 100).toFixed(1) + "%",
      "",
      "➡️ OPEN MATCH",
      match.url
    ].join("\n");
    const claimed = await claimTelegramAlert(key + ":BUY");
    if (!claimed) return;
    try {
      const sent = await sendTelegram(message);
      if (!sent) return;
    } catch (err) {
      await releaseTelegramAlert(key + ":BUY");
      log("ERROR", "telegram_send_failed", "BUY alert send failed; claim released for retry", { eventId: match.eventId, message: err.message });
      return;
    }
    state.first = true;
    state.firstPrice = market.price;
    log("INFO", "one_one_buy_alert_sent", "1:1 entry alert sent", { eventId: match.eventId, price: market.price, nutmeg: nutmeg.row });
  }

  if (total >= 1 && !state.second) {
    const message = [
      "⚽ 1:1 · SELL",
      "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: " + match.live.score.home + "–" + match.live.score.away,
      "1:1 PRICE: " + (market.price * 100).toFixed(1) + "%",
      "",
      "➡️ OPEN MATCH",
      match.url
    ].join("\n");
    const claimed = await claimTelegramAlert(key + ":SELL");
    if (!claimed) return;
    try {
      const sent = await sendTelegram(message);
      if (!sent) return;
    } catch (err) {
      await releaseTelegramAlert(key + ":SELL");
      log("ERROR", "telegram_send_failed", "SELL alert send failed; claim released for retry", { eventId: match.eventId, message: err.message });
      return;
    }
    state.second = true;
    log("INFO", "one_one_sell_alert_sent", "1:1 exit alert sent after first goal", { eventId: match.eventId, price: market.price, firstPrice: state.firstPrice });
  }

  if (total > 0 && !state.second) state.first = true;
  state.lastTotal = total;
  oneOneState.set(key, state);
}

async function tick() {
  if (stopping || tick.running) return;
  tick.running = true;
  convexTickCount += 1;

  try {
    const matches = await discoverPolymarket();
    const nutmeg = await nutmegRows();

    log("INFO", "polymarket_discovery", "Polymarket football 1:1 candidates discovered", {
      count: matches.length,
      matches: matches.map(m => ({
        eventId: m.eventId,
        teams: [m.homeTeam, m.awayTeam],
        startTime: m.startTime,
        url: m.url,
        marketCount: m.markets.length
      }))
    });

    // Pre-match candidates do not need SportScore: the absence of a started
    // match is determined directly from Polymarket startTime. SportScore is
    // only needed once the scheduled start time has passed.
    const now = Date.now();
    const preMatchCandidates = matches.filter(m => {
      const startMs = Date.parse(m.startTime || "");
      return Number.isFinite(startMs) && startMs > now;
    });
    const liveCandidates = matches.filter(m => !preMatchCandidates.includes(m));

    await enrichLiveMatches(liveCandidates);

    for (const match of matches) {
      if (match.live?.status === "provider_error") continue;

      const startMs = Date.parse(match.startTime || "");
      const preMatch = Number.isFinite(startMs) && startMs > Date.now();

      if (!preMatch && match.live?.status === "unresolved") {
        log("INFO", "match_unresolved", "Started candidate has no SportScore fixture match", { eventId: match.eventId, teams: [match.homeTeam, match.awayTeam] });
        continue;
      }

      const score = preMatch ? { home: 0, away: 0 } : match.live?.score;
      const minute = preMatch ? 0 : match.live?.minute;

      const nm = findNutmegMatch(match, nutmeg);
      log("INFO", "one_one_evaluation", "1:1 strategy evaluated", {
        eventId: match.eventId,
        teams: [match.homeTeam, match.awayTeam],
        score,
        minute,
        preMatch,
        nutmeg: nm?.row || null,
        balanced: balancedForOneOne(nm),
        oneOneMarket: findOneOneMarket(match)?.price ?? null
      });

      await maybeOneOneAlert({ ...match, live: { ...(match.live || {}), score, minute, status: preMatch ? "scheduled" : match.live?.status } }, nm);
    }
  } catch (err) {
    log("ERROR", "discovery_failed", "1:1 football monitoring failed; monitoring continues", { message: err.message });
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
    homeTeam: home,
    awayTeam: away,
    minute: Number.isFinite(minute) ? minute : 0,
    score: { home: scoreHome, away: scoreAway },
    startingAt: match.time || match.start_time || null,
    stateId: text(match.status),
    events: Array.isArray(match.incidents) ? match.incidents : []
  };
}

function resolveSportScore(match, fixtures) {
  let best = null;
  let bestScore = 0;
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
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const xa = new Set(x.split(" "));
  const ya = new Set(y.split(" "));
  const overlap = [...xa].filter(token => ya.has(token)).length;
  return overlap / Math.max(xa.size, ya.size);
}

async function enrichLiveMatches(polymarketMatches) {
  const fixtures = await sportscoreLatest();
  const candidateFixtures = fixtures.filter(f =>
    /live|in progress|1st half|2nd half|halftime|playing|started|ongoing|scheduled|upcoming|not started|fixture/i
      .test(text(f.status) + " " + text(f.status_text))
  );

  for (const match of polymarketMatches) {
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
            eventId: match.eventId,
            polymarketTeams: [match.homeTeam, match.awayTeam],
            sportscoreTeams: [found.fixture.home, found.fixture.away],
            confidence: found.score,
            fixture: slug
          });
        }
      }
    }

    if (!resolvedMatch) {
      match.live = { status: "unresolved" };
      continue;
    }

    const detail = await sportscoreMatch(resolvedMatch.fixtureId).catch(err => {
      log("WARN", "fixture_failed", "SportScore match refresh failed", {
        fixture: resolvedMatch.fixtureId,
        message: err.message
      });
      return null;
    });

    if (!detail) {
      match.live = { status: "provider_error" };
      continue;
    }

    match.provider = "sportscore";
    match.providerFixtureId = resolvedMatch.fixtureId;
    match.live = normalizeSportScore(detail);
  }
}

async function claimTelegramAlert(key) {
  const base = process.env.CONVEX_SITE_URL || "https://brainy-canary-207.eu-west-1.convex.site";
  try {
    const response = await fetch(base.replace(/\/$/, "") + "/football/claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ monitor: "polymarket-football-1-1", marketSlug: key }),
      signal: AbortSignal.timeout(10_000),
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
      signal: AbortSignal.timeout(10_000),
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
    body: JSON.stringify({
      chat_id: chatId,
      text: textMessage,
      disable_web_page_preview: false
    }),
    signal: AbortSignal.timeout(10_000)
  });

  if (!response.ok) throw new Error("Telegram HTTP " + response.status);
  const body = await response.json();
  if (!body.ok) throw new Error("Telegram API rejected message");
  return true;
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  log("INFO", "monitor_stopped", "Polymarket football 1:1 monitor stopped");
}

async function start() {
  log("INFO", "monitor_started", "Polymarket football 1:1 monitor started", {
    pollSec: POLL_MS / 1000,
    runHours: RUN_MS / 3_600_000,
    provider: "sportscore",
    strategy: "exact_score_1_1"
  });

  await tick();
  timer = setInterval(() => { tick(); }, POLL_MS);
  setTimeout(stop, RUN_MS);
}

process.on("SIGTERM", () => { stop(); process.exit(0); });
start();
