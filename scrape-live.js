import { chromium } from "playwright";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
if (!TOKEN || !CHAT_ID) throw new Error("Missing Telegram secrets");

const URL = "https://polymarket.com/ru/sports/soccer/games";

async function telegram(text) {
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
    method: "POST",
    headers: {"content-type":"application/json"},
    body: JSON.stringify({chat_id: CHAT_ID, text, disable_web_page_preview:false})
  });
  if (!r.ok) throw new Error(`Telegram HTTP ${r.status}: ${await r.text()}`);
}

const browser = await chromium.launch({headless:true});
const page = await browser.newPage({locale:"ru-RU"});
await page.goto(URL, {waitUntil:"domcontentloaded", timeout:30000});
await page.waitForTimeout(5000);

const matches = await page.locator('a[href*="/sports/soccer/games"]').evaluateAll(anchors =>
  anchors.map(a => ({
    href: a.href,
    text: (a.innerText || "").replace(/\\s+/g, " ").trim()
  })).filter(x => /\\bLIVE\\b/i.test(x.text))
);

console.log("LIVE CARDS:", JSON.stringify(matches, null, 2));
const bodyText = await page.locator("body").innerText();
console.log("PAGE_HAS_LIVE:", /\\bLIVE\\b/i.test(bodyText));
console.log("LIVE_CONTEXT:", bodyText.split("\\n").filter(x => /\\bLIVE\\b/i.test(x)).slice(0,20));

for (const m of matches) {
  const text = m.text;
  const title = text
    .replace(/LIVE/ig, "")
    .replace(/\\s+/g, " ")
    .trim();

  await telegram(`⚽ LIVE FOUND\\n\\n${title}\\n\\n${m.href}`);
  console.log("TELEGRAM SENT:", m.href);
}

await browser.close();
console.log(`TEST FINISHED. LIVE MATCHES: ${matches.length}`);
process.exit(matches.length ? 0 : 2);
