const GAMMA_URL = "https://gamma-api.polymarket.com";
const SPORTScore_URL = "https://sportscore.com/api/widget";

const POLL_MS = 15_000;
const MIN_EDGE = 0.01;
const RUN_MS = 6 * 60 * 60 * 1000;
const HISTORY_MS = 20 * 60 * 1000;
const ALERT_BUCKET_MS = 60 * 1000;
const PREMATCH_WINDOW_MS = 30 * 60 * 1000;
const EARLY_WINDOW_MS = 15 * 60 * 1000;
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

function log(level, event, message, data = undefined) {
  console.log(JSON.stringify({
    level,
    event,
    message,
    ...(data === undefined ? {} : { data: JSON.stringify(data) })
  }));
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
      for (const key of ["series_id", "seriesId", "id"]) {
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
  let events = [];

  try {
    const data = await getJson(
      GAMMA_URL + "/events?active=true&closed=false&tag_slug=soccer&limit=500&offset=0&order=startDate&ascending=true"
    );
    events = Array.isArray(data) ? data : (data.events || data.data || []);
  } catch (err) {
    log("WARN", "soccer_tag_query_failed", "Direct soccer event query failed; using active-event fallback", { message: err.message });
    const data = await getJson(GAMMA_URL + "/events?active=true&closed=false&limit=500");
    events = Array.isArray(data) ? data : (data.events || data.data || []);
  }

  const candidates = [];
  const seen = new Set();

  for (const event of events) {
    if (!event || !isFootballEvent(event, new Set())) continue;

    const start = Date.parse(event.startDate || event.start_date || event.startTime || "");
    const end = Date.parse(event.endDate || event.end_date || event.endTime || "");
    const inWindow =
      Number.isFinite(start) &&
      start <= now + PREMATCH_WINDOW_MS &&
      (!Number.isFinite(end) || end > now) &&
      now >= start - PREMATCH_WINDOW_MS &&
      now <= start + EARLY_WINDOW_MS;
    if (!inWindow) continue;

    const id = text(event.id || event.eventId || event.event_id);
    const slug = text(event.slug);
    const key = id || slug;
    if (!key || seen.has(key)) continue;
    seen.add(key);

    const [home, away] = extractTeams(event);
    const markets = Array.isArray(event.markets) ? event.markets : [];

    const item = {
      eventId: id,
      slug,
      url: eventUrl(event),
      title: text(event.title || event.question),
      homeTeam: home,
      awayTeam: away,
      startTime: event.startDate || event.start_date || event.startTime || null,
      endTime: event.endDate || event.end_date || event.endTime || null,
      markets: markets.map(m => ({
        marketId: text(m.id || m.marketId),
        conditionId: text(m.conditionId || m.condition_id),
        question: text(m.question || m.title),
        slug: text(m.slug),
        active: m.active !== false,
        closed: m.closed === true,
        clobTokenIds: parseJson(m.clobTokenIds || m.clob_token_ids),
        outcomes: parseJson(m.outcomes),
        outcomePrices: parseJson(m.outcomePrices || m.outcome_prices)
      }))
    };

    candidates.push(item);
    if (!known.has(key)) {
      known.set(key, now);
      log("INFO", "candidate_match_found", "Polymarket football candidate for 1:1 strategy", item);
    }
  }

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

  for (const status of statuses) {
    for (const page of pages) {
      try {
        const url = "https://nutmegly.com/?competition=all&page=" + page + "&status=" + status + "&tz=UTC";
        const r = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(10_000) });
        if (!r.ok) continue;
        const body = stripHtml(await r.text());
        const re = /(.{2,100}?)\s+VS\s+(.{2,100}?)\s+Home win\s*(\d+(?:\.\d+)?)%\s+Draw\s*(\d+(?:\.\d+)?)%\s+Away win\s*(\d+(?:\.\d+)?)%/gi;
        let m;
        while ((m = re.exec(body))) {
          rows.push({
            home: m[1].trim(),
            away: m[2].trim(),
            homeProb: Number(m[3]) / 100,
            drawProb: Number(m[4]) / 100,
            awayProb: Number(m[5]) / 100,
            bttsProb: NaN
          });
        }
      } catch (err) {
        log("WARN", "nutmeg_fetch_failed", "Nutmegly page fetch failed", { status, page, message: err.message });
      }
    }
  }

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
    for (let i = 0; i < outcomes.length; i++) {
      if (/^1\s*[-:]\s*1$/.test(text(outcomes[i]))) {
        const price = Number((market.outcomePrices || [])[i]);
        if (Number.isFinite(price)) return { market, outcome: text(outcomes[i]), price };
      }
    }
    if (/correct score|exact score|score/i.test(market.question || "")) {
      const i = outcomes.findIndex(v => /^1\s*[-:]\s*1$/.test(text(v)));
      const price = Number((market.outcomePrices || [])[i]);
      if (i >= 0 && Number.isFinite(price)) return { market, outcome: text(outcomes[i]), price };
    }
  }
  return null;
}

function scoreTotal(match) {
  return Number(match.live?.score?.home || 0) + Number(match.live?.score?.away || 0);
}

async function maybeOneOneAlert(match, nutmeg) {
  if (!match.url || !match.live || match.live.status === "unresolved" || match.live.status === "provider_error") return;
  const market = findOneOneMarket(match);
  if (!market) {
    log("INFO", "one_one_market_missing", "No 1:1 exact-score market found", { eventId: match.eventId, teams: [match.homeTeam, match.awayTeam] });
    return;
  }

  const key = match.eventId || match.slug;
  const total = scoreTotal(match);
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

  if (total === 0 && !state.first) {
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
    await sendTelegram(message);
    state.first = true;
    state.firstPrice = market.price;
    log("INFO", "one_one_buy_alert_sent", "1:1 entry alert sent", { eventId: match.eventId, price: market.price, nutmeg: nutmeg.row });
  }

  if (total === 1 && state.first && !state.second) {
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
    await sendTelegram(message);
    state.second = true;
    log("INFO", "one_one_sell_alert_sent", "1:1 exit alert sent after first goal", { eventId: match.eventId, price: market.price, firstPrice: state.firstPrice });
  }

  state.lastTotal = total;
  oneOneState.set(key, state);
}

async function tick() {
  if (stopping) return;

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

    await enrichLiveMatches(matches);

    for (const match of matches) {
      if (match.live?.status === "unresolved") {
        log("INFO", "match_unresolved", "Candidate has no SportScore fixture match", { eventId: match.eventId, teams: [match.homeTeam, match.awayTeam] });
        continue;
      }
      if (match.live?.status === "provider_error") continue;

      const nm = findNutmegMatch(match, nutmeg);
      log("INFO", "one_one_evaluation", "1:1 strategy evaluated", {
        eventId: match.eventId,
        teams: [match.homeTeam, match.awayTeam],
        score: match.live.score,
        minute: match.live.minute,
        nutmeg: nm?.row || null,
        balanced: balancedForOneOne(nm),
        oneOneMarket: findOneOneMarket(match)?.price ?? null
      });

      await maybeOneOneAlert(match, nm);
    }
  } catch (err) {
    log("ERROR", "discovery_failed", "1:1 football monitoring failed; monitoring continues", { message: err.message });
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
  const url = SPORTScore_URL + "/matches/?sport=football&limit=200";
  const data = await getJson(url);
  return Array.isArray(data?.matches) ? data.matches : [];
}

async function sportscoreMatch(slug) {
  const url = SPORTScore_URL + "/match/?sport=football&slug=" + encodeURIComponent(slug);
  const data = await getJson(url);
  return data?.match || null;
}

function normalizeSportScore(match) {
  const home = text(match.home);
  const away = text(match.away);
  const scoreHome = Number(match.home_score ?? match.score?.home ?? 0);
  const scoreAway = Number(match.away_score ?? match.score?.away ?? 0);
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
