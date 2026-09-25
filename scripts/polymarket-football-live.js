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
    event.sport, event.sportSlug, event.sport_slug, event.category, event.tag,
    event.tags, event.title, event.question, event.series_id, event.seriesId
  ].flat(Infinity).map(text).join(" ").toLowerCase();
  if (footballIds.size) {
    const ids = [event.series_id, event.seriesId, event.sports_series_id].map(text).filter(Boolean);
    if (ids.some(id => footballIds.has(id))) return true;
  }
  return /football|soccer|epl|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league/.test(hay);
}

async function getJson(url, options = {}) {
  const r = await fetch(url, {
    ...options,
    headers: { accept: "application/json", ...(options.headers || {}) },
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
  const url = GAMMA_URL + "/events?series_id=" + encodeURIComponent(seriesId) + "&active=true&closed=false&limit=500";
  const data = await getJson(url);
  return Array.isArray(data) ? data : (data.events || data.data || []);
}

async function discoverPolymarket() {
  const candidates = [];
  const seen = new Set();
  let eventScanned = 0, footballEventFound = 0, candidatesFound = 0;

  await checkpoint("discovery_start", {
    strategy: "football_match_first_v5",
    source: "tag_slug=soccer",
    note: "Discover football directly from Polymarket sports tag; do not scan generic event pages"
  });

  // The old discovery scanned the generic /events feed and then guessed football
  // from free-text fields. That is unreliable because the generic feed is not a
  // sports index and football can sit outside the first 3000 rows.
  // Polymarket exposes sports events through the soccer tag, so query that index
  // directly. Keep a sports-tag fallback as a second source.
  // Gamma's sports tag feed is not reliably ordered by startDate: the first
  // pages can contain old total-corners and season markets. Use the event ID
  // (newest objects first) and constrain the event to something that has not
  // already ended. Also query the dedicated live=true view so an in-play match
  // cannot be buried behind unrelated sports markets.
  const sources = [
    {
      name: "soccer_newest",
      baseUrl: GAMMA_URL + "/events?tag_slug=soccer&active=true&closed=false&limit=100&order=id&ascending=false"
    },
    {
      name: "soccer_live",
      baseUrl: GAMMA_URL + "/events?tag_slug=soccer&live=true&active=true&closed=false&limit=100&order=id&ascending=false"
    },
    {
      name: "sports_newest",
      baseUrl: GAMMA_URL + "/events?tag_id=100639&active=true&closed=false&limit=100&order=id&ascending=false"
    }
  ];

  // The primary feed is the newest soccer events, not only live events.
  // This lets newly listed pre-match fixtures enter the monitor immediately.
  // live=true remains an additional fast path for in-play matches.
  // Keep the scan bounded because Gamma pages are capped at 100 rows.
  // Keep discovery bounded: 3 newest soccer pages + 1 live page + 2 fallback pages.
  // The previous 10 pages for all 3 sources created 30 concurrent requests and
  // could keep the whole discovery stage in progress for a long time.
  const pagePlan = {
    soccer_newest: 3,
    soccer_live: 1,
    sports_newest: 2
  };
  const sourcePages = sources.flatMap(source =>
    Array.from({ length: pagePlan[source.name] ?? 1 }, (_, page) => ({
      name: source.name,
      url: source.baseUrl + "&offset=" + (page * 100),
      page
    }))
  );

  const results = await Promise.all(sourcePages.map(async source => {
    const startedAt = Date.now();
    try {
      const response = await fetch(source.url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000)
      });
      const contentType = text(response.headers.get("content-type"));
      const body = await response.text();
      const elapsedMs = Date.now() - startedAt;

      if (!response.ok) {
        log("ERROR", "event_source_http_error", "Polymarket football source returned non-2xx", {
          source: source.name,
          status: response.status,
          statusText: response.statusText,
          contentType,
          bodyPreview: body.slice(0, 500),
          elapsedMs
        });
        throw new Error("HTTP " + response.status + " for " + source.url);
      }

      let data;
      try {
        data = JSON.parse(body);
      } catch (error) {
        log("ERROR", "event_source_json_error", "Polymarket football source returned invalid JSON", {
          source: source.name,
          status: response.status,
          contentType,
          bodyPreview: body.slice(0, 500),
          elapsedMs,
          message: error.message
        });
        throw error;
      }

      const rows = Array.isArray(data) ? data : (data?.events || data?.data || []);
      const sample = rows.slice(0, 5).map(event => ({
        id: text(event?.id || event?.eventId || event?.event_id),
        slug: text(event?.slug),
        title: text(event?.title || event?.question),
        sport: text(event?.sport || event?.sportSlug || event?.sport_slug),
        category: text(event?.category),
        active: event?.active,
        closed: event?.closed,
        startDate: text(event?.startDate || event?.start_date || event?.startTime)
      }));

      log("INFO", "event_source_response", "Raw Polymarket football source response captured", {
        source: source.name,
        status: response.status,
        contentType,
        bodyBytes: Buffer.byteLength(body, "utf8"),
        elapsedMs,
        payloadType: Array.isArray(data) ? "array" : typeof data,
        rowCount: rows.length,
        topLevelKeys: data && !Array.isArray(data) && typeof data === "object" ? Object.keys(data).slice(0, 30) : [],
        sample
      });

      return {
        name: source.name,
        rows,
        error: null
      };
    } catch (error) {
      return { name: source.name, rows: [], error };
    }
  }));

  for (const result of results) {
    if (result.error) {
      log("WARN", "event_source_failed", "Polymarket football source failed", {
        source: result.name,
        message: result.error.message
      });
      continue;
    }

    eventScanned += result.rows.length;

    for (const event of result.rows) {
      if (!event || event.active === false || event.closed === true) continue;

      const hay = [
        event.sport, event.sportSlug, event.sport_slug,
        event.category, event.tags, event.title, event.question
      ].flat(Infinity).map(text).join(" ");

      // The soccer-tag feed is already a football index, so do not require
      // the title to contain "football" or "soccer". Real match titles are
      // normally just "Team A vs Team B". The generic sports-tag fallback
      // still needs the text sanity check.
      const footballSource = result.name === "soccer_newest" || result.name === "soccer_live";
      if (!footballSource &&
          !/football|soccer|premier league|la liga|bundesliga|serie a|ligue 1|champions league|europa league/i.test(hay)) {
        continue;
      }

      footballEventFound++;

      const [home, away] = extractTeams(event);
      if (!home || !away) {
        log("INFO", "match_teams_missing", "Football event has no recognizable teams", {
          eventId: text(event.id),
          title: text(event.title)
        });
        continue;
      }

      const startTime = event.startDate || event.start_date || event.startTime || null;
      const startMs = Date.parse(startTime || "");
      const endTime = event.endDate || event.end_date || event.endTime || null;
      const endMs = Date.parse(endTime || "");

      // Do not use event.endDate as a hard discovery filter. Gamma can expose
      // active sports events whose event-level end timestamp is stale or tied
      // to the market lifecycle rather than the fixture itself. active/closed
      // are the authoritative lifecycle flags here; SportScore resolves the
      // actual live/pre-match state later.
      if (Number.isFinite(endMs) && endMs < Date.now()) {
        log("INFO", "event_enddate_observed_not_filtered", "Active football event has a past endDate; keeping it for fixture resolution", {
          eventId: text(event.id),
          title: text(event.title || event.question),
          startTime,
          endTime,
          active: event.active,
          closed: event.closed
        });
      }

      const eventId = text(event.id || event.eventId || event.event_id);
      const slug = text(event.slug);
      const key = eventId || slug;

      if (!key) {
        log("WARN", "match_identity_missing", "Football match has teams but no event id/slug", {
          title: text(event.title || event.question),
          home,
          away
        });
        continue;
      }

      if (seen.has(key)) {
        log("INFO", "match_duplicate_filtered", "Football match already discovered from another source/page", {
          eventId,
          slug,
          teams: [home, away]
        });
        continue;
      }

      seen.add(key);
      candidatesFound++;

      log("INFO", "candidate_gate_passed", "Football match passed discovery gates", {
        source: result.name,
        eventId,
        slug,
        teams: [home, away],
        startTime,
        endTime,
        active: event.active,
        closed: event.closed
      });

      const nestedMarkets = Array.isArray(event.markets)
        ? event.markets.map(market => ({
            marketId: text(market?.id || market?.marketId),
            question: text(market?.question || market?.title),
            outcomes: Array.isArray(parseJson(market?.outcomes)) ? parseJson(market.outcomes) : [],
            outcomePrices: Array.isArray(parseJson(market?.outcomePrices || market?.outcome_prices))
              ? parseJson(market?.outcomePrices || market?.outcome_prices) : [],
            active: market?.active !== false,
            closed: market?.closed === true
          }))
        : [];

      candidates.push({
        eventId,
        slug,
        url: eventUrl(event),
        title: text(event.title || event.question),
        homeTeam: home,
        awayTeam: away,
        startTime,
        endTime: event.endDate || event.end_date || event.endTime || null,
        markets: nestedMarkets
      });

      log("INFO", "candidate_discovered", "Football match candidate discovered from Polymarket sports index", {
        source: result.name,
        eventId,
        teams: [home, away],
        startTime,
        marketCount: nestedMarkets.length,
        oneOneMarketAvailable: Boolean(findOneOneMarket({ markets: nestedMarkets })),
        url: eventUrl(event)
      });
    }

    await checkpoint("event_source_done", {
      source: result.name,
      rows: result.rows.length,
      eventScanned,
      footballEventFound,
      candidatesFound
    });
  }

  await checkpoint("discovery_done", {
    eventScanned,
    footballEventFound,
    candidatesFound,
    candidates: candidates.length
  });

  return candidates;
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
  await ensureEventMarkets(match);
  const market = findOneOneMarket(match);
  if (!market) {
    log("INFO", "one_one_market_missing", "No 1:1 exact-score market found", {
      eventId: match.eventId, teams: [match.homeTeam, match.awayTeam]
    });
    return;
  }

  const key = match.eventId || match.slug;
  const preMatch = Number.isFinite(Date.parse(match.startTime || "")) &&
    Date.parse(match.startTime) > Date.now();
  const home = Number(match.live?.score?.home || 0);
  const away = Number(match.live?.score?.away || 0);

  if (!preMatch && (!match.live || match.live.status === "unresolved" || match.live.status === "provider_error")) return;

  if (preMatch || (home === 0 && away === 0)) {
    const claimKey = key + ":BUY";
    const claimed = await claimTelegramAlert(claimKey);
    if (!claimed) return;

    const message = [
      "⚽ 1:1 · BUY", "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: 0–0",
      "1:1 PRICE: " + (market.price * 100).toFixed(1) + "%",
      "", "➡️ OPEN MATCH", match.url
    ].join("\n");

    try {
      if (!await sendTelegram(message)) throw new Error("Telegram not configured");
      log("INFO", "one_one_buy_alert_sent", "1:1 entry alert sent", {
        eventId: match.eventId, price: market.price, preMatch
      });
    } catch (err) {
      await releaseTelegramAlert(claimKey);
      log("ERROR", "telegram_send_failed", "BUY alert send failed; claim released", {
        eventId: match.eventId, message: err.message
      });
    }
    return;
  }

  // SELL is a second phase. Convex only allows it when a BUY claim exists.
  // Normal exit: exactly 1:0 or 0:1 after the first goal.
  // Recovery exit: 1:1 if polling missed the first-goal state and the
  // match has already moved on before the SELL alert could be sent.
  if ((home === 1 && away === 0) || (home === 0 && away === 1) || (home === 1 && away === 1)) {
    const claimKey = key + ":SELL";
    const claimed = await claimTelegramAlert(claimKey);
    if (!claimed) return;

    const message = [
      "⚽ 1:1 · SELL", "",
      match.homeTeam + " vs " + match.awayTeam,
      "SCORE: " + home + "–" + away,
      "1:1 PRICE: " + (market.price * 100).toFixed(1) + "%",
      "", "➡️ OPEN MATCH", match.url
    ].join("\n");

    try {
      if (!await sendTelegram(message)) throw new Error("Telegram not configured");
      log("INFO", "one_one_sell_alert_sent", "1:1 exit alert sent after first goal", {
        eventId: match.eventId,
        price: market.price,
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
    const liveCandidates = matches.filter(m => {
      const startMs = Date.parse(m.startTime || "");
      return !(Number.isFinite(startMs) && startMs > now);
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
      const startMs = Date.parse(match.startTime || "");
      const preMatch = Number.isFinite(startMs) && startMs > Date.now();

      if (preMatch) {
        const nm = findNutmegMatch(match, nutmeg);
        log("INFO", "candidate_match_found", "Pre-match 1:1 candidate evaluated", {
          eventId: match.eventId,
          teams: [match.homeTeam, match.awayTeam],
          preMatch: true,
          nutmegMatched: Boolean(nm),
          nutmegScore: nm?.score ?? null,
          balanced: balancedForOneOne(nm),
          price: findOneOneMarket(match)?.price ?? null
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

        await maybeOneOneAlert({ ...match, live: { ...match.live, score } }, nm);
        continue;
      }

      // After kickoff and after a goal, do not run BUY filters.
      // maybeOneOneAlert will send SELL only for exactly 1:0/0:1,
      // and Convex will reject SELL unless the BUY phase was completed.
      await maybeOneOneAlert({ ...match, live: { ...match.live, score } }, null);
    }

    log("INFO", "stage_done", "Alert evaluation stage finished", {
      stage: "evaluation", elapsedMs: Date.now() - evaluationStartedAt, candidates: matches.length
    });
    log("INFO", "tick_done", "Football monitor tick completed", {
      elapsedMs: Date.now() - tickStartedAt, candidates: matches.length
    });
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

function stop() {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  log("INFO", "monitor_stopped", "Polymarket football 1:1 monitor stopped");
}

async function start() {
  log("INFO", "monitor_started", "Polymarket football 1:1 monitor started", {
    pollSec: POLL_MS / 1000, runHours: RUN_MS / 3_600_000,
    provider: "sportscore", strategy: "exact_score_1_1"
  });
  await tick();
  timer = setInterval(() => { tick(); }, POLL_MS);
  setTimeout(stop, RUN_MS);
}

process.on("SIGTERM", () => { stop(); process.exit(0); });
start();
