const PS_TOKEN = process.env.PANDASCORE_API_TOKEN;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const GH_REPO = process.env.GITHUB_REPOSITORY || "laudinvil/Polymarket-Perps-Monitor";

if (!PS_TOKEN) throw new Error("Missing PANDASCORE_API_TOKEN");
if (!TG_TOKEN || !TG_CHAT) throw new Error("Missing Telegram secrets");

const PS_BASE = "https://api.pandascore.co";
const GAMMA = "https://gamma-api.polymarket.com";
const CLOB = "https://clob.polymarket.com";

const CFG = {
  minPreFavorite: 0.40,
  maxPreFavorite: 0.60,
  minMove: 0.25,
  minPostFavorite: 0.75,
  maxPostFavorite: 0.90,
  minMapMargin: 6,
  requireMapMargin: false,
  maxUpcomingHours: 24,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || "")
  .toLowerCase()
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/&/g, " and ")
  .replace(/[^a-z0-9]+/g, " ")
  .replace(/\b(esports?|gaming|team|academy|club|fc|gg|org)\b/g, " ")
  .replace(/\s+/g, " ").trim();

const sim = (a,b) => {
  const A = new Set(norm(a).split(" ").filter(x => x.length > 2));
  const B = new Set(norm(b).split(" ").filter(x => x.length > 2));
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / Math.max(A.size, B.size);
};

async function getJson(url, headers = {}) {
  let last;
  for (let i=0;i<4;i++) {
    try {
      const r = await fetch(url, { headers: { accept:"application/json", ...headers }, signal: AbortSignal.timeout(12000) });
      if (r.ok) return { data: await r.json(), headers: r.headers };
      last = new Error("HTTP " + r.status + " " + url);
      if (![429,500,502,503,504].includes(r.status)) throw last;
    } catch (e) { last = e; }
    if (i < 3) await sleep(800 * (i+1));
  }
  throw last;
}

async function ps(path) {
  return (await getJson(PS_BASE + path, { authorization: "Bearer " + PS_TOKEN })).data;
}

function opponents(match) {
  return Array.isArray(match.opponents) ? match.opponents : [];
}
function teams(match) {
  return opponents(match).map(x => x?.opponent?.name || x?.opponent?.acronym).filter(Boolean).slice(0,2);
}
function seriesScore(match) {
  const o = opponents(match);
  if (o.length < 2) return null;
  const a = Number(o[0]?.score), b = Number(o[1]?.score);
  return Number.isFinite(a) && Number.isFinite(b) ? [a,b] : null;
}
function bo3(match) {
  return String(match.match_type || "").toLowerCase() === "best_of" && Number(match.number_of_games) === 3;
}
function beginAt(match) {
  const v = match.begin_at || match.scheduled_at;
  const t = Date.parse(v || "");
  return Number.isFinite(t) ? t : null;
}

function parseJsonMaybe(v) {
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}

function eventTeams(event) {
  const out = [];
  const add = v => {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (v && typeof v === "object") {
      const n = v.name || v.teamName || v.title;
      if (n) out.push(String(n));
    }
  };
  add(event.homeTeam); add(event.awayTeam);
  add(event.homeTeamName); add(event.awayTeamName);
  if (Array.isArray(event.teams)) event.teams.forEach(add);
  return [...new Set(out)];
}

function parseMarket(m) {
  const outcomes = parseJsonMaybe(m.outcomes);
  const ids = parseJsonMaybe(m.clobTokenIds);
  if (!Array.isArray(outcomes) || !Array.isArray(ids) || outcomes.length !== ids.length) return null;
  return outcomes.map((name,i) => ({ name:String(name), tokenId:String(ids[i]) }));
}

function isMatchWinnerMarket(m, teamA, teamB) {
  const q = String(m.question || m.title || "").toLowerCase();
  const p = parseMarket(m);
  if (!p || p.length !== 2) return false;
  const names = p.map(x => norm(x.name));
  const a = norm(teamA), b = norm(teamB);
  const outcomeMatch = (names.some(x => sim(x,a) >= .5) && names.some(x => sim(x,b) >= .5));
  return outcomeMatch && /(win|winner|match)/i.test(q);
}

async function findPolyEvent(teamA, teamB) {
  const urls = [
    GAMMA + "/events?active=true&closed=false&limit=500&tag_slug=esports",
    GAMMA + "/events?active=true&closed=false&limit=500&tag_slug=cs2",
  ];
  let events = [];
  for (const u of urls) {
    try {
      const x = await getJson(u);
      if (Array.isArray(x.data)) events.push(...x.data);
    } catch (e) { console.log("POLY_DISCOVERY_ERROR", String(e)); }
  }
  events = [...new Map(events.filter(e=>e?.id!=null).map(e=>[String(e.id),e])).values()];
  let best = null;
  for (const e of events) {
    const et = eventTeams(e);
    const title = String(e.title || e.name || "");
    const titleScore = Math.max(sim(title, teamA + " " + teamB), sim(title, teamB + " " + teamA));
    let teamScore = 0;
    if (et.length >= 2) teamScore = Math.max(
      sim(teamA,et[0]) + sim(teamB,et[1]),
      sim(teamA,et[1]) + sim(teamB,et[0])
    );
    if (!best || teamScore > best.score) best = { event:e, score:teamScore };
  }
  if (!best || best.score < 0.85) return null;
  const e = best.event;
  const markets = Array.isArray(e.markets) ? e.markets : [];
  for (const m of markets) {
    if (!m.active || m.closed) continue;
    if (isMatchWinnerMarket(m, teamA, teamB)) return { event:e, market:m, score:best.score };
  }
  return null;
}

async function price(tokenId) {
  try {
    const x = await getJson(CLOB + "/midpoint?token_id=" + encodeURIComponent(tokenId));
    const p = Number(x.data?.mid);
    if (Number.isFinite(p)) return p;
  } catch {}
  const x = await getJson(CLOB + "/price?token_id=" + encodeURIComponent(tokenId) + "&side=BUY");
  const p = Number(x.data?.price);
  return Number.isFinite(p) ? p : null;
}

async function marketPrices(poly) {
  const parsed = parseMarket(poly.market);
  if (!parsed) return null;
  const vals = [];
  for (const o of parsed) vals.push({ ...o, price: await price(o.tokenId) });
  if (vals.some(x => x.price == null)) return null;
  const total = vals[0].price + vals[1].price;
  if (total <= 0) return null;
  return vals.map(x => ({ ...x, prob: x.price / total }));
}

function identifySides(prices, teamA, teamB) {
  let a = prices.find(x => sim(x.name, teamA) >= .5);
  let b = prices.find(x => sim(x.name, teamB) >= .5);
  if (!a || !b) {
    a = prices[0]; b = prices[1];
  }
  return { a, b };
}

function map1Info(match) {
  const s = seriesScore(match);
  if (!s || (s[0] + s[1]) < 1) return null;
  const winner = s[0] === 1 && s[1] === 0 ? 0 : s[1] === 1 && s[0] === 0 ? 1 : null;
  if (winner == null) return null;

  // Free PandaScore fixture data does not guarantee map-level round score.
  // If a map score is exposed in the returned fixture, use it; otherwise leave null.
  let margin = null;
  const candidates = [
    match.map_score, match.current_game_score, match.currentGameScore,
    match.game_score, match.gameScore, match.round_score, match.roundScore
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length >= 2) {
      const x=Number(c[0]), y=Number(c[1]);
      if (Number.isFinite(x)&&Number.isFinite(y)) margin=Math.abs(x-y);
    } else if (c && typeof c === "object") {
      const x=Number(c.home ?? c.team1 ?? c.a), y=Number(c.away ?? c.team2 ?? c.b);
      if (Number.isFinite(x)&&Number.isFinite(y)) margin=Math.abs(x-y);
    }
  }
  return { winner, loser:1-winner, series:s, margin };
}

function loadState() {
  const fs = require("fs");
  const path = "state/esports-map1-overreaction.json";
  try {
    return { path, value: JSON.parse(fs.readFileSync(path,"utf8")) };
  } catch {
    return { path, value: { matches:{}, alerts:[] } };
  }
}

function saveState(s) {
  const fs = require("fs");
  fs.mkdirSync("state",{recursive:true});
  fs.writeFileSync(s.path, JSON.stringify(s.value,null,2) + "\n");
}

async function telegram(text, url) {
  const body = new URLSearchParams({
    chat_id: TG_CHAT,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: "false",
  });
  if (url) body.set("reply_markup", JSON.stringify({ inline_keyboard: [[{ text:"ОТКРЫТЬ POLYMARKET", url }]] }));
  const r = await fetch("https://api.telegram.org/bot"+TG_TOKEN+"/sendMessage", {
    method:"POST",
    headers:{"content-type":"application/x-www-form-urlencoded"},
    body,
    signal:AbortSignal.timeout(12000)
  });
  const j = await r.json();
  console.log("TELEGRAM_RESPONSE", JSON.stringify({status:r.status,ok:j.ok}));
  if (!r.ok || !j.ok) throw new Error("Telegram send failed");
}

const state = loadState();
const now = Date.now();

const upcoming = await ps("/csgo/matches/upcoming?per_page=100");
const running = await ps("/csgo/matches/running?per_page=100");

const candidates = [...upcoming, ...running].filter(m => bo3(m));
console.log("PANDASCORE_BO3", JSON.stringify({upcoming:upcoming.length,running:running.length,candidates:candidates.length}));

for (const match of candidates) {
  const ts = beginAt(match);
  if (ts && ts - now > CFG.maxUpcomingHours*3600000) continue;
  const [teamA,teamB] = teams(match);
  if (!teamA || !teamB) continue;

  const key = String(match.id);
  const entry = state.value.matches[key] ||= {
    id:key, teamA, teamB, beginAt:ts, pre:null, alerted:false, lastSeries:null
  };

  const poly = await findPolyEvent(teamA,teamB);
  if (!poly) {
    console.log("NO_POLY_MATCH", JSON.stringify({key,teamA,teamB}));
    continue;
  }

  const prices = await marketPrices(poly);
  if (!prices) {
    console.log("NO_POLY_PRICE", JSON.stringify({key,teamA,teamB}));
    continue;
  }
  const sides = identifySides(prices,teamA,teamB);

  if (!entry.pre && (!ts || ts > now)) {
    entry.pre = {
      teamA, teamB,
      a: sides.a.prob, b: sides.b.prob,
      capturedAt: new Date().toISOString(),
      marketId: String(poly.market.id || ""),
      eventSlug: String(poly.event.slug || "")
    };
    console.log("PREMATCH_CAPTURED", JSON.stringify({key,teamA,teamB,a:sides.a.prob,b:sides.b.prob}));
  }

  const info = map1Info(match);
  entry.lastSeries = seriesScore(match);

  if (!info || entry.alerted) continue;
  if (!entry.pre) {
    console.log("SKIP_NO_PREMATCH", JSON.stringify({key,teamA,teamB}));
    continue;
  }

  const preWinner = info.winner === 0 ? entry.pre.a : entry.pre.b;
  const preLoser = info.loser === 0 ? entry.pre.a : entry.pre.b;
  const postWinner = info.winner === 0 ? sides.a.prob : sides.b.prob;
  const postLoser = info.loser === 0 ? sides.a.prob : sides.b.prob;

  const preFavorite = Math.max(entry.pre.a,entry.pre.b);
  const move = postWinner - preWinner;
  const oneSided = info.margin == null ? true : info.margin >= CFG.minMapMargin;
  const balancedPre = preFavorite >= CFG.minPreFavorite && preFavorite <= CFG.maxPreFavorite;
  const overshoot = move >= CFG.minMove && postWinner >= CFG.minPostFavorite && postWinner <= CFG.maxPostFavorite;
  const mapFilter = CFG.requireMapMargin ? oneSided && info.margin != null : oneSided;

  console.log("SIGNAL_CHECK", JSON.stringify({
    key,match:teamA+" vs "+teamB,map1:info.series,margin:info.margin,
    preA:entry.pre.a,preB:entry.pre.b,postA:sides.a.prob,postB:sides.b.prob,
    move,balancedPre,overshoot,mapFilter
  }));

  if (!(balancedPre && overshoot && mapFilter)) continue;

  const loser = info.loser === 0 ? teamA : teamB;
  const loserProb = postLoser;
  const winner = info.winner === 0 ? teamA : teamB;
  const marginText = info.margin == null ? "—" : String(info.margin);

  const text =
    "<b>CS2 — MAP 2 SETUP</b>\n\n" +
    "<b>"+winner+"</b> won Map 1 vs <b>"+loser+"</b>\n" +
    "MAP 1 SERIES SCORE: "+info.series[0]+"–"+info.series[1]+"\n" +
    "MAP MARGIN: "+marginText+"\n\n" +
    "PRE-MATCH\n" +
    teamA+": "+Math.round(entry.pre.a*100)+"%\n" +
    teamB+": "+Math.round(entry.pre.b*100)+"%\n\n" +
    "AFTER MAP 1\n" +
    teamA+": "+Math.round(sides.a.prob*100)+"%\n" +
    teamB+": "+Math.round(sides.b.prob*100)+"%\n\n" +
    "MOVE: +"+Math.round(move*100)+" pp\n" +
    "NEXT MAP CANDIDATE: <b>"+loser+"</b>\n" +
    "CURRENT: "+Math.round(loserProb*100)+"%";

  const url = poly.event.slug ? "https://polymarket.com/event/"+poly.event.slug : "https://polymarket.com/esports/cs2";
  await telegram(text,url);

  entry.alerted = true;
  entry.alertedAt = new Date().toISOString();
  state.value.alerts.push({matchId:key,teamA,teamB,winner,loser,preWinner,postWinner,move,at:entry.alertedAt});
  state.value.alerts = state.value.alerts.slice(-500);
  saveState(state);
  console.log("ALERT_SENT", JSON.stringify({key,teamA,teamB,loser,move}));
}

saveState(state);
console.log("POLL_RESULT", JSON.stringify({tracked:Object.keys(state.value.matches).length,alerts:state.value.alerts.length}));
