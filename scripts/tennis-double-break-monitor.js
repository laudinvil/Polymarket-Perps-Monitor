import http from "node:http";
const CFG = {
  pollMs: 5000,
  gammaMs: 30000,
  requestTimeoutMs: 5000,
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
  const names = outcomes
    .filter(x => typeof x === "string" && !/^(yes|no)$/i.test(x))
    .map(x => String(x).trim())
    .filter(Boolean);
  if (names.length >= 2) return names.slice(0, 2);

  // Some Gamma records expose the player labels through outcomePrices/token
  // metadata only after normalization; never treat YES/NO as player names.
  const question = String(m.question || m.title || "");
  const vs = question.split(/\s+vs\.?\s+|\s+versus\s+/i).map(x => x.trim()).filter(Boolean);
  if (vs.length === 2) return vs;

  return [];
}

function namesFromMarket(m) {
  const q = String(m.question || "");
  const title = String(m.title || "");
  const slug = String(m.slug || m.eventSlug || "");
  const outcomes = marketPlayerNames(m);
  return { q, title, slug, outcomes, text: norm(q + " " + title + " " + slug + " " + outcomes.join(" ")) };
}

function isMatchWinnerMarket(m) {
  // Classify primarily from the market question/title. Descriptions and rules
  // often contain generic words such as "over" or "under" that can incorrectly
  // disqualify an otherwise valid match-winner contract.
  const primary = norm([m.question, m.title].filter(Boolean).join(" "));
  if (!primary) return false;

  if (/first set|second set|set [1-5]|total games|total sets|over|under|handicap|spread|exact score|correct score|wins by|game handicap|games handicap|set winner|win set/.test(primary)) {
    return false;
  }

  // A tennis main-market question can be phrased as "Will X win?" without
  // explicitly containing "match winner". If it has exactly the two match
  // players as outcomes, accept it unless it is clearly a set/prop market.
  if (/advances against|advance against|win the match|match winner|winner of the match|who will win/.test(primary)) return true;
  const names = marketPlayerNames(m);
  return names.length === 2;
}

function matchMarket(m, e) {
  const home = e.homeTeam?.name;
  const away = e.awayTeam?.name;
  if (!home || !away || !isMatchWinnerMarket(m)) return false;

  const outcomes = marketPlayerNames(m);
  if (outcomes.length >= 2) {
    if (
      (playerNameMatch(home, outcomes[0]) && playerNameMatch(away, outcomes[1])) ||
      (playerNameMatch(home, outcomes[1]) && playerNameMatch(away, outcomes[0]))
    ) return true;
  }

  const text = norm([
    m.question,
    m.title,
    m.description,
    m.rules,
    m.slug,
    m.eventSlug
  ].filter(Boolean).join(" "));
  const hasPlayer = (name) => {
    const k = nameKey(name);
    return !!k && (
      text.includes(k.n) ||
      text.includes(k.compact) ||
      (text.includes(k.first) && text.includes(k.last))
    );
  };

  return hasPlayer(home) && hasPlayer(away);
}
function marketUrl(m) {
  const slug = m.eventSlug || m.slug;
  return slug ? `https://polymarket.com/event/${slug}` : "https://polymarket.com/tennis";
}

function parseJsonField(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try { return JSON.parse(v); } catch { return []; }
}

function yesToken(m, playerName) {
  const outcomes = parseJsonField(m.outcomes);
  const ids = parseJsonField(m.clobTokenIds);
  const prices = parseJsonField(m.outcomePrices);
  if (!ids.length) return null;
  let idx = outcomes.findIndex(x => String(x).toLowerCase() === playerName.toLowerCase());
  if (idx < 0) idx = 0;
  return { id: String(ids[idx]), initialPrice: Number(prices[idx] || 0), outcome: outcomes[idx] || playerName };
}

function marketLiquidity(m) {
  return Number(m.liquidityNum ?? m.liquidity ?? 0);
}

function firstServer(e) {
  const v = e.firstToServe ?? e.firstToServeCode;
  if (v === 1 || String(v).toLowerCase() === "home") return 1;
  if (v === 2 || String(v).toLowerCase() === "away") return 2;
  return 0;
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

async function getCompletedGameFromPointFeed(eventId, targetTotal = null) {
  const data = await getJson(
    `https://www.sofascore.com/api/v1/event/${eventId}/point-by-point`,
    "sofa"
  );

  const rawSets = Array.isArray(data?.pointByPoint)
    ? data.pointByPoint
    : Array.isArray(data?.sets)
      ? data.sets
      : Array.isArray(data?.points)
        ? data.points
        : Array.isArray(data)
          ? data
          : [];

  // SofaScore may return the game-level server/winner directly on each game.
  // Prefer those fields over inference from cumulative game scores.
  const directGameResult = (game) => {
    const serving = Number(game?.serving ?? game?.score?.serving ?? game?.server ?? game?.score?.server);
    const scoring = Number(game?.scoring ?? game?.score?.scoring ?? game?.winner ?? game?.score?.winner);
    return {
      serving: serving === 1 || serving === 2 ? serving : null,
      winner: scoring === 1 || scoring === 2 ? scoring : null
    };
  };

  const games = [];
  for (const set of rawSets) {
    const setNo = Number(set?.set ?? set?.period ?? set?.setNumber ?? 0);
    const rawGames = Array.isArray(set?.games) ? set.games : [];

    for (const game of rawGames) {
      const score = game?.score || game;
      const home = Number(score?.homeScore ?? game?.homeGames);
      const away = Number(score?.awayScore ?? game?.awayGames);
      const direct = directGameResult(game);
      const gameNo = Number(game?.game ?? game?.gameNumber ?? 0);

      if (!Number.isFinite(home) || !Number.isFinite(away)) continue;

      games.push({
        set: setNo,
        game: gameNo,
        home,
        away,
        serving: direct.serving,
        directWinner: direct.winner
      });
    }
  }

  if (!games.length) return null;

  games.sort((a, b) => a.set - b.set || a.game - b.game);

  // PBP game scores are cumulative within a SET, while targetTotal is
  // cumulative across the whole MATCH. Convert each PBP game to a global
  // completed-game number before matching it to the live score transition.
  const setTotals = new Map();
  for (const g of games) {
    const n = g.home + g.away;
    const prev = setTotals.get(g.set) || 0;
    if (n > prev) setTotals.set(g.set, n);
  }
  const setNumbers = [...setTotals.keys()].sort((a, b) => a - b);
  const offsets = new Map();
  let offset = 0;
  for (const setNo of setNumbers) {
    offsets.set(setNo, offset);
    offset += setTotals.get(setNo) || 0;
  }
  for (const g of games) {
    g.globalGameNo = (offsets.get(g.set) || 0) + g.home + g.away;
  }

  // The newest PBP entry can be an in-progress game, so match the exact
  // completed-game transition instead of blindly taking the last entry.
  let last = targetTotal == null
    ? games[games.length - 1]
    : games.find(g => g.globalGameNo === targetTotal);
  if (!last) return null;
  const lastIndex = games.indexOf(last);
  let previous = lastIndex > 0 ? games[lastIndex - 1] : null;

  let winner = last.directWinner || null;
  if (!winner && previous && previous.set === last.set) {
    const dh = last.home - previous.home;
    const da = last.away - previous.away;
    if (dh === 1 && da === 0) winner = 1;
    else if (da === 1 && dh === 0) winner = 2;
  } else if (!previous || previous.set !== last.set) {
    if (last.home === 1 && last.away === 0) winner = 1;
    else if (last.home === 0 && last.away === 1) winner = 2;
  }

  return { ...last, winner, globalGameNo: last.globalGameNo };
}

async function processBreaks(e, nowSets) {
  const id = String(e.id);
  const prev = matches.get(id);
  const first = firstServer(e);
  if (!prev) {
    matches.set(id, { sets: nowSets, firstToServe: first, breakSeq: [], home: e.homeTeam?.name, away: e.awayTeam?.name, slug: e.slug });
    return [];
  }

  const oldSets = prev.sets;
  const oldTotal = totalGames(oldSets);
  const newTotal = totalGames(nowSets);
  if (newTotal <= oldTotal) {
    log("NO_GAME_CHANGE", {
      eventId: id,
      oldTotal,
      newTotal,
      score: nowSets
    });
    prev.sets = nowSets;
    // Keep the match's initial server fixed; SofaScore may update firstToServe during live changes.
    return [];
  }

  // PBP gives us the exact completed games, so a poll may safely
  // contain more than one completed game. Process every transition that
  // can be matched to the live cumulative score.
  if (newTotal - oldTotal > 1) {
    log("GAME_GAP", { eventId: id, gamesSkipped: newTotal - oldTotal, action: "PROCESS_PBP" });
  }

  const breaks = [];
  let gameNo = oldTotal;
  log("GAME_PROGRESS", {
    eventId: id,
    oldTotal,
    newTotal,
    initialServer: prev.firstToServe === 1 ? "HOME" : prev.firstToServe === 2 ? "AWAY" : null,
    currentScore: nowSets
  });
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
    prev.firstToServe = prev.firstToServe || first || 0;
    return [];
  }
  for (let k = 0; k < count; k++) {
    const before = gameNo;
    gameNo++;

    // Use SofaScore point-by-point data for the completed game. It explicitly
    // identifies the server and the cumulative game score, eliminating the
    // fragile need to reconstruct serving order from firstToServe.
    let feedGame = null;
    try {
      feedGame = await getCompletedGameFromPointFeed(id, before + 1);
      if (feedGame) {
        log("PBP_GAME", {
          eventId: id,
          set: feedGame.set,
          game: feedGame.game,
          server: feedGame.serving === 1 ? "HOME" : feedGame.serving === 2 ? "AWAY" : null,
          winner: feedGame.winner === 1 ? "HOME" : feedGame.winner === 2 ? "AWAY" : null,
          score: [feedGame.home, feedGame.away]
        });
      } else {
        log("PBP_NO_COMPLETED_GAME", { eventId: id });
      }
    } catch (err) {
      state.sourceErrors++;
      log("PBP_ERROR", { eventId: id, error: String(err) });
    }

    let server = feedGame?.serving;
    let winner = feedGame?.winner;

    if (server !== 1 && server !== 2) {
      let initialServer = prev.firstToServe;
      if (initialServer !== 1 && initialServer !== 2) {
        initialServer = 1;
        prev.firstToServe = 1;
        log("SERVER_FALLBACK", { eventId: id, totalGames: before, assumed: "HOME" });
      }
      server = ((before + (initialServer - 1)) % 2) + 1;
    }

    if (winner !== 1 && winner !== 2) {
      winner = inferWinnerForGame(oldSets, nowSets, before, gameNo);
      if (winner === 1 || winner === 2) {
        log("WINNER_FALLBACK", { eventId: id, game: gameNo, winner: winner === 1 ? "HOME" : "AWAY" });
      } else {
        log("WINNER_UNKNOWN", { eventId: id, game: gameNo });
      }
    }
    log("GAME_CHANGE", {
      eventId: id,
      beforeTotal: before,
      afterTotal: gameNo,
      server: server === 1 ? "HOME" : "AWAY",
      winner: winner === 1 ? "HOME" : winner === 2 ? "AWAY" : null,
      scoreBefore: oldSets,
      scoreAfter: nowSets
    });
    if (!winner) {
      log("GAME_RESULT_UNKNOWN", { eventId: id, gameNo });
      continue;
    }
    const isBreak = winner !== server;
    log("GAME_CLASSIFIED", {
      eventId: id,
      gameNo,
      server: server === 1 ? "HOME" : "AWAY",
      winner: winner === 1 ? "HOME" : "AWAY",
      result: isBreak ? "BREAK" : "HOLD"
    });
    if (isBreak) {
      const broken = server === 1 ? 0 : 1;
      breaks.push({ side: broken, gameNo });
    }
  }

  prev.sets = nowSets;
  // Keep the first observed server stable. Live SofaScore updates can change
  // firstToServe to the currently serving player; that must not rewrite the
  // match's initial service order used by the fallback classifier.
  if (prev.firstToServe !== 1 && prev.firstToServe !== 2) {
    prev.firstToServe = first || 0;
  }
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

function recordSignal(e, breakInfo) {
  const id = String(e.id);
  const prev = matches.get(id);
  if (!prev) return null;

  const brokenSide = breakInfo?.side;
  const gameNo = Number(breakInfo?.gameNo);
  if (brokenSide !== 0 && brokenSide !== 1) return null;

  const seq = prev.breakSeq || [];
  seq.push({ side: brokenSide, gameNo: Number.isFinite(gameNo) ? gameNo : null, ts: Date.now() });
  while (seq.length > 8) seq.shift();
  prev.breakSeq = seq;

  if (seq.length < 2) {
    log("BREAK_SEQUENCE", { eventId: id, count: seq.length, result: "WAITING_FOR_SECOND_BREAK" });
    return null;
  }

  const current = seq[seq.length - 1];
  const prior = [...seq].reverse().slice(1).find(x => x.side === brokenSide);
  if (!prior) {
    log("BREAK_SEQUENCE", { eventId: id, playerSide: brokenSide, result: "WAITING_FOR_SAME_PLAYER" });
    return null;
  }

  // A player's service games are separated by exactly one opponent service game.
  // Therefore two breaks of the same player's serve are consecutive for that
  // player only when their game numbers differ by 2.
  if (current.gameNo != null && prior.gameNo != null && current.gameNo - prior.gameNo !== 2) {
    log("BREAK_SEQUENCE", {
      eventId: id,
      firstGame: prior.gameNo,
      secondGame: current.gameNo,
      playerSide: brokenSide,
      result: "NOT_CONSECUTIVE_SERVICE_GAMES"
    });
    return null;
  }

  if (current.ts - prior.ts > 30 * 60 * 1000) {
    log("BREAK_SEQUENCE", { eventId: id, first: prior.side, second: current.side, result: "TOO_OLD" });
    return null;
  }

  log("BREAK_SEQUENCE", {
    eventId: id,
    playerSide: brokenSide,
    firstGame: prior.gameNo,
    secondGame: current.gameNo,
    result: "TWO_CONSECUTIVE_SERVICE_BREAKS"
  });
  return brokenSide;
}

async function refreshMarkets() {
  const data = await getJson(CFG.gammaUrl, "gamma");
  const events = Array.isArray(data) ? data : (data.data || data.events || []);
  let eventsWithMarkets = 0;
  let activeMarkets = 0;
  markets.clear();
  for (const event of events) {
    if (!event || event.closed === true || event.active === false) continue;
    const eventMarkets = Array.isArray(event.markets)
      ? event.markets
      : parseJsonField(event.markets);
    if (eventMarkets.length) eventsWithMarkets++;
    for (const m of eventMarkets) {
      if (!m || m.closed === true || m.active === false) continue;
      activeMarkets++;
      markets.set(String(m.id), { ...m, eventSlug: event.slug });
    }
  }
  state.matchedMarkets = markets.size;
  state.lastGammaAt = new Date().toISOString();
  log("MARKETS_REFRESHED", {
    eventsLoaded: events.length,
    eventsWithMarkets,
    activeMarkets,
    marketsLoaded: markets.size,
    tennisWinnerMarkets: Array.from(markets.values()).filter(isMatchWinnerMarket).length
  });
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
      question: m.question || m.title || null,
      eventSlug: m.eventSlug || null,
      outcomes: marketPlayerNames(m)
    });
    return m;
  }
  return null;
}

function handleBook(msg) {
  if (!msg?.asset_id) return;
  const bids = Array.isArray(msg.bids) ? msg.bids : [];
  const asks = Array.isArray(msg.asks) ? msg.asks : [];
  const bestAsk = asks.map(x => Number(x.price)).filter(Number.isFinite).sort((a,b)=>a-b)[0];
  if (!Number.isFinite(bestAsk)) return;
  let depth = 0;
  for (const x of asks) {
    const p = Number(x.price), s = Number(x.size);
    if (Number.isFinite(p) && Number.isFinite(s) && p <= bestAsk + 0.05) depth += p * s;
  }
  prices.set(String(msg.asset_id), { ask: bestAsk, depth, ts: Date.now() });
  state.wsBestAsks++;
}

function handlePriceChange(msg) {
  for (const x of msg.price_changes || []) {
    const id = String(x.asset_id || "");
    const p = Number(x.best_ask ?? x.price);
    if (!id || !Number.isFinite(p)) continue;
    const old = prices.get(id) || {};
    prices.set(id, { ...old, ask: p, ts: Date.now() });
  }
}

function connectWs() {
  try {
    ws = new WebSocket(CFG.wsUrl);
    ws.onopen = () => {
      state.wsConnected = true;
      log("POLY_WS_OPEN");
      const ids = [];
      for (const m of markets.values()) {
        const h = markets.get(String(m.id));
        const clob = parseJsonField(h.clobTokenIds);
        for (const x of clob) ids.push(String(x));
      }
      if (ids.length) ws.send(JSON.stringify({ type: "market", assets_ids: [...new Set(ids)].slice(0, 200), custom_feature_enabled: true }));
      clearInterval(wsTimer);
      wsTimer = setInterval(() => { try { ws.send("PING"); } catch {} }, 10000);
    };
    ws.onmessage = ev => {
      state.wsMessages++;
      if (ev.data === "PONG") return;
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.event_type === "book") handleBook(msg);
        else if (msg.event_type === "price_change") handlePriceChange(msg);
      } catch {}
    };
    ws.onerror = err => {
      state.lastError = "polymarket_ws_error";
      log("POLY_WS_ERROR");
    };
    ws.onclose = () => {
      state.wsConnected = false;
      clearInterval(wsTimer);
      setTimeout(connectWs, 3000);
    };
  } catch {
    state.wsConnected = false;
    setTimeout(connectWs, 5000);
  }
}

async function telegram(text, url) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID missing");
  const wait = CFG.telegramMinMs - (Date.now() - lastTelegramRequest);
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastTelegramRequest = Date.now();
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text: text + `\n\n<a href="${url}">ОТКРЫТЬ POLYMARKET</a>`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(CFG.requestTimeoutMs),
  });
  if (!r.ok) {
    if (r.status === 429) {
      let retrySec = 5;
      try {
        const body = await r.json();
        retrySec = Number(body?.parameters?.retry_after || retrySec);
      } catch {}
      await new Promise(resolve => setTimeout(resolve, Math.min(Math.max(retrySec, 1), 120) * 1000));
    }
    throw new Error(`telegram ${r.status}`);
  }
}

async function sendTestAlert() {
  const text =
`🎾 TEST ALERT

TENNIS MONITOR ONLINE

Two-consecutive-service-break strategy
TEST MODE — ONE MESSAGE

If you received this message, Telegram delivery is working.`;
  const sent = await telegram(text, "https://polymarket.com/tennis");
  log("TEST_ALERT_SENT", { sent: sent !== false });
}

async function evaluate(e, brokenSide) {
  log("EVALUATE_START", {
    eventId: e.id,
    brokenSide,
    player: brokenSide === 0 ? e.homeTeam?.name || null : e.awayTeam?.name || null,
    home: e.homeTeam?.name || null,
    away: e.awayTeam?.name || null
  });
  const player = brokenSide === 0 ? e.homeTeam?.name : e.awayTeam?.name;
  if (!player) return;
  const m = findMarketForPlayer(e, player);
  if (!m) {
    state.marketMisses++;
    const candidates = Array.from(markets.values())
      .filter(isMatchWinnerMarket)
      .slice(0, 10)
      .map(x => ({
        id: x.id,
        question: x.question || x.title || null,
        eventSlug: x.eventSlug || null,
        outcomes: marketPlayerNames(x)
      }));
    log("MARKET_MISS", {
      eventId: e.id,
      player,
      home: e.homeTeam?.name || null,
      away: e.awayTeam?.name || null,
      marketsLoaded: markets.size,
      winnerMarkets: Array.from(markets.values()).filter(isMatchWinnerMarket).length,
      sampleWinnerMarkets: candidates
    });
    return;
  }
  const outcomes = parseJsonField(m.outcomes);
  const prices0 = parseJsonField(m.outcomePrices);
  const idx = outcomes.findIndex(x => playerNameMatch(player, String(x)));
  const initialAsk = idx >= 0 ? Number(prices0[idx]) : null;
  log("MARKET_PRICE_MAP", {
    eventId: e.id,
    player,
    outcomes,
    selectedOutcome: idx >= 0 ? outcomes[idx] : null,
    price: Number.isFinite(initialAsk) ? initialAsk : null
  });
  const px = { ask: Number.isFinite(initialAsk) ? initialAsk : null, depth: 0 };
  const liq = marketLiquidity(m);

  const key = `${e.id}:${player}`;
  const last = alerted.get(key) || 0;
  log("ALERT_COOLDOWN_CHECK", {
    eventId: e.id,
    player,
    lastAlertAt: last ? new Date(last).toISOString() : null,
    cooldownMs: CFG.cooldownMs,
    elapsedMs: last ? Date.now() - last : null
  });
  if (Date.now() - last < CFG.cooldownMs) {
    state.cooldownBlocked++;
    log("COOLDOWN_BLOCK", { eventId: e.id, player });
    return;
  }
  log("ALERT_COOLDOWN_PASS", { eventId: e.id, player });
  const sets = scoreSets(e);
  const [sh, sa] = sets.length ? sets[sets.length - 1] : [0,0];
  const text =
`🎾 TENNIS — 2 BREAKS

${e.homeTeam?.name} vs ${e.awayTeam?.name}

${player} lost 2 service games in a row.
SET: ${sh}–${sa}

POLYMARKET PRICE: ${px.ask == null ? "—" : `${Math.round(px.ask * 100)}¢`}
LIQUIDITY: $${Math.round(liq)}
ASK DEPTH: $${Math.round(px.depth)}

COMEBACK CANDIDATE`;
  log("TELEGRAM_ATTEMPT", {
    eventId: e.id,
    player,
    marketUrl: marketUrl(m),
    textPreview: text.slice(0, 220)
  });
  const sent = await telegram(text, marketUrl(m));
  if (sent !== false) {
    alerted.set(key, Date.now());
    state.alertsSent++;
    log("ALERT_SENT", { eventId: e.id, player, price: px.ask, liquidity: liq });
  } else {
    state.alertsSent = Math.max(0, state.alertsSent - 1);
    log("ALERT_SEND_FAILED", { eventId: e.id, player, price: px.ask, liquidity: liq });
  }
}

async function poll() {
  try {
    const body = await getJson(CFG.sofaUrl, "sofa");
    const events = body.events || [];
    state.liveMatches = events.length;
    log("SOFA_LIVE", { liveMatches: events.length });
    for (const e of events) {
      if (e?.status?.type !== "inprogress") continue;
      const sets = scoreSets(e);
      log("LIVE_MATCH", {
        eventId: e.id,
        home: e.homeTeam?.name || null,
        away: e.awayTeam?.name || null,
        sets,
        firstToServe: firstServer(e)
      });
      if (!sets.length || !e.homeTeam?.name || !e.awayTeam?.name) continue;
      const id = String(e.id);
      const prev = matches.get(id);
      if (!prev) {
        matches.set(id, { sets, firstToServe: firstServer(e), breakSeq: [], home: e.homeTeam.name, away: e.awayTeam.name, slug: e.slug });
        continue;
      }
      const breaks = await processBreaks(e, sets);
      for (const breakInfo of breaks) {
        const side = recordSignal(e, breakInfo);
        if (side !== null) {
          state.signals++;
          state.twoBreakCandidates++;
          log("TWO_BREAKS", { eventId: e.id, player: side === 0 ? e.homeTeam.name : e.awayTeam.name, sets });
          try { await evaluate(e, side); } catch (err) { state.telegramErrors++; log("ALERT_ERROR", { error: String(err) }); }
        }
      }
    }
    state.lastPollAt = new Date().toISOString();
  } catch (err) {
    state.sourceErrors++;
    state.lastError = String(err);
    log("SOFA_ERROR", { error: String(err) });
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/test-alert") {
    sendTestAlert()
      .then(sent => {
        res.writeHead(sent === false ? 502 : 200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: sent !== false, testAlert: true }));
      })
      .catch(err => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      });
    return;
  }

  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, strategy: "two-consecutive-service-breaks", state }, null, 2));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(CFG.port, () => log("MONITOR_READY", { port: CFG.port, strategy: "two-consecutive-service-breaks" }));

// Send exactly one Telegram test per process start so a fresh deployment verifies delivery.
if (!globalThis.__TEST_ALERT_SENT__) {
  globalThis.__TEST_ALERT_SENT__ = true;
  await sendTestAlert().catch(err => log("TEST_ALERT_ERROR", { error: String(err) }));
}


await refreshMarkets().catch(err => { state.lastError = String(err); log("GAMMA_ERROR", { error: String(err) }); });
setInterval(() => refreshMarkets().catch(err => log("GAMMA_ERROR", { error: String(err) })), CFG.gammaMs);
await poll();
setInterval(poll, CFG.pollMs);
