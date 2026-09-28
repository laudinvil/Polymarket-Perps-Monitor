const http = require("http");
const fs = require("fs");

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.DEDUPE_SECRET || "";
const STATE_FILE = process.env.DEDUPE_STATE_FILE || "/data/marginpad-dedupe.json";
const MAX_KEYS = 20000;

function ensureStateDir() {
  fs.mkdirSync(require("path").dirname(STATE_FILE), { recursive: true });
}

function load() {
  try {
    const v = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    if (v && typeof v === "object" && v.keys && typeof v.keys === "object") return v;
  } catch {}
  return { version: 1, keys: {} };
}

let state = load();

function save() {
  ensureStateDir();
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, STATE_FILE);
}

function authorized(req) {
  if (!SECRET) return true;
  return req.headers.authorization === "Bearer " + SECRET;
}

function prune(now) {
  for (const [key, expiresAt] of Object.entries(state.keys)) {
    if (Number(expiresAt) <= now) delete state.keys[key];
  }
  const entries = Object.entries(state.keys);
  if (entries.length > MAX_KEYS) {
    entries.sort((a, b) => Number(a[1]) - Number(b[1]));
    for (const [key] of entries.slice(0, entries.length - MAX_KEYS)) delete state.keys[key];
  }
}

const server = http.createServer((req, res) => {
  const p = new URL(req.url || "/", "http://127.0.0.1").pathname;

  if (p === "/health") {
    res.writeHead(200, {"content-type":"application/json"});
    return res.end(JSON.stringify({status:"ok", keys:Object.keys(state.keys).length}));
  }

  if (p !== "/claim" || req.method !== "POST") {
    res.writeHead(404);
    return res.end();
  }

  if (!authorized(req)) {
    res.writeHead(401, {"content-type":"application/json"});
    return res.end(JSON.stringify({ok:false,error:"unauthorized"}));
  }

  let body = "";
  req.on("data", chunk => {
    body += chunk;
    if (body.length > 10000) req.destroy();
  });
  req.on("end", () => {
    try {
      const input = JSON.parse(body || "{}");
      const key = String(input.key || "");
      const ttl = Math.max(10, Math.min(600, Number(input.ttlSeconds || 120)));
      if (!key) {
        res.writeHead(400, {"content-type":"application/json"});
        return res.end(JSON.stringify({ok:false,error:"missing_key"}));
      }

      const now = Date.now();
      prune(now);

      if (state.keys[key] && Number(state.keys[key]) > now) {
        res.writeHead(200, {"content-type":"application/json"});
        return res.end(JSON.stringify({ok:true,claimed:false}));
      }

      state.keys[key] = now + ttl * 1000;
      save();

      res.writeHead(200, {"content-type":"application/json"});
      return res.end(JSON.stringify({ok:true,claimed:true}));
    } catch (e) {
      res.writeHead(400, {"content-type":"application/json"});
      return res.end(JSON.stringify({ok:false,error:"invalid_json"}));
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(JSON.stringify({event:"DEDUPE_SERVER_READY",port:PORT,stateFile:STATE_FILE}));
});
