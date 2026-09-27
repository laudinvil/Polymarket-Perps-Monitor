import { chromium } from "playwright";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_MS = Number(process.env.POLL_MS || 20000);

if (!TOKEN || !CHAT_ID) throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID");

const SOURCE = "https://polymarket.com/ru/sports/soccer/games";
const seen = new Set();

async function sendTelegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({chat_id: CHAT_ID, text, disable_web_page_preview:false})
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${await r.text()}`);
}

function clean(s) {
  return s.replace(/\\s+/g, " ").trim();
}

async function scan(page) {
  await page.goto(SOURCE, {waitUntil:"domcontentloaded", timeout:30000});
  await page.waitForTimeout(3000);

  const cards = await page.locator('a[href*="/sports/soccer/games/"]').evaluateAll(as =>
    as.map(a => ({
      href: a.href,
      text: (a.innerText || "").replace(/\\s+/g, " ").trim()
    }))
  );

  const live = [];
  for (const card of cards) {
    if (/\\bLIVE\\b/i.test(card.text)) {
      live.push(card);
    }
  }

  console.log(`SCAN: cards=${cards.length} live=${live.length}`);

  for (const item of live) {
    if (seen.has(item.href)) continue;
    seen.add(item.href);

    const title = clean(item.text.replace(/\\bLIVE\\b/ig, ""));
    const message = `⚽ LIVE FOUND\\n\\n${title}\\n\\n${item.href}`;
    console.log("NEW LIVE:", item.href);
    await sendTelegram(message);
    console.log("TELEGRAM SENT:", item.href);
  }

  // Keep memory bounded while retaining current deduplication.
  if (seen.size > 5000) {
    const keep = [...seen].slice(-2500);
    seen.clear();
    for (const x of keep) seen.add(x);
  }
}

const browser = await chromium.launch({headless:true});
const page = await browser.newPage({locale:"ru-RU"});

process.on("SIGTERM", async () => { await browser.close(); process.exit(0); });
process.on("SIGINT", async () => { await browser.close(); process.exit(0); });

while (true) {
  try {
    await scan(page);
  } catch (e) {
    console.error("SCAN ERROR:", e.message);
  }
  await new Promise(r => setTimeout(r, POLL_MS));
}
