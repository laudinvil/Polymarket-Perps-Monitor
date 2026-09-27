import { chromium } from "playwright";
import http from "node:http";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_MS = Number(process.env.POLL_MS || 15000);
const PORT = Number(process.env.PORT || 3000);
const SOURCE = "https://polymarket.com/ru/sports/soccer/games";

const seen = new Set();
let status = { startedAt: new Date().toISOString(), scans: 0, live: 0, lastError: null };

const server = http.createServer((req, res) => {
  res.writeHead(200, {"content-type":"application/json"});
  res.end(JSON.stringify({ok:true, service:"polymarket-live-soccer-monitor", ...status}));
});
server.listen(PORT, "0.0.0.0", () => console.log("HTTP HEALTH LISTENING:", PORT));

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) {
    console.error("TELEGRAM CONFIG MISSING: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");
    return;
  }
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({chat_id: CHAT_ID, text, disable_web_page_preview:false})
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${await r.text()}`);
}

function clean(s) {
  return s.replace(/\s+/g, " ").trim();
}

async function scan(page) {
  await page.goto(SOURCE, {waitUntil:"domcontentloaded", timeout:30000});
  await page.waitForTimeout(3000);

  const cards = await page.locator('a[href*="/sports/soccer/games/"]').evaluateAll(as =>
    as.map(a => ({
      href: a.href,
      text: (a.innerText || "").replace(/\s+/g, " ").trim()
    }))
  );

  const live = cards.filter(card => /\bLIVE\b/i.test(card.text));
  status = {...status, scans: status.scans + 1, live: live.length, lastError: null};
  console.log(`SCAN: cards=${cards.length} live=${live.length}`);

  for (const item of live) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);
    const title = clean(item.text.replace(/\bLIVE\b/ig, ""));
    console.log("NEW LIVE:", item.href);
    await sendTelegram(`⚽ LIVE FOUND\n\n${title}\n\n${item.href}`);
    console.log("TELEGRAM SENT:", item.href);
  }

  if (seen.size > 5000) {
    const keep = [...seen].slice(-2500);
    seen.clear();
    for (const x of keep) seen.add(x);
  }
}

async function main() {
  console.log("MONITOR STARTING");
  console.log("SOURCE:", SOURCE);
  console.log("POLL_MS:", POLL_MS);
  console.log("TELEGRAM CONFIG:", TOKEN ? "TOKEN=SET" : "TOKEN=MISSING", CHAT_ID ? "CHAT_ID=SET" : "CHAT_ID=MISSING");

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage({locale:"ru-RU"});

    while (true) {
      try {
        await scan(page);
      } catch (e) {
        status = {...status, lastError: e?.stack || String(e)};
        console.error("SCAN ERROR:", e?.stack || e);
      }
      await new Promise(r => setTimeout(r, POLL_MS));
    }
  } catch (e) {
    status = {...status, lastError: e?.stack || String(e)};
    console.error("FATAL:", e?.stack || e);
    await new Promise(r => setTimeout(r, 60000));
  }
}

process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT", () => { server.close(); process.exit(0); });

main();
