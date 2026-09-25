const GAMMA_URL = "https://gamma-api.polymarket.com";
const SPORTMONKS_URL = "https://api.sportmonks.com/v3/football";
const SPORTMONKS_TOKEN = process.env.SPORTMONKS_TOKEN || "";

const POLL_MS = 15_000;
const RUN_MS = 6 * 60 * 60 * 1000;

let stopping = false;
let timer = null;
const known = new Map();
const resolved = new Map();

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

  const live = [];
  const seen = new Set();

  for (const event of events) {
    if (!event || !isFootballEvent(event, seriesIds)) continue;

    const start = Date.parse(event.startDate || event.start_date || event.startTime || "");
    const end = Date.parse(event.endDate || event.end_date || event.endTime || "");
    const isLiveWindow = Number.isFinite(start) && start <= now && (!Number.isFinite(end) || end > now);
    if (!isLiveWindow) continue;

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

    live.push(item);

    if (!known.has(key)) {
      known.set(key, now);
      log("INFO", "live_match_found", "New live Polymarket football match", item);
    }
  }

  return live;
}

function sportmonksHeaders() {
  return {
    Authorization: "Bearer " + SPORTMONKS_TOKEN
  };
}

function participants(fixture) {
  return Array.isArray(fixture?.participants) ? fixture.participants : [];
}

function fixtureTeams(fixture) {
  const parts = participants(fixture);
  const home = parts.find(p => p.meta?.location === "home") || parts.find(p => p.location === "home");
  const away = parts.find(p => p.meta?.location === "away") || parts.find(p => p.location === "away");
  return {
    home: text(home?.name),
    away: text(away?.name)
  };
}

function matchScore(fixture) {
  const scores = Array.isArray(fixture?.scores) ? fixture.scores : [];
  const current = scores.filter(s => s.description === "CURRENT" || s.type?.code === "current");
  const list = current.length ? current : scores;
  const home = list.find(s => s.participant_id === fixture?.participants?.find(p => p.meta?.location === "home")?.id);
  const away = list.find(s => s.participant_id === fixture?.participants?.find(p => p.meta?.location === "away")?.id);
  return {
    home: Number(home?.score?.goals ?? home?.goals ?? 0),
    away: Number(away?.score?.goals ?? away?.goals ?? 0)
  };
}

function currentMinute(fixture) {
  const periods = Array.isArray(fixture?.periods) ? fixture.periods : [];
  const ticking = periods.find(p => p.ticking === true);
  if (ticking?.minutes != null) return Number(ticking.minutes);
  return Number(periods.at(-1)?.minutes ?? 0);
}

function extractXg(fixture) {
  const rows = Array.isArray(fixture?.xgfixture) ? fixture.xgfixture : [];
  const home = rows.find(x => x.location === "home" && (x.type?.code === "expected-goals" || /expected goals/i.test(text(x.type?.name))));
  const away = rows.find(x => x.location === "away" && (x.type?.code === "expected-goals" || /expected goals/i.test(text(x.type?.name))));
  return {
    home: Number(home?.data?.value ?? NaN),
    away: Number(away?.data?.value ?? NaN)
  };
}

function normalizeFixture(fixture) {
  const teams = fixtureTeams(fixture);
  return {
    fixtureId: String(fixture.id),
    name: text(fixture.name),
    homeTeam: teams.home,
    awayTeam: teams.away,
    minute: currentMinute(fixture),
    score: matchScore(fixture),
    xg: extractXg(fixture),
    startingAt: fixture.starting_at || null,
    stateId: fixture.state_id ?? fixture.state?.id ?? null,
    events: Array.isArray(fixture.events) ? fixture.events.map(e => ({
      minute: e.minute,
      extraMinute: e.extra_minute,
      type: text(e.type?.name || e.type?.code),
      player: text(e.player_name),
      result: text(e.result)
    })) : []
  };
}

async function sportmonksLatest() {
  if (!SPORTMONKS_TOKEN) {
    log("WARN", "sportmonks_token_missing", "SPORTMONKS_TOKEN is not configured; live provider layer is waiting for a token");
    return [];
  }

  const url = SPORTMONKS_URL +
    "/livescores/latest?include=scores;participants;events.type;state;periods";
  const data = await getJson(url, { headers: sportmonksHeaders() });
  return Array.isArray(data?.data) ? data.data : [];
}

async function sportmonksFixture(fixtureId) {
  const url = SPORTMONKS_URL +
    "/fixtures/" + encodeURIComponent(fixtureId) +
    "?include=scores;state;participants;events.type;periods;xGFixture;statistics.type";
  const data = await getJson(url, { headers: sportmonksHeaders() });
  return data?.data || null;
}

function teamSimilarity(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const ax = new Set(x.split(" "));
  const by = new Set(y.split(" "));
  const overlap = [...ax].filter(v => by.has(v)).length;
  return overlap / Math.max(ax.size, by.size);
}

function resolveFixture(match, fixtures) {
  let best = null;
  let bestScore = 0;

  for (const fixture of fixtures) {
    const teams = fixtureTeams(fixture);
    const direct =
      teamSimilarity(match.homeTeam, teams.home) +
      teamSimilarity(match.awayTeam, teams.away);
    const swapped =
      teamSimilarity(match.homeTeam, teams.away) +
      teamSimilarity(match.awayTeam, teams.home);

    const score = Math.max(direct, swapped);
    if (score > bestScore) {
      bestScore = score;
      best = fixture;
    }
  }

  if (!best || bestScore < 1.4) return null;
  return { fixture: best, score: bestScore };
}

async function enrichLiveMatches(polymarketMatches) {
  const fixtures = await sportmonksLatest();

  for (const match of polymarketMatches) {
    const key = match.eventId || match.slug;
    const resolvedExisting = resolved.get(key);

    let resolvedMatch = resolvedExisting;
    if (!resolvedMatch) {
      resolvedMatch = resolveFixture(match, fixtures);
      if (resolvedMatch) {
        resolved.set(key, {
          fixtureId: String(resolvedMatch.fixture.id),
          confidence: resolvedMatch.score
        });
        log("INFO", "match_resolved", "Polymarket match linked to SportMonks fixture", {
          eventId: match.eventId,
          url: match.url,
          polymarketTeams: [match.homeTeam, match.awayTeam],
          fixtureId: String(resolvedMatch.fixture.id),
          sportmonksName: resolvedMatch.fixture.name,
          confidence: resolvedMatch.score
        });
      }
    }

    if (!resolvedMatch) {
      match.live = { status: "unresolved" };
      continue;
    }

    const fixture = await sportmonksFixture(resolvedMatch.fixtureId).catch(err => {
      log("WARN", "fixture_failed", "SportMonks fixture refresh failed", {
        fixtureId: resolvedMatch.fixtureId,
        message: err.message
      });
      return null;
    });

    if (fixture) {
      match.provider = "sportmonks";
      match.providerFixtureId = resolvedMatch.fixtureId;
      match.live = normalizeFixture(fixture);
    } else {
      match.live = { status: "provider_error" };
    }
  }
}

async function tick() {
  if (stopping) return;

  try {
    const matches = await discoverPolymarket();
    await enrichLiveMatches(matches);

    log("INFO", "live_snapshot", "Polymarket football matches with live provider data", {
      count: matches.length,
      matches
    });
  } catch (err) {
    log("ERROR", "discovery_failed", "Football monitoring failed; monitoring continues", {
      message: err.message
    });
  }
}

function stop() {
  if (stopping) return;
  stopping = true;
  if (timer) clearInterval(timer);
  log("INFO", "monitor_stopped", "Polymarket live football monitor stopped");
}

async function start() {
  log("INFO", "monitor_started", "Polymarket football live monitor started", {
    pollSec: POLL_MS / 1000,
    runHours: RUN_MS / 3_600_000,
    provider: "sportmonks",
    providerConfigured: Boolean(SPORTMONKS_TOKEN)
  });

  await tick();
  timer = setInterval(() => { tick(); }, POLL_MS);
  setTimeout(stop, RUN_MS);
}

process.on("SIGTERM", () => { stop(); process.exit(0); });
start();
