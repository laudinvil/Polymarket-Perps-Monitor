import http from "node:http";
import { chromium } from "playwright";

const PORT = Number(process.env.PORT || 3000);
const PAGE = "https://polymarket.com/sports/soccer/games";
const INTERVAL = 15000;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

let lastPoll = null;
let lastError = null;
let liveCount = 0;
let alertsSent = 0;
const seen = new Set();

async function telegram(text) {
  if (!TOKEN || !CHAT_ID) throw new Error("Telegram env vars missing");
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({chat_id: CHAT_ID, text, disable_web_page_preview: true})
  });
  if (!r.ok) throw new Error("Telegram HTTP " + r.status);
}

function clean(s) {
  return String(s || "").replace(/\\s+/g, " ").trim();
}

async function scan(page) {
  await page.goto(PAGE, {waitUntil:"domcontentloaded", timeout:20000});
  await page.waitForTimeout(2500);

  const cards = await page.locator("a[href]").evaluateAll(links => links.map(a => ({
    href: a.href,
    text: (a.innerText || a.textContent || "").replace(/\\s+/g," ").trim()
  })).filter(x => x.text && /\\bLIVE\\b/i.test(x.text)));

  const unique = [];
  const used = new Set();
  for (const c of cards) {
    if (!used.has(c.href)) {
      used.add(c.href);
      unique.push(c);
    }
  }

  liveCount = unique.length;

  for (const c of unique) {
    if (seen.has(c.href)) continue;
    seen.add(c.href);

    const lines = c.text.split(/\\s{2,}|(?=LIVE\\b)/i).map(clean).filter(Boolean);
    const title = lines.find(x => / vs /i.test(x)) || c.text.replace(/\\bLIVE\\b/ig,"").trim();
    const url = c.href;

    const message = `⚽ LIVE FOUND\\n\\n${title}\\nLIVE\\n\\n${url}`;
    try {
      await telegram(message);
      alertsSent++;
      console.log("ALERT SENT", title, url);
    } catch (e) {
      console.log("TELEGRAM ERROR", e.message || e);
      lastError = String(e.message || e);
    }
  }
}

let browser;
let page;

async function poll() {
  try {
    lastPoll = new Date().toISOString();
    if (!browser) {
      browser = await chromium.launch({headless:true, args:["--no-sandbox","--disable-dev-shm-usage"]});
      page = await browser.newPage({viewport:{width:1280,height:900}});
    }
    await scan(page);
    lastError = null;
    console.log("POLL OK", new Date().toISOString(), "LIVE", liveCount);
  } catch (e) {
    lastError = String(e.message || e);
    console.log("POLL ERROR", lastError);
  }
}

const server = http.createServer((req,res) => {
  res.writeHead(200, {"content-type":"application/json"});
  res.end(JSON.stringify({
    ok:true,
    service:"polymarket-live-soccer-monitor",
    source:PAGE,
    lastPoll,
    liveCount,
    alertsSent,
    lastError
  }));
});
server.listen(PORT,"0.0.0.0",()=>console.log("HEALTH LISTENING",PORT));

console.log("MONITOR STARTING");
console.log("SOURCE", PAGE);
poll();
setInterval(poll, INTERVAL);
