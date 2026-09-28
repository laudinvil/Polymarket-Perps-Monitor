const fs = require("fs");
const path = require("path");
const http = require("http");
const WebSocket = require("ws");

const VERSION = "7.1.0";
const BUILD_SHA = process.env.MONITOR_BUILD_SHA || "unknown";
const POLL_MS = 10_000;
const PERIOD_MS = 300_000;
const RTDS_URL = "wss://ws-live-data.polymarket.com";

const ASSETS = [
  { key: "BTC", symbol: "btc/usd", slug: "btc-updown-5m" },
  { key: "ETH", symbol: "eth/usd", slug: "eth-updown-5m" },
  { key: "SOL", symbol: "sol/usd", slug: "sol-updown-5m" },
  { key: "BNB", symbol: "bnb/usd", slug: "bnb-updown-5m" },
  { key: "XRP", symbol: "xrp/usd", slug: "xrp-updown-5m" },
  { key: "DOGE", symbol: "doge/usd", slug: "doge-updown-5m" },
  { key: "HYPE", symbol: "hype/usd", slug: "hype-updown-5m" }
];

const STATE_FILE = process.env.STATE_FILE || "/data/chainlink-twap60-state.json";
const LOG_FILE = process.env.LOG_FILE || "/data/chainlink-twap60.jsonl";

const sockets = new Map();
const reconnectTimers = new Map();
const heartbeatTimers = new Map();
let connected = false;
let state = null;
let collectionStartedAt = null;
const latest = new Map();
const history = new Map();
let historyReady = false;

function nowIso() { return new Date().toISOString(); }
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }

function log(event, data = {}) {
  const row = { ts: nowIso(), version: VERSION, event, ...data };
  console.log(JSON.stringify(row));
  try {
    ensureDir(LOG_FILE);
    fs.appendFileSync(LOG_FILE, JSON.stringify(row) + "\n");
  } catch {}
}

function defaultState() {
  return {
    version: VERSION, initialized: true,
    counts: Object.fromEntries(ASSETS.map(a => [a.key, 0])),
    periods: {}, lastProcessedPeriod: null, leader: null,
    updatedAt: nowIso(), source: "Polymarket RTDS Chainlink TWAP60",
    pollingMs: POLL_MS,
    historyBootstrap: null
  };
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (s && typeof s === "object") return s;
  } catch {}
  return defaultState();
}

function saveState() {
  state.updatedAt = nowIso();
  try {
    ensureDir(STATE_FILE);
    const tmp = STATE_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) { log("STATE_WRITE_ERROR", { error: String(e.message || e) }); }
}

function snapshot(reason) {
  const file = STATE_FILE.replace(/\.json$/, "") + "-snapshots.jsonl";
  try {
    ensureDir(file);
    fs.appendFileSync(file, JSON.stringify({ ts: nowIso(), reason, version: VERSION, state }) + "\n");
  } catch {}
  log("STATE_SNAPSHOT", {
    reason, counts: state.counts,
    lastProcessedPeriod: state.lastProcessedPeriod, leader: state.leader
  });
}

function startHealth() {
  const port = Number(process.env.PORT || 8080);
  const server = http.createServer((req, res) => {
    if (req.url === "/status" || req.url === "/health" || req.url === "/") {
      const payload = {
        status: "ok", version: VERSION, buildSha: BUILD_SHA,
        source: "Polymarket RTDS Chainlink TWAP60",
        websocket: connected, collectionStartedAt, pollingMs: POLL_MS,
        assets: ASSETS.map(a => ({ asset: a.key, symbol: a.symbol, latest: latest.get(a.key) || null })),
        lastProcessedPeriod: state.lastProcessedPeriod, leader: state.leader,
        counts: state.counts, uptimeSec: Math.floor(process.uptime()), updatedAt: state.updatedAt
      };
      res.writeHead(200, {"content-type":"application/json","cache-control":"no-store"});
      return res.end(JSON.stringify(payload));
    }
    if (req.url === "/logs") {
      let text = "";
      try { text = fs.readFileSync(LOG_FILE, "utf8").slice(-120000); } catch {}
      res.writeHead(200, {"content-type":"text/plain; charset=utf-8","cache-control":"no-store"});
      return res.end(text);
    }
    res.writeHead(404); res.end();
  });
  server.listen(port, "0.0.0.0", () => log("HEALTH_LISTENING", { port }));
}

function connectRtds() {
  for (const asset of ASSETS) connectAssetRtds(asset);
}

function connectAssetRtds(asset) {
  const existing = sockets.get(asset.key);
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) return;

  clearTimeout(reconnectTimers.get(asset.key));
  log("RTDS_CONNECTING", { url: RTDS_URL, asset: asset.key });

  const socket = new WebSocket(RTDS_URL);
  sockets.set(asset.key, socket);

  socket.on("open", () => {
    connected = true;
    if (!collectionStartedAt) {
      collectionStartedAt = Date.now();
      log("COLLECTION_STARTED", { at: collectionStartedAt, nextPeriodStart: currentPeriodStart() + PERIOD_MS });
    }

    log("RTDS_CONNECTED", { asset: asset.key });

    // RTDS currently rejects a multi-symbol TWAP subscription batch.
    // Use one WebSocket/subscription per asset so one bad symbol cannot
    // suppress the other six streams.
    const subscription = {
      action: "subscribe",
      subscriptions: [{
        topic: "crypto_prices_twap_sixty",
        type: "update",
        filters: JSON.stringify({ symbol: asset.symbol })
      }]
    };
    socket.send(JSON.stringify(subscription));
    log("RTDS_SUBSCRIBED", {
      topic: "crypto_prices_twap_sixty",
      asset: asset.key,
      symbol: asset.symbol,
      windowSeconds: 60
    });

    clearInterval(heartbeatTimers.get(asset.key));
    heartbeatTimers.set(asset.key, setInterval(() => {
      const current = sockets.get(asset.key);
      if (current && current.readyState === WebSocket.OPEN) {
        try { current.send("PING"); } catch {}
      }
    }, 5000));
  });

  socket.on("message", raw => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.message) {
      log("RTDS_MESSAGE", { asset: asset.key, message: msg.message });
      return;
    }

    const p = msg.payload;
    if (!p || msg.topic !== "crypto_prices_twap_sixty") return;
    if (Number(p.window_s) !== 60) {
      log("TWAP_REJECTED", { asset: asset.key, reason: "window_not_60", payload: p });
      return;
    }

    const symbol = String(p.symbol || "").toLowerCase();
    if (symbol !== asset.symbol) return;

    let ts = Number(p.timestamp);
    const exact = String(p.full_accuracy_value || "");
    if (!Number.isFinite(ts) || !exact) return;
    if (ts > 0 && ts < 1_000_000_000_000) ts *= 1000;

    const value = Number(exact) / 1e18;
    if (!Number.isFinite(value)) return;

    const point = { ts, value, exact, receivedAt: Date.now() };
    latest.set(asset.key, point);

    let arr = history.get(asset.key);
    if (!arr) { arr = []; history.set(asset.key, arr); }
    const last = arr[arr.length - 1];
    if (!last || ts > last.ts) arr.push(point);

    const cutoff = Date.now() - 12 * 60 * 1000;
    while (arr.length && arr[0].ts < cutoff) arr.shift();

    if (!last || ts > last.ts) {
      log("TWAP60_UPDATE", {
        asset: asset.key, symbol, observationTimestamp: ts, value, windowSeconds: 60
      });
    }
  });

  socket.on("close", (code, reason) => {
    connected = Array.from(sockets.values()).some(x => x && x.readyState === WebSocket.OPEN);
    clearInterval(heartbeatTimers.get(asset.key));
    heartbeatTimers.delete(asset.key);
    if (sockets.get(asset.key) === socket) sockets.delete(asset.key);
    log("RTDS_CLOSED", { asset: asset.key, code, reason: reason ? reason.toString() : "" });
    scheduleReconnect(asset);
  });

  socket.on("error", e => log("RTDS_ERROR", { asset: asset.key, error: String(e.message || e) }));
}

function scheduleReconnect(asset) {
  if (reconnectTimers.get(asset.key)) return;
  reconnectTimers.set(asset.key, setTimeout(() => {
    reconnectTimers.delete(asset.key);
    connectAssetRtds(asset);
  }, 3000));
}

function pointAtOrBefore(assetKey, targetMs) {
  const arr = history.get(assetKey) || [];
  let best = null;
  for (const p of arr) {
    if (p.ts <= targetMs) best = p;
    else break;
  }
  return best;
}

function pointAtOrAfter(assetKey, targetMs) {
  const arr = history.get(assetKey) || [];
  for (const p of arr) {
    if (p.ts >= targetMs) return p;
  }
  return null;
}

const LIVE_BOUNDARY_LOOKBACK_MS = 70_000;

function boundaryPoints(assetKey, openTargetMs, closeTargetMs) {
  // Select the freshest observation at/before each boundary, but only within
  // 70s. Future observations and stale observations are never substituted.
  const arr = history.get(assetKey) || [];
  const select = target => {
    let selected = null;
    for (const p of arr) {
      if (!p || !Number.isFinite(p.ts) || p.ts > target) continue;
      const age = target - p.ts;
      if (age <= LIVE_BOUNDARY_LOOKBACK_MS && (!selected || p.ts > selected.ts)) {
        selected = p;
      }
    }
    return selected;
  };
  return { open: select(openTargetMs), close: select(closeTargetMs) };
}

function currentPeriodStart() { return Math.floor(Date.now() / PERIOD_MS) * PERIOD_MS; }

function ranking() {
  return ASSETS.map(a => ({ asset: a.key, score: Number(state.counts[a.key] || 0) }))
    .sort((a,b) => Math.abs(b.score)-Math.abs(a.score) || a.asset.localeCompare(b.asset));
}

async function sendTelegram(text, kind = "PERIOD_ALERT") {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  log("TELEGRAM_TARGET", { kind, chatConfigured: !!chat, chatIdTail: chat ? String(chat).slice(-4) : null });
  log("TELEGRAM_ATTEMPT", { kind, configured: !!token && !!chat, textPreview: text.slice(0, 300) });

  if (!token || !chat) {
    log("TELEGRAM_NOT_CONFIGURED", { kind });
    return false;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const r = await fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      signal: controller.signal,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: false })
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      log("TELEGRAM_ERROR", { kind, status: r.status, body: body.slice(0, 1000) });
      return false;
    }
    let data = null;
    try { data = await r.json(); } catch {}
    clearTimeout(timeout);
    if (!data || data.ok !== true) {
      log("TELEGRAM_ERROR", { kind, status: r.status, body: JSON.stringify(data).slice(0, 1000) });
      return false;
    }
    log("TELEGRAM_SENT", { kind, messageId: data?.result?.message_id || null });
    return true;
  } catch (e) {
    clearTimeout(timeout);
    log("TELEGRAM_ERROR", { kind, error: String(e.message || e) });
    return false;
  }
}

async function sendOnlineAlert() {
  // Startup connectivity is logged only; Telegram is reserved for actual period alerts.
  log("ONLINE_READY", {
    assets:Object.fromEntries(ASSETS.map(a => [a.key, latest.get(a.key) || null]))
  });
  return false;
}


const HISTORY_START_MS = Date.UTC(2026, 7, 14);
const HISTORY_BOOTSTRAP_VERSION = "2026-08-14-chainlink-twap60-boundaries-v2";
const HISTORY_PERIOD_MS = PERIOD_MS;
const HISTORY_BATCH_SIZE = 10;
const HISTORY_RETRY_MS = 5000;
const CHAINLINK_MIN_REQUEST_INTERVAL_MS = 125; // <= 8 requests/sec at request start
let chainlinkLastRequestAt = 0;
const CHAINLINK_REST = process.env.CHAINLINK_REST_URL || "https://api.dataengine.chain.link";
const CHAINLINK_API_KEY = process.env.CHAINLINK_CLIENT_ID || process.env.CHAINLINK_API_KEY || process.env.API_KEY || "";
const CHAINLINK_USER_SECRET = process.env.CHAINLINK_CLIENT_SECRET || process.env.CHAINLINK_USER_SECRET || process.env.USER_SECRET || "";
const CHAINLINK_FEED_IDS_ENV = process.env.CHAINLINK_TWAP60_FEED_IDS || "";
let chainlinkClient = null;
let chainlinkFeedIds = null;
let historicalBootstrapRunning = false;

function exactToBigInt(value) {
  const s = String(value || "").trim();
  if (!/^-?\d+$/.test(s)) throw new Error("invalid_e18:" + s.slice(0, 40));
  return BigInt(s);
}
function normalizeFeedList(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.feeds)) return value.feeds;
  if (Array.isArray(value?.result?.feeds)) return value.result.feeds;
  return [];
}
function feedText(feed) { try { return JSON.stringify(feed).toLowerCase(); } catch { return ""; } }
function feedIdOf(feed) { return feed?.feedID || feed?.feedId || feed?.id || feed?.streamId || feed?.streamID || null; }

async function initChainlinkHistoricalClient() {
  if (chainlinkClient) return chainlinkClient;
  if (!CHAINLINK_API_KEY || !CHAINLINK_USER_SECRET) throw new Error("CHAINLINK_CREDENTIALS_MISSING");
  const sdk = await import("@chainlink/data-streams-sdk");
  const createClient = sdk.createClient || sdk.default?.createClient;
  if (!createClient) throw new Error("CHAINLINK_SDK_CREATE_CLIENT_UNAVAILABLE");
  chainlinkClient = createClient({
    apiKey: CHAINLINK_API_KEY,
    userSecret: CHAINLINK_USER_SECRET,
    endpoint: CHAINLINK_REST,
    wsEndpoint: process.env.CHAINLINK_WS_URL || "wss://ws.dataengine.chain.link"
  });
  return chainlinkClient;
}
function parseFeedIdEnv() {
  const raw=CHAINLINK_FEED_IDS_ENV.trim();
  if(!raw) return {};
  try { const parsed=JSON.parse(raw); if(parsed&&typeof parsed==="object") return parsed; } catch {}
  const parts=raw.split(",").map(x=>x.trim()).filter(Boolean);
  return parts.length===ASSETS.length ? Object.fromEntries(ASSETS.map((a,i)=>[a.key,parts[i]])) : {};
}
async function discoverChainlinkTwap60Feeds() {
  if(chainlinkFeedIds) return chainlinkFeedIds;
  const fromEnv=parseFeedIdEnv();
  if(Object.keys(fromEnv).length===ASSETS.length) { chainlinkFeedIds=fromEnv; log("CHAINLINK_FEEDS_CONFIGURED",{assets:ASSETS.map(a=>a.key)}); return chainlinkFeedIds; }
  const client=await initChainlinkHistoricalClient();
  const listed=normalizeFeedList(await client.listFeeds());
  log("CHAINLINK_FEED_DISCOVERY",{total:listed.length});
  const result={}, candidates={};
  for(const asset of ASSETS) {
    const symbol=asset.symbol.replace("/","").toLowerCase();
    const matches=listed.filter(feed=>{
      const t=feedText(feed), id=String(feedIdOf(feed)||"").toLowerCase();
      return (t.includes(asset.key.toLowerCase())||t.includes(symbol)||t.includes(asset.symbol.toLowerCase())) &&
        t.includes("twap") && (t.includes("60")||t.includes("sixty")) && /^0x[0-9a-f]+$/.test(id);
    });
    candidates[asset.key]=matches.map(feed=>({feedId:feedIdOf(feed),name:feed?.name||feed?.feedName||feed?.description||null}));
    if(matches.length===1) result[asset.key]=feedIdOf(matches[0]);
    else if(matches.length>1) {
      const exact=matches.find(feed=>{const t=feedText(feed);return t.includes(asset.symbol.toLowerCase())&&(t.includes("60s")||t.includes("60-second")||t.includes("sixty"));});
      if(exact) result[asset.key]=feedIdOf(exact);
    }
  }
  log("CHAINLINK_FEED_CANDIDATES",{candidates,selected:result});
  const missing=ASSETS.filter(a=>!result[a.key]).map(a=>a.key);
  if(missing.length) throw new Error("CHAINLINK_TWAP60_FEEDS_NOT_RESOLVED:"+missing.join(","));
  chainlinkFeedIds=result;
  return result;
}
async function decodeChainlinkReport(report) {
  const sdk=await import("@chainlink/data-streams-sdk");
  const decodeReport=sdk.decodeReport||sdk.default?.decodeReport;
  if(!decodeReport) throw new Error("CHAINLINK_SDK_DECODE_REPORT_UNAVAILABLE");
  const decoded=decodeReport(report.fullReport,report.feedID||report.feedId);
  if(decoded?.price===undefined||decoded?.price===null) throw new Error("CHAINLINK_TWAP_PRICE_MISSING");
  const price=typeof decoded.price==="bigint"?decoded.price.toString():String(decoded.price);
  const ots=Number(report.observationsTimestamp??decoded.observationsTimestamp);
  const vts=Number(report.validFromTimestamp??decoded.validFromTimestamp);
  const exp=Number(decoded.expiresAt??report.expiresAt);
  return {exact:price,observationTimestamp:Number.isFinite(ots)?ots*1000:null,validFromTimestamp:Number.isFinite(vts)?vts*1000:null,expiresAt:Number.isFinite(exp)?exp*1000:null};
}
async function waitForChainlinkRateLimit() {
  const now = Date.now();
  const waitMs = Math.max(0, CHAINLINK_MIN_REQUEST_INTERVAL_MS - (now - chainlinkLastRequestAt));
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  chainlinkLastRequestAt = Date.now();
}
async function fetchHistoricalBoundaryPage(feedId, startSec, limit=1000) {
  const client=await initChainlinkHistoricalClient();
  for(let attempt=1;attempt<=5;attempt++) {
    try {
      await waitForChainlinkRateLimit();
      const response=await client.getReportsPage(feedId,startSec,limit);
      return Array.isArray(response)?response:(response?.reports||[]);
    } catch(e) {
      log("CHAINLINK_HISTORY_PAGE_RETRY",{feedId,startSec,limit,attempt,error:String(e.message||e)});
      if(attempt===5) throw e;
      await new Promise(resolve=>setTimeout(resolve,HISTORY_RETRY_MS*attempt));
    }
  }
  return [];
}
async function fetchHistoricalBoundaries(targets) {
  const client=await initChainlinkHistoricalClient();
  const feedIds=await discoverChainlinkTwap60Feeds();
  const boundaryMaps=Object.fromEntries(ASSETS.map(a=>[a.key,new Map()]));
  const cutoffSec=Math.floor(targets[targets.length-1]/1000);
  const startSec=Math.floor(HISTORY_START_MS/1000);
  const LIMIT=1000;

  for (const asset of ASSETS) {
    let cursor=startSec;
    let pages=0;
    let lastObservationSec=0;
    const points=[];
    log("HISTORY_ASSET_START",{asset:asset.key,feedId:feedIds[asset.key],startSec,cutoffSec});
    while(cursor<=cutoffSec) {
      const reports=await fetchHistoricalBoundaryPage(feedIds[asset.key],cursor,LIMIT);
      pages++;
      if(!reports.length) break;
      let maxObservationSec=lastObservationSec;
      for(const report of reports) {
        const decoded=await decodeChainlinkReport(report);
        const ots=decoded.observationTimestamp;
        if(!Number.isFinite(ots)) continue;
        const sec=Math.floor(ots/1000);
        if(sec>maxObservationSec) maxObservationSec=sec;
        const covered=(decoded.validFromTimestamp==null||decoded.validFromTimestamp<=ots)&&(decoded.expiresAt==null||ots<=decoded.expiresAt);
        if(!covered || sec<startSec || sec>cutoffSec) continue;
        points.push({ts:sec*1000,decoded});
      }
      if(maxObservationSec<=lastObservationSec) {
        throw new Error("CHAINLINK_HISTORY_PAGINATION_STALLED:"+asset.key+":"+cursor);
      }
      lastObservationSec=maxObservationSec;
      if(lastObservationSec>=cutoffSec) break;
      cursor=lastObservationSec+1;
      if(pages%10===0) log("HISTORY_ASSET_PROGRESS",{asset:asset.key,pages,points:points.length,lastObservationSec});
    }
    points.sort((a,b)=>a.ts-b.ts);
    let pi=0, previous=null;
    for(const targetMs of targets) {
      while(pi<points.length && points[pi].ts<=targetMs) {
        previous=points[pi].decoded;
        pi++;
      }
      const chosen=previous || (points.find(x=>x.ts>=targetMs)?.decoded || null);
      if(chosen) boundaryMaps[asset.key].set(targetMs,chosen);
    }
    log("HISTORY_ASSET_COMPLETE",{asset:asset.key,pages,boundaries:boundaryMaps[asset.key].size,expectedBoundaries:targets.length,points:points.length});
  }

  const valuesByBoundary={};
  for(const ts of targets) {
    const values={};
    for(const asset of ASSETS) {
      const v=boundaryMaps[asset.key].get(ts);
      if(v) values[asset.key]=v;
    }
    valuesByBoundary[String(ts)]=values;
  }
  return valuesByBoundary;
}
function historyBoundaryTargets(cutoffMs) {
  const out=[]; for(let ts=HISTORY_START_MS;ts<=cutoffMs;ts+=HISTORY_PERIOD_MS) out.push(ts); return out;
}
async function bootstrapHistoricalCounts() {
  if(historicalBootstrapRunning) return false;
  historicalBootstrapRunning=true;
  try {
    const previousHistory=state.historyBootstrap||{};
    // Only fully closed 5m periods belong to the historical baseline.
    const cutoffMs=currentPeriodStart(), targets=historyBoundaryTargets(cutoffMs), expectedPeriods=targets.length-1;
    const sameBaseline=previousHistory.version===HISTORY_BOOTSTRAP_VERSION && previousHistory.from===new Date(HISTORY_START_MS).toISOString();
    if(sameBaseline && previousHistory.complete===true && previousHistory.to===new Date(cutoffMs).toISOString()) {
      log("HISTORY_BOOTSTRAP_ALREADY_COMPLETE",{version:HISTORY_BOOTSTRAP_VERSION,periods:expectedPeriods,counts:state.counts}); return true;
    }
    // Rebuild cumulative state only from the persisted Chainlink boundary cache.
    // This deliberately discards any pre-7.0 live-only counters.
    state.counts=Object.fromEntries(ASSETS.map(a=>[a.key,0]));
    state.periods={}; state.periodAlerted={}; state.leader=null; state.lastProcessedPeriod=null;
    state.historyBootstrap={
      ...previousHistory,
      version:HISTORY_BOOTSTRAP_VERSION,
      complete:false,
      from:new Date(HISTORY_START_MS).toISOString(),
      to:new Date(cutoffMs).toISOString(),
      expectedPeriods,
      completedBoundaries:previousHistory.completedBoundaries||0,
      observations:previousHistory.observations||0,
      boundaries:previousHistory.boundaries||{},
      source:"Chainlink Data Streams REST paginated TWAP60",
      startedAt:previousHistory.startedAt||nowIso()
    };
    saveState(); snapshot("PRE_CHAINLINK_TWAP60_REBUILD");
    log("HISTORY_BOOTSTRAP_START",{version:HISTORY_BOOTSTRAP_VERSION,source:"Chainlink Data Streams REST paginated",from:new Date(HISTORY_START_MS).toISOString(),to:new Date(cutoffMs).toISOString(),boundaries:targets.length,periods:expectedPeriods,concurrency:HISTORY_BATCH_SIZE});
    await discoverChainlinkTwap60Feeds();
    const boundaryCache=new Map();
    const persistedBoundaries=state.historyBootstrap.boundaries||{};
    for(const [ts,values] of Object.entries(persistedBoundaries)) boundaryCache.set(Number(ts),values);
    const missingTargets=targets.filter(ts=>!boundaryCache.has(ts));
    if(missingTargets.length) {
      log("HISTORY_PAGE_BOOTSTRAP_START",{missingBoundaries:missingTargets.length,totalBoundaries:targets.length});
      const fetched=await fetchHistoricalBoundaries(missingTargets);
      for(const [ts,values] of Object.entries(fetched)) {
        boundaryCache.set(Number(ts),values);
        state.historyBootstrap.boundaries=state.historyBootstrap.boundaries||{};
        state.historyBootstrap.boundaries[ts]=values;
      }
      state.historyBootstrap.completedBoundaries=targets.filter(ts=>boundaryCache.has(ts)).length;
      state.historyBootstrap.observations=Array.from(boundaryCache.values()).reduce((n,x)=>n+Object.keys(x).length,0);
      saveState();
      log("HISTORY_PROGRESS",{completedBoundaries:state.historyBootstrap.completedBoundaries,totalBoundaries:targets.length,percent:Number((state.historyBootstrap.completedBoundaries/targets.length*100).toFixed(2))});
    }
    const historicalCounts=Object.fromEntries(ASSETS.map(a=>[a.key,0]));
    const historicalPeriods={}, assetCoverage=Object.fromEntries(ASSETS.map(a=>[a.key,{periods:0,missing:0}])), invalidPeriods=[];
    for(let i=0;i<targets.length-1;i++) {
      const openTs=targets[i],closeTs=targets[i+1],openValues=boundaryCache.get(openTs)||{},closeValues=boundaryCache.get(closeTs)||{},periodKey="period-"+Math.floor(openTs/1000),period={};
      for(const asset of ASSETS) {
        const open=openValues[asset.key],close=closeValues[asset.key];
        if(!open||!close){assetCoverage[asset.key].missing++;continue;}
        const winner=exactToBigInt(close.exact)>=exactToBigInt(open.exact)?"Up":"Down";
        historicalCounts[asset.key]+=winner==="Up"?1:-1; assetCoverage[asset.key].periods++;
        period[asset.key]={winner,openExact:open.exact,closeExact:close.exact,openTimestamp:open.observationTimestamp||openTs,closeTimestamp:close.observationTimestamp||closeTs,source:"chainlink_twap60"};
      }
      if(Object.keys(period).length!==ASSETS.length){invalidPeriods.push({periodKey,open:new Date(openTs).toISOString(),close:new Date(closeTs).toISOString(),available:Object.keys(period)});continue;}
      historicalPeriods[periodKey]=period;
    }
    const totalComplete=Object.keys(historicalPeriods).length;
    const missingAssets=ASSETS.filter(a=>assetCoverage[a.key].periods!==expectedPeriods).map(a=>({asset:a.key,periods:assetCoverage[a.key].periods,expected:expectedPeriods,missing:assetCoverage[a.key].missing}));
    log("HISTORY_VALIDATION",{expectedPeriods,completePeriods:totalComplete,invalidPeriods:invalidPeriods.length,missingAssets,counts:historicalCounts});
    if(totalComplete!==expectedPeriods||missingAssets.length) {
      state.historyBootstrap.complete=false; state.historyBootstrap.validationFailed=true; state.historyBootstrap.completePeriods=totalComplete; state.historyBootstrap.invalidPeriods=invalidPeriods.slice(0,20); state.historyBootstrap.assetCoverage=assetCoverage;
      state.counts=Object.fromEntries(ASSETS.map(a=>[a.key,0])); state.periods={}; state.leader=null; saveState();
      log("HISTORY_BOOTSTRAP_INCOMPLETE",{reason:"every_asset_every_period_required",expectedPeriods,completePeriods:totalComplete,missingAssets,retry:true}); return false;
    }
    state.periods=historicalPeriods; state.counts=historicalCounts; state.leader=ranking()[0];
    state.historyBootstrap={version:HISTORY_BOOTSTRAP_VERSION,complete:true,from:new Date(HISTORY_START_MS).toISOString(),to:new Date(cutoffMs).toISOString(),expectedPeriods,completePeriods:totalComplete,observations:expectedPeriods*ASSETS.length,assetCoverage,source:"Chainlink Data Streams REST paginated TWAP60",completedAt:nowIso()};
    saveState(); snapshot("HISTORY_BOOTSTRAP_COMPLETE");
    log("HISTORY_BOOTSTRAP_COMPLETE",{periods:totalComplete,expectedPeriods,counts:state.counts,from:new Date(HISTORY_START_MS).toISOString(),to:new Date(cutoffMs).toISOString(),source:"Chainlink Data Streams REST paginated TWAP60"});
    return true;
  } finally { historicalBootstrapRunning=false; }
}

async function processClosedPeriod() {
  if (!historyReady || !state.historyBootstrap?.complete) {
    log("PERIOD_WAIT", {
      reason:"historical_baseline_not_ready",
      historyReady,
      historyBootstrapComplete:!!state.historyBootstrap?.complete
    });
    return;
  }

  const start = currentPeriodStart();
  const closedStart = start - PERIOD_MS;
  const periodKey = "period-" + Math.floor(closedStart / 1000);

  state.periods = state.periods || {};
  state.periodAlerted = state.periodAlerted || {};
  const savedPeriod = state.periods[periodKey] || {};
  const savedCount = Object.keys(savedPeriod).length;
  const alreadySent = !!state.periodAlerted?.[periodKey]?.sent;

  // Once Telegram has confirmed delivery, this period is finished.
  if (savedCount >= ASSETS.length && alreadySent) return;

  if (savedCount > 0) {
    log("PERIOD_RETRY_PARTIAL", {
      periodKey,
      savedAssets: Object.keys(savedPeriod)
    });
  }

  const closeBoundary = start;
  const results = {};
  const missing = [];

  for (const asset of ASSETS) {
    const { open, close } = boundaryPoints(asset.key, closedStart, closeBoundary);
    if (!open || !close) {
      missing.push({ asset:asset.key, open:!!open, close:!!close, latest:latest.get(asset.key)||null, reason:"no_valid_observation_within_70s_before_boundary" });
      continue;
    }
    const winner = exactToBigInt(close.exact) >= exactToBigInt(open.exact) ? "Up" : "Down";
    results[asset.key] = {
      winner, open:open.value, close:close.value, openExact:open.exact, closeExact:close.exact, change:close.value-open.value,
      openTimestamp:open.ts, closeTimestamp:close.ts
    };
    log("BOUNDARY_SELECTED", {
      asset:asset.key,
      periodStart:closedStart,
      openTs:open.ts,
      openAgeMs:closedStart-open.ts,
      closeTs:close.ts,
      closeAgeMs:closeBoundary-close.ts
    });
  }

  log("PERIOD_BOUNDARY_CHECK", {
    periodKey,
    closedStart,
    closeBoundary,
    available:Object.keys(results),
    missing:missing.map(x => ({
      asset:x.asset,
      open:x.open,
      close:x.close,
      latestTs:x.latest?.ts || null
    }))
  });

  if (!Object.keys(results).length) {
    log("PERIOD_WAIT", {
      periodKey, reason:"no_twap60_boundary_observation_available", missing, retry:true
    });
    return;
  }

  if (missing.length) {
    log("PERIOD_PARTIAL", {
      periodKey,
      reason:"some_assets_missing_boundary",
      missing,
      available:Object.keys(results),
      alerting:true
    });
  }

  const newResults = {};
  for (const asset of ASSETS) {
    if (results[asset.key] && !savedPeriod[asset.key]) {
      newResults[asset.key] = results[asset.key];
      state.counts[asset.key] += results[asset.key].winner === "Up" ? 1 : -1;
    }
  }

  const mergedResults = { ...savedPeriod, ...newResults };
  const newlyComplete = Object.keys(mergedResults).length >= ASSETS.length;

  // If there is no new RTDS data but this period is already saved, still retry
  // Telegram delivery. Only a confirmed send ends processing.
  // Once this period was delivered, only newly arrived asset results may
  // justify another message. Otherwise the 10s polling loop would spam Telegram.
  if (alreadySent && !Object.keys(newResults).length) {
    return;
  }

  if (!Object.keys(newResults).length && !newlyComplete && savedCount === 0) {
    log("PERIOD_WAIT", {
      periodKey,
      reason:"no_new_twap60_assets",
      savedAssets:Object.keys(savedPeriod),
      available:Object.keys(results),
      retry:true
    });
    return;
  }

  state.periods[periodKey] = mergedResults;
  state.lastProcessedPeriod = periodKey;
  state.leader = ranking()[0];
  saveState();

  // Never send a trading alert from a partial 5m period. The alert must
  // contain all seven assets; partial results remain persisted and are merged
  // when the missing TWAP60 boundaries arrive.
  if (!newlyComplete) {
    // Avoid writing the same diagnostic every 10 seconds. Blitz has no
    // request/credit meter, but unnecessary persistent log writes consume
    // storage and I/O.
    const waitSig = Object.keys(mergedResults).sort().join(",");
    if (state.lastPartialWaitSignature !== periodKey + "|" + waitSig) {
      state.lastPartialWaitSignature = periodKey + "|" + waitSig;
      saveState();
      log("PERIOD_WAIT", {
        periodKey,
        reason:"period_partial_waiting_for_all_assets",
        available:Object.keys(mergedResults),
        missing:ASSETS.filter(a => !mergedResults[a.key]).map(a => a.key),
        counts:state.counts,
        retry:true
      });
    }
    return;
  }

  // If a period is complete but Telegram was unavailable, retry it on every
  // 10-second cycle. Do not require another RTDS observation.
  const alertAttempt = state.periodAlerted?.[periodKey]?.attempts || 0;
  state.periodAlerted = state.periodAlerted || {};
  state.periodAlerted[periodKey] = {
    ...(state.periodAlerted[periodKey] || {}),
    attempts: alertAttempt + 1,
    lastAttemptAt: nowIso()
  };
  saveState();

  const nextStart = start;
  const top = state.leader;
  const nextSlug = top.asset.toLowerCase() + "-updown-5m-" + Math.floor(nextStart / 1000);

  log("PERIOD_READY_TO_ALERT", {
    periodKey, nextStart, leader:top, nextSlug,
    results:mergedResults, newResults, complete:newlyComplete, counts:state.counts
  });

  // The score must choose the current 5m market direction, but a missing Gamma
  // response must never block the Telegram alert.
  // The next market URL is deterministic from the selected asset and period.
  // Never replace it with Gamma's first/partial match: that can return a
  // different asset and produce a link that contradicts NEXT.
  const market = null;
  const link = "https://polymarket.com/event/" + nextSlug;

  // Telegram shows the cumulative result from August 14, not only the
  // just-closed 5m period. The same cumulative leader determines NEXT
  // and the Polymarket link.
  const cumulativeRanking = ranking();
  const cumulativeTop = cumulativeRanking[0];
  const cumulativeDirection = cumulativeTop.score >= 0 ? "UP" : "DOWN";
  const lines = [
    "5M CHAINLINK TWAP 60s",
    "CUMULATIVE FROM 14 AUGUST",
    "",
    ...cumulativeRanking.map(x => x.asset + ": " + (x.score >= 0 ? "+" : "") + x.score),
    "",
    "NEXT: " + cumulativeTop.asset + " " + cumulativeDirection,
    link
  ];

  const sent = await sendTelegram(lines.join("\n"), "PERIOD_ALERT");
  if (sent) {
    state.periodAlerted[periodKey] = {
      ...(state.periodAlerted[periodKey] || {}),
      sentAt: nowIso(),
      complete: newlyComplete,
      sent: true
    };
    saveState();
  }
  log("PERIOD_PROCESSED", {
    periodKey, results:mergedResults, newResults, complete:newlyComplete, counts:state.counts, leader:cumulativeTop, telegram:sent,
    source:"crypto_prices_twap_sixty_exact_boundary", marketSlug:nextSlug
  });
  snapshot("POST_PERIOD_" + periodKey);
}

async function poll() {
  if (!connected) connectRtds();
  try {
    await processClosedPeriod();
  } catch (e) {
    log("CYCLE_ERROR", { error:String(e.stack||e) });
  }
}

async function main() {
  ensureDir(STATE_FILE); ensureDir(LOG_FILE);
  state = loadState();

  if (state.version !== VERSION) {
    snapshot("PRE_VERSION_CHANGE");
    log("VERSION_CHANGE", { from:state.version||"unknown", to:VERSION });
    const keepHistory = !!state.historyBootstrap?.complete &&
      state.historyBootstrap.version === HISTORY_BOOTSTRAP_VERSION;
    state.version = VERSION;
    if (!keepHistory) {
      state.counts = Object.fromEntries(ASSETS.map(a => [a.key, 0]));
      state.periods = {};
      state.periodAlerted = {};
      state.leader = null;
      state.lastProcessedPeriod = null;
    }
    state.strategy = "CHAINLINK_HISTORY_PLUS_RTDs_LIVE";
    saveState();
  }

  log("MONITOR_STARTING", {
    version:VERSION, buildSha:BUILD_SHA, source:"Polymarket RTDS crypto_prices_twap_sixty",
    pollingMs:POLL_MS, windowSeconds:60, assets:ASSETS.map(a=>a.key),
    persistentState:true, postgres:false, strategy:"CHAINLINK_HISTORY_PLUS_RTDs_LIVE"
  });

  startHealth();

  historyReady = false;
  state.strategy = "CHAINLINK_HISTORY_PLUS_RTDs_LIVE";
  connectRtds();

  log("HISTORY_BOOTSTRAP_SCHEDULED", {
    source:"Chainlink Data Streams REST paginated TWAP60",
    from:new Date(HISTORY_START_MS).toISOString(),
    mode:"historical_baseline_required_before_cumulative_alert"
  });

  // Historical data is rebuilt/persisted separately from the live RTDS stream.
  // Health and RTDS stay online while the REST bootstrap runs.
  bootstrapHistoricalCounts()
    .then(ok => {
      historyReady = !!ok;
      log("HISTORY_BOOTSTRAP_RESULT", {
        complete:!!ok,
        counts:state.counts,
        periods:Object.keys(state.periods||{}).length
      });
      if (ok) poll().catch(e => log("POST_HISTORY_POLL_ERROR",{error:String(e.stack||e)}));
    })
    .catch(e => {
      historyReady = false;
      log("HISTORY_BOOTSTRAP_FATAL",{error:String(e.stack||e),retry:true});
    });

  await poll();
  setInterval(poll, POLL_MS);

  setInterval(() => log("HEARTBEAT", {
    websocket:connected, pollingMs:POLL_MS, collectionStartedAt,
    latest:Object.fromEntries(ASSETS.map(a=>[a.key,latest.get(a.key)||null])),
    lastProcessedPeriod:state.lastProcessedPeriod, leader:state.leader, counts:state.counts
  }), 60_000);
}

process.on("SIGTERM", () => { for (const t of heartbeatTimers.values()) clearInterval(t); for (const socket of sockets.values()) { try { socket.close(); } catch {} } process.exit(0); });
process.on("SIGINT", () => { for (const t of heartbeatTimers.values()) clearInterval(t); for (const socket of sockets.values()) { try { socket.close(); } catch {} } process.exit(0); });

main().catch(e => { log("FATAL", { error:String(e.stack||e) }); process.exit(1); });
