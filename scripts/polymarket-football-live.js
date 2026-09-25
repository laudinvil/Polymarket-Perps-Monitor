const GAMMA_URL = "https://gamma-api.polymarket.com";
const SPORTMONKS_URL = "https://api.sportmonks.com/v3/football";
const SPORTMONKS_TOKEN = process.env.SPORTMONKS_TOKEN || "";

const POLL_MS = 15_000;
const RUN_MS = 6 * 60 * 60 * 1000;
const HISTORY_MS = 20 * 60 * 1000;

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
  return { Authorization: "Bearer " + SPORTMONKS_TOKEN };
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

function matchScore(fixture) {
  const scores = Array.isArray(fixture?.scores) ? fixture.scores : [];
  const current = scores.filter(s => s.description === "CURRENT" || s.type?.code === "current");
  const list = current.length ? current : scores;
  const parts = participants(fixture);
  const homeId = parts.find(p => p.meta?.location === "home")?.id;
  const awayId = parts.find(p => p.meta?.location === "away")?.id;
  const home = list.find(s => s.participant_id === homeId);
  const away = list.find(s => s.participant_id === awayId);
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

function statisticRows(fixture) {
  return Array.isArray(fixture?.statistics) ? fixture.statistics : [];
}

function statValue(row) {
  const value = row?.data?.value ?? row?.value;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function extractStats(fixture) {
  const parts = participants(fixture);
  const homeId = parts.find(p => p.meta?.location === "home")?.id;
  const awayId = parts.find(p => p.meta?.location === "away")?.id;
  const result = {
    home: { shots: NaN, shotsOnTarget: NaN },
    away: { shots: NaN, shotsOnTarget: NaN }
  };

  for (const row of statisticRows(fixture)) {
    const name = text(row?.type?.name || row?.type?.code).toLowerCase();
    const value = statValue(row);
    const participantId = row?.participant_id ?? row?.participant?.id;
    const side = participantId === homeId ? "home" : participantId === awayId ? "away" : null;
    if (!side || !Number.isFinite(value)) continue;

    if (/shots on target|shot on target/.test(name)) result[side].shotsOnTarget = value;
    else if (/shots|total shots/.test(name)) result[side].shots = value;
  }

  return result;
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
    stats: extractStats(fixture),
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

function snapshotAtOrBefore(rows, cutoff) {
  let best = null;
  for (const row of rows) {
    if (row.timestamp <= cutoff) best = row;
    else break;
  }
  return best;
}

function delta(current, previous) {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return NaN;
  return Math.max(0, current - previous);
}

function calculateFeatures(match, snapshot) {
  const key = match.eventId || match.slug;
  const rows = history.get(key) || [];
  const now = Date.now();

  const five = snapshotAtOrBefore(rows, now - 5 * 60 * 1000);
  const ten = snapshotAtOrBefore(rows, now - 10 * 60 * 1000);

  const xg5Home = five ? delta(snapshot.xg.home, five.xg.home) : NaN;
  const xg5Away = five ? delta(snapshot.xg.away, five.xg.away) : NaN;
  const xg10Home = ten ? delta(snapshot.xg.home, ten.xg.home) : NaN;
  const xg10Away = ten ? delta(snapshot.xg.away, ten.xg.away) : NaN;

  const shots10Home = ten ? delta(snapshot.stats.home.shots, ten.stats.home.shots) : NaN;
  const shots10Away = ten ? delta(snapshot.stats.away.shots, ten.stats.away.shots) : NaN;
  const sot10Home = ten ? delta(snapshot.stats.home.shotsOnTarget, ten.stats.home.shotsOnTarget) : NaN;
  const sot10Away = ten ? delta(snapshot.stats.away.shotsOnTarget, ten.stats.away.shotsOnTarget) : NaN;

  const elapsed = Math.max(1, Number(snapshot.minute) || 1);
  const expected10Home = Number.isFinite(snapshot.xg.home) ? snapshot.xg.home * 10 / elapsed : NaN;
  const expected10Away = Number.isFinite(snapshot.xg.away) ? snapshot.xg.away * 10 / elapsed : NaN;

  return {
    xg5m: { home: xg5Home, away: xg5Away },
    xg10m: { home: xg10Home, away: xg10Away },
    shots10m: { home: shots10Home, away: shots10Away },
    shotsOnTarget10m: { home: sot10Home, away: sot10Away },
    momentum10m: {
      home: Number.isFinite(xg10Home) && Number.isFinite(expected10Home) ? xg10Home - expected10Home : NaN,
      away: Number.isFinite(xg10Away) && Number.isFinite(expected10Away) ? xg10Away - expected10Away : NaN
    },
    historyPoints: rows.length
  };
}


function goalProbabilities(snapshot, features) {
  const minute = Math.max(1, Number(snapshot.minute) || 1);
  const remaining = Math.max(0, 90 - minute);
  if (!remaining) return { home: 0, away: 0, none: 1 };

  const baseHomeRate = Number.isFinite(snapshot.xg.home) ? snapshot.xg.home / minute : NaN;
  const baseAwayRate = Number.isFinite(snapshot.xg.away) ? snapshot.xg.away / minute : NaN;
  const recentHome = Number.isFinite(features?.xg10m?.home) ? features.xg10m.home / 10 : NaN;
  const recentAway = Number.isFinite(features?.xg10m?.away) ? features.xg10m.away / 10 : NaN;

  const homeRate = Number.isFinite(recentHome) && Number.isFinite(baseHomeRate) ? 0.6 * recentHome + 0.4 * baseHomeRate : baseHomeRate;
  const awayRate = Number.isFinite(recentAway) && Number.isFinite(baseAwayRate) ? 0.6 * recentAway + 0.4 * baseAwayRate : baseAwayRate;

  if (!Number.isFinite(homeRate) || !Number.isFinite(awayRate)) return { home: NaN, away: NaN, none: NaN };

  const h = Math.max(0, homeRate * remaining);
  const a = Math.max(0, awayRate * remaining);
  const total = h + a;
  const none = Math.exp(-total);
  const scored = 1 - none;
  if (total <= 0) return { home: 0, away: 0, none: 1 };

  return { home: scored * h / total, away: scored * a / total, none };
}

function outcomeName(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function marketPrices(match, probabilities) {
  const rows = [];
  const homeName = norm(match.homeTeam);
  const awayName = norm(match.awayTeam);

  for (const market of match.markets || []) {
    const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
    const prices = Array.isArray(market.outcomePrices) ? market.outcomePrices : [];

    for (let i = 0; i < Math.min(outcomes.length, prices.length); i++) {
      const outcome = text(outcomes[i]);
      const name = outcomeName(outcome);
      const price = Number(prices[i]);
      if (!Number.isFinite(price)) continue;

      let model = NaN;
      let modelSide = "unmapped";

      if (/home|1st|first/.test(name) || (homeName && norm(outcome) === homeName)) {
        model = probabilities.home;
        modelSide = "home";
      } else if (/away|2nd|second/.test(name) || (awayName && norm(outcome) === awayName)) {
        model = probabilities.away;
        modelSide = "away";
      } else if (/no goal|none/.test(name)) {
        model = probabilities.none;
        modelSide = "none";
      }

      rows.push({
        marketId: market.marketId,
        question: market.question,
        outcome,
        price,
        modelProbability: model,
        modelSide,
        edge: Number.isFinite(model) ? model - price : NaN
      });
    }
  }

  return rows;
}

function calculateModel(match, snapshot, features) {
  const probabilities = goalProbabilities(snapshot, features);
  const prices = marketPrices(match, probabilities);
  return { probabilities, prices };
}

function recordHistory(match, snapshot) {
  const key = match.eventId || match.slug;
  if (!key) return null;

  const rows = history.get(key) || [];
  const timestamp = Date.now();
  const row = {
    timestamp,
    minute: snapshot.minute,
    score: snapshot.score,
    xg: snapshot.xg,
    stats: snapshot.stats
  };

  rows.push(row);
  const cutoff = timestamp - HISTORY_MS;
  const kept = rows.filter(item => item.timestamp >= cutoff);
  history.set(key, kept);
  return calculateFeatures(match, snapshot);
}

async function sportmonksLatest() {
  if (!SPORTMONKS_TOKEN) {
    log("WARN", "sportmonks_token_missing", "SPORTMONKS_TOKEN is not configured; live provider layer is waiting for a token");
    return [];
  }

  const url = SPORTMONKS_URL + "/livescores/latest?include=scores;participants;events.type;state;periods";
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
      match.features = recordHistory(match, match.live);
      match.model = calculateModel(match, match.live, match.features);
    } else {
      match.live = { status: "provider_error" };
    }
  }
}


function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
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

  if (!response.ok) {
    throw new Error("Telegram HTTP " + response.status);
  }
  const body = await response.json();
  if (!body.ok) throw new Error("Telegram API rejected message");
  return true;
}

const alerted = new Map();

function bestEdge(match) {
  const prices = match.model?.prices || [];
  return prices
    .filter(row => Number.isFinite(row.edge) && Number.isFinite(row.modelProbability) && Number.isFinite(row.price))
    .sort((a, b) => b.edge - a.edge)[0] || null;
}

async function maybeAlert(match) {
  const best = bestEdge(match);
  if (!match.url) return;

  const bucket = Math.floor(Date.now() / ALERT_BUCKET_MS);
  const key = String(match.eventId || match.url);
  const diagnosticKey = key + ":diagnostic:" + bucket;

  if (!best || best.edge <= 0) {
    if (alerted.get(key) === diagnosticKey) return;

    const message = [
      "⚽ FOOTBALL · LIVE DIAGNOSTIC",
      "",
      "MATCH: " + (match.homeTeam || "?") + " vs " + (match.awayTeam || "?"),
      "SCORE: " + (match.live?.score || "?"),
      "MINUTE: " + (match.live?.minute ?? "?"),
      "",
      "EDGE: NO POSITIVE EDGE",
      "",
      "➡️ POLYMARKET",
      match.url
    ].join("\n");

    await sendTelegram(message);
    alerted.set(key, diagnosticKey);
    log("INFO", "telegram_diagnostic_sent", "Football diagnostic Telegram alert sent", {
      eventId: match.eventId,
      bestEdge: best?.edge ?? null
    });
    return;
  }

  const key = match.eventId || match.slug;
  const bucket = Math.floor(Date.now() / 60_000);
  const alertKey = key + ":" + best.outcome + ":" + bucket;
  if (alerted.get(key) === alertKey) return;

  const p = match.model.probabilities;
  const message = [
    "⚽ POLYMARKET · LIVE",
    "",
    match.homeTeam + " vs " + match.awayTeam,
    "SCORE: " + match.live.score.home + "–" + match.live.score.away,
    "TIME: " + match.live.minute + "'",
    "",
    "SIGNAL: " + best.outcome,
    "MODEL: " + (best.modelProbability * 100).toFixed(1) + "%",
    "POLYMARKET: " + (best.price * 100).toFixed(1) + "%",
    "EDGE: +" + (best.edge * 100).toFixed(1) + "%",
    "",
    "➡️ OPEN MATCH",
    match.url
  ].join("\n");

  await sendTelegram(message);
  alerted.set(key, alertKey);
  log("INFO", "telegram_alert_sent", "Positive-edge Polymarket football alert sent", {
    eventId: match.eventId,
    url: match.url,
    outcome: best.outcome,
    edge: best.edge
  });
}

async function tick() {
  if (stopping) return;

  try {
    const matches = await discoverPolymarket();
    log("INFO", "polymarket_discovery", "Polymarket football discovery completed", {
      count: matches.length,
      matches: matches.map(m => ({
        eventId: m.eventId,
        title: m.title,
        teams: [m.homeTeam, m.awayTeam],
        url: m.url,
        marketCount: m.markets.length
      }))
    });

    await enrichLiveMatches(matches);
    for (const match of matches) {
      if (match.live?.status === "unresolved") {
        log("INFO", "match_unresolved", "Live Polymarket match has no SportMonks fixture match", {
          eventId: match.eventId,
          teams: [match.homeTeam, match.awayTeam]
        });
        continue;
      }

      if (match.live?.status === "provider_error") continue;

      const prices = match.model?.prices || [];
      const mapped = prices.filter(p => Number.isFinite(p.modelProbability));
      const best = bestEdge(match);

      log("INFO", "edge_evaluation", "Football edge evaluated", {
        eventId: match.eventId,
        teams: [match.homeTeam, match.awayTeam],
        score: match.live.score,
        minute: match.live.minute,
        mappedOutcomes: mapped.map(p => ({
          outcome: p.outcome,
          side: p.modelSide,
          polymarket: p.price,
          model: p.modelProbability,
          edge: p.edge
        })),
        bestEdge: best?.edge ?? null,
        bestOutcome: best?.outcome ?? null
      });

      await maybeAlert(match);
    }

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
    providerConfigured: Boolean(SPORTMONKS_TOKEN),
    historyMinutes: HISTORY_MS / 60_000
  });

  await tick();
  timer = setInterval(() => { tick(); }, POLL_MS);
  setTimeout(stop, RUN_MS);
}

process.on("SIGTERM", () => { stop(); process.exit(0); });
start();
