import http from "node:http";
const CFG = {
  pollMs: 10000,
  gammaMs: 60000,
  requestTimeoutMs: 7000,
  telegramMinMs: 1000,
  cooldownMs: 20 * 60 * 1000,
  port: Number(process.env.PORT || 3000),
  sofaUrl: "https://www.sofascore.com/api/v1/sport/tennis/events/live",
  gammaUrl: "https://gamma-api.polymarket.com/events?tag_id=864&active=true&closed=false&limit=500&order=endDate&ascending=true",
};

const state = {
  startedAt: new Date().toISOString(),
  lastPollAt: null,
  lastGammaAt: null,
  liveMatches: 0,
  matchedMarkets: 0,
  signals: 0,
  alertsSent: 0,
  telegramErrors: 0,
  sourceErrors: 0,
  sofa429: 0,
  gamma429: 0,
  breaksDetected: 0,
  twoBreakCandidates: 0,
  marketMisses: 0,
  marketMatches: 0,
  cooldownBlocked: 0,
  lastError: null,
};

const matches = new Map();
const markets = new Map();
const alerted = new Map();
let lastSofaRequest = 0;
let lastGammaRequest = 0;
let lastTelegramRequest = 0;

function log(type, data = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), type, ...data }));
}

async function getJson(url, kind = "generic") {
  const minGap = kind === "sofa" ? CFG.pollMs : kind === "gamma" ? CFG.gammaMs : 1000;
  const now = Date.now();
  const last = kind === "sofa" ? lastSofaRequest : kind === "gamma" ? lastGammaRequest : 0;
  if (now - last < minGap) await new Promise(r => setTimeout(r, minGap - (now - last)));
  if (kind === "sofa") lastSofaRequest = Date.now();
  if (kind === "gamma") lastGammaRequest = Date.now();
  const r = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 TennisDoubleBreakMonitor/1.0",
    },
    signal: AbortSignal.timeout(CFG.requestTimeoutMs),
  });
  if (!r.ok) {
    if (r.status === 429) {
      if (kind === "sofa") state.sofa429++;
      if (kind === "gamma") state.gamma429++;
      const retrySec = Number(r.headers.get("retry-after") || 15);
      await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(retrySec, 5), 120) * 1000));
    }
    throw new Error(`${r.status} ${url}`);
  }
  return r.json();
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function nameKey(s) {
  const n = norm(s);
  const parts = n.split(/\\s+/).filter(Boolean);
  if (!parts.length) return "";
  // Tennis feeds commonly use "First Last", "Last, First", or initials.
  const compact = parts.join("");
  const last = parts[parts.length - 1];
  const first = parts[0];
  return { n, parts, compact, first, last };
}

function playerNameMatch(a, b) {
  const x = nameKey(a);
  const y = nameKey(b);
  if (!x || !y || !x.n || !y.n) return false;
  if (x.n === y.n || x.compact === y.compact) return true;
  if (x.last === y.last && (x.first === y.first || x.first[0] === y.first[0])) return true;
  return false;
}

function marketPlayerNames(m) {
  const outcomes = parseJsonField(m.outcomes);
  const names = outcomes.filter(x => typeof x === "string" && !/^(yes|no)$/i.test(x));
  if (names.length >= 2) return names.slice(0, 2);
  return [];
}


function matchMarket(m, e) {
  const home = e.homeTeam?.name;
  const away = e.awayTeam?.name;
  if (!home || !away) return false;

  // Primary key: Polymarket's two outcome names. For match-winner markets
  // these are the actual player names, so do not rely on URL wording alone.
  const outcomes = marketPlayerNames(m);
  if (outcomes.length >= 2) {
    const direct =
      (playerNameMatch(home, outcomes[0]) && playerNameMatch(away, outcomes[1])) ||
      (playerNameMatch(home, outcomes[1]) && playerNameMatch(away, outcomes[0]));
    if (direct) return true;
  }

  return false;
}

function marketUrl(m) {
  return m.eventSlug
    ? `https://polymarket.com/event/${m.eventSlug}`
    : "https://polymarket.com/tennis";
}

function parseJsonField(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try { return JSON.parse(v); } catch { return []; }
}


function scoreSets(e) {
  const hs = e.homeScore || {};
  const as = e.awayScore || {};
  const out = [];
  for (let i = 1; i <= 5; i++) {
    const h = Number(hs[`period${i}`]);
    const a = Number(as[`period${i}`]);
    if (Number.isFinite(h) && Number.isFinite(a)) out.push([h, a]);
  }
  return out;
}

function totalGames(sets) {
  return sets.reduce((n, [h,a]) => n + h + a, 0);
}

function currentGameScore(sets) {
  return sets.length ? sets[sets.length - 1] : [0,0];
}

function processBreaks(e, nowSets) {
  const id = String(e.id);
  const prev = matches.get(id);
  const first = Number(e.firstToServe || e.firstToServeCode || 0);
  if (!prev) {
    matches.set(id, { sets: nowSets, firstToServe: first, breakSeq: [], home: e.homeTeam?.name, away: e.awayTeam?.name, slug: e.slug });
    return [];
  }

  const oldSets = prev.sets;
  const oldTotal = totalGames(oldSets);
  const newTotal = totalGames(nowSets);
  if (newTotal <= oldTotal) {
    prev.sets = nowSets;
    if (first) prev.firstToServe = first;
    return [];
  }

  // A single poll should normally advance by one completed game.
  // If several games appeared between polls, the intermediate winners are
  // unknowable from the cumulative set score, so do not fabricate breaks.
  if (newTotal - oldTotal > 1) {
    log("GAME_GAP", { eventId: id, gamesSkipped: newTotal - oldTotal });
    prev.sets = nowSets;
    if (first) prev.firstToServe = first;
    return [];
  }

  const breaks = [];
  let gameNo = oldTotal;
  const count = Math.min(newTotal - oldTotal, 8);

  // 6-6 -> 7-6 / 6-7 is a completed tiebreak, not a normal service game.
  // Never classify the tiebreak winner as a service break.
  const oldLast = oldSets[oldSets.length - 1] || [0, 0];
  const newLast = nowSets[nowSets.length - 1] || oldLast;
  const tiebreakSet =
    oldLast[0] === 6 && oldLast[1] === 6 &&
    ((newLast[0] === 7 && newLast[1] === 6) || (newLast[0] === 6 && newLast[1] === 7));
  if (tiebreakSet) {
    log("TIEBREAK_COMPLETED", { eventId: id, score: newLast });
    prev.sets = nowSets;
    prev.firstToServe = first || prev.firstToServe || 1;
    return [];
  }
  for (let k = 0; k < count; k++) {
    const server = ((gameNo + ((first || prev.firstToServe || 1) - 1)) % 2) + 1;
    const before = gameNo;
    gameNo++;
    const winner = inferWinnerForGame(oldSets, nowSets, before, gameNo);
    if (!winner) continue;
    if (winner !== server) {
      const broken = server === 1 ? 0 : 1;
      breaks.push(broken);
    }
  }

  prev.sets = nowSets;
  prev.firstToServe = first || prev.firstToServe || 1;
  if (breaks.length) {
    state.breaksDetected += breaks.length;
    log("BREAKS_DETECTED", { eventId: id, sides: breaks, totalGames: newTotal });
  }
  return breaks;
}

function inferWinnerForGame(oldSets, newSets, beforeTotal, afterTotal) {
  const beforeBySet = oldSets.map(x => [...x]);
  const afterBySet = newSets.map(x => [...x]);
  let b = beforeTotal;
  let a = afterTotal;
  for (let i = 0; i < Math.max(beforeBySet.length, afterBySet.length); i++) {
    const bs = beforeBySet[i] || [0,0];
    const as = afterBySet[i] || bs;
    const diff = (as[0] + as[1]) - (bs[0] + bs[1]);
    if (diff <= 0) continue;
    if (a <= beforeTotal) break;
    const steps = Math.min(diff, a - b);
    if (steps <= 0) continue;
    const hChanged = as[0] - bs[0];
    const awChanged = as[1] - bs[1];
    if (hChanged > 0 && awChanged === 0) return 1;
    if (awChanged > 0 && hChanged === 0) return 2;
    b += steps;
  }
  return null;
}

function recordSignal(e, brokenSide) {
  const id = String(e.id);
  const prev = matches.get(id);
  if (!prev) return null;
  const seq = prev.breakSeq || [];
  seq.push({ side: brokenSide, ts: Date.now() });
  while (seq.length > 4) seq.shift();
  prev.breakSeq = seq;
  if (seq.length < 2) return null;
  const a = seq[seq.length - 2], b = seq[seq.length - 1];
  if (a.side !== b.side) return null;
  if (b.ts - a.ts > 30 * 60 * 1000) return null;
  return a.side;
}

async function refreshMarkets() {
  const data = await getJson(CFG.gammaUrl, "gamma");
  const events = Array.isArray(data) ? data : (data.data || data.events || []);
  markets.clear();
  for (const event of events) {
    if (!event || event.closed === true || event.active === false) continue;
    for (const m of Array.isArray(event.markets) ? event.markets : []) {
      if (!m || m.closed === true || m.active === false) continue;
      markets.set(String(m.id), { ...m, eventSlug: event.slug });
    }
  }
  state.matchedMarkets = markets.size;
  state.lastGammaAt = new Date().toISOString();
}

function findMarketForPlayer(e, playerName) {
  for (const m of markets.values()) {
    if (!matchMarket(m, e)) continue;
    if (!marketPlayerNames(m).some(name => playerNameMatch(playerName, name))) continue;
    state.marketMatches++;
    log("MARKET_MATCH", {
      eventId: e.id,
      player: playerName,
      marketId: m.id,
      eventSlug: m.eventSlug || null,
      outcomes: marketPlayerNames(m)
    });
    return m;
  }
  return null;
}




