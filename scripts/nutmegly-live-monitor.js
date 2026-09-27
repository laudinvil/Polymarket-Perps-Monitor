import process from "node:process";
import { createServer } from "node:http";

const NUTMEGLY_URL = "https://nutmegly.com/";
const POLL_MS = 20_000;
const seen = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;

function clean(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function htmlToText(html) {
  return clean(html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&ndash;/gi, "–")
    .replace(/&mdash;/gi, "—"));
}

function parseLiveMatches(html) {
  const text = htmlToText(html);
  const out = [];
  const re = /LIVE\s+([^\n]{2,100}?)\s+(\d+)\s*[-–]\s*(\d+)\s+(\d{1,3})['’]\s+([^\n]{2,100}?)(?=\s+(?:UEFA|Premier League|La Liga|Serie A|Bundesliga|Ligue 1|Major League Soccer|MLS|Eredivisie|Primeira|Championship|League|Regular Season|[0-9]{2}:[0-9]{2})|$)/gi;
  for (const m of text.matchAll(re)) {
    const home = clean(m[1]);
    const scoreHome = Number(m[2]);
    const scoreAway = Number(m[3]);
    const minute = Number(m[4]);
    const away = clean(m[5]);
    if (!home || !away || home.length > 80 || away.length > 80) continue;
    out.push({home, away, scoreHome, scoreAway, minute});
  }

  // Fallback for the visible live-card structure when whitespace differs.
  const marker = "LIVE ";
  let pos = 0;
  while ((pos = text.indexOf(marker, pos)) !== -1) {
    const chunk = text.slice(pos, pos + 500);
    const sm = chunk.match(/^LIVE\s+(.{2,80}?)\s+(\d+)\s*[-–]\s*(\d+)\s+(\d{1,3})['’]\s+(.{2,80}?)(?:\s+(?:UEFA|Premier League|La Liga|Serie A|Bundesliga|Ligue 1|Major League Soccer|MLS|Eredivisie|Primeira|Championship|League)|$)/i);
    if (sm) {
      const item = {home:clean(sm[1]), away:clean(sm[5]), scoreHome:+sm[2], scoreAway:+sm[3], minute:+sm[4]};
      if (item.home && item.away && !out.some(x => x.home===item.home && x.away===item.away)) out.push(item);
    }
    pos += marker.length;
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
}

async function telegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:"POST",
    headers:{"content-type":"application/json"},
    body:JSON.stringify({chat_id:chatId,text,parse_mode:"HTML",disable_web_page_preview:true})
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${await r.text()}`);
}

async function poll() {
  const r = await fetch(NUTMEGLY_URL, {headers:{"user-agent":"Nutmegly-Live-Monitor/1.0"},signal:AbortSignal.timeout(10_000)});
  if (!r.ok) throw new Error(`Nutmegly HTTP ${r.status}`);
  const html = await r.text();
  const matches = parseLiveMatches(html);
  const now = Date.now();

  for (const [k,t] of seen) if (now-t > TTL_MS) seen.delete(k);

  for (const m of matches) {
    const key = `${m.home}|${m.away}`;
    if (seen.has(key)) continue;
    const msg = [
      "⚽ <b>LIVE FOUND</b>",
      "",
      `<b>${escapeHtml(m.home)} vs ${escapeHtml(m.away)}</b>`,
      "STATUS: LIVE",
      `MINUTE: ${m.minute}′`,
      `SCORE: ${m.scoreHome}–${m.scoreAway}`,
      "",
      "NUTMEGLY",
      NUTMEGLY_URL
    ].join("\n");
    await telegram(msg);
    seen.set(key, now);
  }
  console.log(JSON.stringify({ok:true,live:matches.length,matches}));
}

function startHealthServer() {
  const port = Number(process.env.PORT || 3000);
  createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, {"content-type":"application/json"});
      res.end(JSON.stringify({ok:true,service:"nutmegly-live-monitor"}));
      return;
    }
    res.writeHead(404); res.end("not found");
  }).listen(port, "0.0.0.0", () => console.log(`Health server listening on ${port}`));
}

async function main() {
  startHealthServer();
  console.log("Nutmegly LIVE monitor started");
  while (true) {
    try { await poll(); }
    catch (e) { console.error("POLL_ERROR", e?.stack || e); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
main();
