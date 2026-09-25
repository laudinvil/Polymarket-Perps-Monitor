const GAMMA_URL = "https://gamma-api.polymarket.com";
const SPORTScore_URL = "https://sportscore.com/api/widget";

const POLL_MS = 15_000;
const MIN_EDGE = 0.01;
const RUN_MS = 6 * 60 * 60 * 1000;
const HISTORY_MS = 20 * 60 * 1000;
const ALERT_BUCKET_MS = 60 * 1000;
const PREMATCH_WINDOW_MS = 10 * 60 * 1000;
const EARLY_WINDOW_MS = 7 * 60 * 1000;
const NUTMEG_CACHE_MS = 5 * 60 * 1000;
const BALANCE_MAX_DIFF = 0.12;
const MIN_DRAW_PROB = 0.22;
const MIN_BTTS_PROB = 0.45;

let stopping = false;
let timer = null;
const known = new Map();
const resolved = new Map();
const history = new Map();

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
  const seriesIds = await footballSeriesIds();
  let events = [];

  if (seriesIds.size) {
    const chunks = await Promise.all([...seriesIds].map(id =>
      activeEventsBySeries(id).catch(err => {
        log("WARN", "series_failed", "Football series query failed", { seriesId: id, message: err.message });
        return [];
      })
    ));
    events = chunks.flat();
  } else {
    const data = await getJson(GAMMA_URL + "/events?active=true&closed=false&limit=500");
    events = Array.isArray(data) ? data : (data.events || data.data || []);
  }

  const candidates = [];
  const seen = new Set();

  for (const event of events) {
    if (!event || !isFootballEvent(event, seriesIds)) continue;

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
    .replace(/<script[\\s\\S]*?<\\/script>/gi, " ")
    .replace(/<style[\\s\\S]*?<\\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\\s+/g, " ")
    .trim();
}

async function nutmegRows() {
  if (Date.now() - nutmegCache.at < NUTMEG_CACHE_MS) return nutmegCache.rows;

  const rows = [];
  const pages = [1, 2, 3, 4, 5];
  for (const page of pages) {
    try {
      const url = "https://nutmegly.com/?competition=all&page=" + page + "&status=upcoming&tz=UTC";
      const r = await fetch(url, { headers: { accept: "text/html" }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) continue;
      const body = stripHtml(await r.text());
      const re = /([^|]{2,80})\\s+VS\\s+([^|]{2,80})\\s+(?:Home win|Home)\\s*(\\d+)%\\s*(?:Draw)\\s*(\\d+)%\\s*(?:Away win|Away)\\s*(\\d+)%/gi;
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
      log("WARN", "nutmeg_fetch_failed", "Nutmegly page fetch failed", { page, message: err.message });
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
      if (/^1\\s*[-:]\\s*1$/.test(text(outcomes[i]))) {
        const price = Number((market.outcomePrices || [])[i]);
        if (Number.isFinite(price)) return { market, outcome: text(outcomes[i]), price };
      }
    }
    if (/correct score|exact score|score/i.test(market.question || "")) {
      const i = outcomes.findIndex(v => /^1\\s*[-:]\\s*1$/.test(text(v)));
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
  if (!match.url || !match.live) return;
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
    ].join("\\n");
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
    ].join("\\n");
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
