async function checkJson(url, label) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status}`);
  return data;
}

async function main() {
  const failures = [];
  const report = { time: new Date().toISOString(), checks: {} };

  if (!process.env.TELEGRAM_BOT_TOKEN) failures.push('TELEGRAM_BOT_TOKEN missing');
  if (!process.env.TELEGRAM_CHAT_ID) failures.push('TELEGRAM_CHAT_ID missing');
  report.checks.telegramSecrets = failures.length === 0;

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    try {
      const me = await checkJson(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getMe`, 'Telegram getMe');
      if (!me?.ok) throw new Error(me?.description || 'authentication failed');
      const chat = await checkJson(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(process.env.TELEGRAM_CHAT_ID)}`, 'Telegram getChat');
      if (!chat?.ok) throw new Error(chat?.description || 'chat lookup failed');
      report.checks.telegramApi = { ok: true, bot: me.result?.username || null, chatType: chat.result?.type || null };
    } catch (error) {
      report.checks.telegramApi = { ok: false, error: error.message };
      failures.push(error.message);
    }
  }

  try {
    const feed = await checkJson('https://marginpad.io/api/v1/feed', 'MarginPad feed');
    const events = Array.isArray(feed?.events) ? feed.events : Array.isArray(feed?.data?.events) ? feed.data.events : Array.isArray(feed?.data) ? feed.data : null;
    if (!events) throw new Error('MarginPad feed: invalid response shape');
    report.checks.marginpadFeed = { ok: true, events: events.length };
  } catch (error) {
    report.checks.marginpadFeed = { ok: false, error: error.message };
    failures.push(error.message);
  }

  const symbols = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB'];
  report.checks.symbolEndpoints = {};
  for (const symbol of symbols) {
    try {
      const data = await checkJson(`https://marginpad.io/api/v1/liquidations/live?symbol=${symbol}&limit=5`, `MarginPad ${symbol}`);
      const events = Array.isArray(data?.events) ? data.events : Array.isArray(data?.data?.events) ? data.data.events : Array.isArray(data?.data) ? data.data : null;
      if (!events) throw new Error('invalid response shape');
      report.checks.symbolEndpoints[symbol] = { ok: true, events: events.length };
    } catch (error) {
      report.checks.symbolEndpoints[symbol] = { ok: false, error: error.message };
      failures.push(`${symbol}: ${error.message}`);
    }
  }

  try {
    const nextEpoch = Math.floor(Date.now() / 300000) * 300 + 300;
    const slug = `btc-updown-5m-${nextEpoch}`;
    const market = await checkJson(`https://gamma-api.polymarket.com/markets/slug/${slug}`, 'Polymarket BTC market');
    report.checks.polymarket = { ok: !!market?.slug, slug: market?.slug || slug };
    if (!market?.slug) failures.push('Polymarket BTC next 5m market not found');
  } catch (error) {
    report.checks.polymarket = { ok: false, error: error.message };
    failures.push(error.message);
  }

  console.log(JSON.stringify(report, null, 2));
  if (failures.length) {
    console.error(`HEALTHCHECK FAILED: ${failures.join(' | ')}`);
    process.exit(1);
  }
  console.log('HEALTHCHECK OK');
}

main().catch((error) => {
  console.error(`HEALTHCHECK FAILED: ${error.message}`);
  process.exit(1);
});
