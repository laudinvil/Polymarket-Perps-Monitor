import http from "node:http";
const CFG = {
  pollMs: 10000,
  gammaMs: 60000,
  requestTimeoutMs: 7000,
  telegramMinMs: 1000,
  cooldownMs: 20 * 60 * 1000,
  port: Number(process.env.PORT || 3000),
  sofaUrl: "https://www.sofascore.com/api/v1/sport/tennis/events/live",
  gammaUrl: "https://gamma-api.polymarket.com/markets?tag_id=864&active=true&closed=false&limit=500&order=endDate&ascending=true",
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

function namesFromMarket(m) {
  const q = String(m.question || "");
  const title = String(m.title || "");
  const slug = String(m.slug || m.eventSlug || "");
  const outcomes = marketPlayerNames(m);
  return { q, title, slug, outcomes, text: norm(q + " " + title + " " + slug + " " + outcomes.join(" ")) };
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

  // Fallback: compare both player names against question/title/event slug.
  const t = namesFromMarket(m).text;
  const hit = (name) => {
    const k = nameKey(name);
    if (!k) return false;
    if (t.includes(k.n)) return true;
    if (t.includes(k.compact)) return true;
    return t.includes(k.last) && t.includes(k.first);
  };
  return hit(home) && hit(away);
}

function marketUrl(m) {
  // Prefer the parent event slug: /event/{slug} is the stable public
  // Polymarket page for a tennis match. A market slug is only a fallback.
  const nestedEvent = Array.isArray(m.events) ? m.events.find(x => x && x.slug) : null;
  const slug =
    m.eventSlug ||
    m.event?.slug ||
    nestedEvent?.slug ||
    (typeof m.event === "string" ? m.event : null) ||
    null;
  if (slug) return `https://polymarket.com/event/${slug}`;

  // Last-resort fallback for older Gamma payloads that expose only a slug.
  if (m.slug) return `https://polymarket.com/event/${m.slug}`;
  return "https://polymarket.com/tennis";
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
  const arr = Array.isArray(data) ? data : (data.data || data.markets || []);
  markets.clear();
  for (const m of arr) {
    if (!m || m.closed === true || m.active === false) continue;
    // Gamma query is already scoped to Polymarket's tennis tag (864).
    // Do not require the question itself to contain the word "tennis":
    // normal match markets usually contain only the two player names.
    markets.set(String(m.id), m);
    
  }
  state.matchedMarkets = markets.size;
  state.lastGammaAt = new Date().toISOString();
}

function findMarketForPlayer(e, playerName) {
  const candidates = [];
  for (const m of markets.values()) {
    if (!matchMarket(m, e)) continue;
    const names = namesFromMarket(m);
    const outcomes = names.outcomes || [];
    const exactOutcome = outcomes.some(x => playerNameMatch(playerName, x));
    const q = String(m.question || m.title || "").toLowerCase();
    const winnerish = q.includes("win") || q.includes("winner");
    const score =
      (exactOutcome ? 100 : 0) +
      (winnerish ? 20 : 0) +
      (outcomes.length === 2 ? 10 : 0) +
      (m.slug || m.eventSlug ? 5 : 0);
    candidates.push({ m, score });
  }
  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates[0]?.m || null;
  if (selected) {
    state.marketMatches++;
    log("MARKET_MATCH", {
      eventId: e.id,
      player: playerName,
      marketId: selected.id,
      slug: selected.slug || selected.eventSlug || null,
      outcomes: marketPlayerNames(selected)
    });
  }
  return selected;
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
  lastTelegramRequest = Date.now();\n  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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

async function evaluate(e, brokenSide) {
  const player = brokenSide === 0 ? e.homeTeam?.name : e.awayTeam?.name;
  if (!player) return;
  const m = findMarketForPlayer(e, player);
  if (!m) {
    state.marketMisses++;
    log("MARKET_MISS", { eventId: e.id, player });
    return;
  }
  const outcomes = parseJsonField(m.outcomes);
  const prices0 = parseJsonField(m.outcomePrices);
  const idx = outcomes.findIndex(x => String(x).toLowerCase() === String(player).toLowerCase());
  const initialAsk = idx >= 0 ? Number(prices0[idx]) : Number(prices0[0]);
  const px = { ask: Number.isFinite(initialAsk) ? initialAsk : null, depth: 0 };
  const liq = marketLiquidity(m);

  const key = `${e.id}:${player}`;
  const last = alerted.get(key) || 0;
  if (Date.now() - last < CFG.cooldownMs) {
    state.cooldownBlocked++;
    log("COOLDOWN_BLOCK", { eventId: e.id, player });
    return;
  }
  alerted.set(key, Date.now());

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
  state.alertsSent++;
  await telegram(text, marketUrl(m));
  log("ALERT_SENT", { eventId: e.id, player, price: px.ask, liquidity: liq });
}

async function poll() {
  try {
    const body = await getJson(CFG.sofaUrl, "sofa");
    const events = body.events || [];
    state.liveMatches = events.length;
    for (const e of events) {
      if (e?.status?.type !== "inprogress") continue;
      const sets = scoreSets(e);
      if (!sets.length || !e.homeTeam?.name || !e.awayTeam?.name) continue;
      const id = String(e.id);
      const prev = matches.get(id);
      if (!prev) {
        matches.set(id, { sets, firstToServe: Number(e.firstToServe || 1), breakSeq: [], home: e.homeTeam.name, away: e.awayTeam.name, slug: e.slug });
        continue;
      }
      const breaks = processBreaks(e, sets);
      for (const brokenSide of breaks) {
        const side = recordSignal(e, brokenSide);
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
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, strategy: "two-consecutive-service-breaks", state }, null, 2));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(CFG.port, () => log("MONITOR_READY", { port: CFG.port, strategy: "two-consecutive-service-breaks" }));

await refreshMarkets().catch(err => { state.lastError = String(err); log("GAMMA_ERROR", { error: String(err) }); });
setInterval(() => refreshMarkets().catch(err => log("GAMMA_ERROR", { error: String(err) })), CFG.gammaMs);
await poll();
setInterval(poll, CFG.pollMs);
