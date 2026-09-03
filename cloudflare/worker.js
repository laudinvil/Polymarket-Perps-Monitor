const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';
const TELEGRAM_API = 'https://api.telegram.org';
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_MS = 5 * 60 * 1000;

function bucketStart(ts) {
  return Math.floor(Number(ts) / WINDOW_MS) * WINDOW_MS;
}

function normalizeTs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n < 1e12 ? n * 1000 : n;
}

function normalizeSymbol(symbol) {
  return String(symbol || '').toUpperCase().replace(/USDT$|USD$/i, '');
}

function extractEvents(json) {
  if (json && Array.isArray(json.events)) return json.events;
  if (json && json.data && Array.isArray(json.data.events)) return json.data.events;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}

function eventKey(event) {
  return [event.ts, event.exchange, event.symbol, event.side, event.price, event.qty, event.notional].join('|');
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function fetchEvents() {
  const feedJson = await fetchJson(FEED_URL);
  const all = [...extractEvents(feedJson)];

  const results = await Promise.allSettled(
    SYMBOLS.map(async (symbol) => {
      const json = await fetchJson(`${LIVE_URL}?symbol=${encodeURIComponent(symbol)}&limit=400`);
      return extractEvents(json);
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled') all.push(...result.value);
  }

  const unique = new Map();
  for (const event of all) unique.set(eventKey(event), event);
  return [...unique.values()];
}

function selectWinner(events, targetBucket) {
  const allowed = new Set(SYMBOLS);
  const rows = new Map();

  for (const event of events) {
    const ts = normalizeTs(event.ts);
    const symbol = normalizeSymbol(event.symbol);
    if (!ts || !allowed.has(symbol) || bucketStart(ts) !== targetBucket) continue;

    if (!rows.has(symbol)) {
      rows.set(symbol, {
        symbol,
        events: 0,
        longEvents: 0,
        shortEvents: 0,
        notionalUsd: 0,
        longNotionalUsd: 0,
        shortNotionalUsd: 0,
      });
    }

    const row = rows.get(symbol);
    const notional = Number(event.notional) || 0;
    const side = String(event.side || '').toLowerCase();
    row.events += 1;
    row.notionalUsd += notional;

    if (side.includes('long') || side === 'buy') {
      row.longEvents += 1;
      row.longNotionalUsd += notional;
    } else if (side.includes('short') || side === 'sell') {
      row.shortEvents += 1;
      row.shortNotionalUsd += notional;
    }
  }

  return [...rows.values()].sort((a, b) => b.notionalUsd - a.notionalUsd || b.events - a.events)[0] || null;
}

function formatUsd(value) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value || 0);
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    throw new Error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
  }

  const response = await fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: false,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(`Telegram HTTP ${response.status}: ${data.description || 'unknown error'}`);
  }
  return data.result;
}

async function processBucket(env, now = Date.now()) {
  const targetBucket = bucketStart(now) - WINDOW_MS;
  const bucketId = String(targetBucket);
  const lastBucket = await env.STATE.get('last_sent_bucket');

  if (lastBucket === bucketId) {
    return { ok: true, skipped: true, reason: 'already_sent', bucket: new Date(targetBucket).toISOString() };
  }

  const events = await fetchEvents();
  const winner = selectWinner(events, targetBucket);

  if (!winner || winner.notionalUsd <= 0) {
    await env.STATE.put('last_sent_bucket', bucketId);
    return { ok: true, skipped: true, reason: 'no_liquidations', bucket: new Date(targetBucket).toISOString() };
  }

  const dominant = winner.longNotionalUsd >= winner.shortNotionalUsd ? 'LONG liquidations' : 'SHORT liquidations';
  const text = [
    '🔥 5m Liquidation Leader',
    `${winner.symbol} — ${formatUsd(winner.notionalUsd)}`,
    `${dominant}: ${formatUsd(Math.max(winner.longNotionalUsd, winner.shortNotionalUsd))}`,
    `Events: ${winner.events}`,
    `Bucket: ${new Date(targetBucket).toISOString()}`,
  ].join('\n');

  const sent = await sendTelegram(env, text);
  await env.STATE.put('last_sent_bucket', bucketId);

  return {
    ok: true,
    sent: true,
    bucket: new Date(targetBucket).toISOString(),
    winner,
    telegramMessageId: sent && sent.message_id,
  };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      processBucket(env, controller.scheduledTime).then((result) => console.log(JSON.stringify(result))).catch((error) => {
        console.error(JSON.stringify({ ok: false, error: error.message }));
        throw error;
      }),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      const lastBucket = await env.STATE.get('last_sent_bucket');
      return Response.json({ ok: true, service: 'polymarket-perps-monitor', lastSentBucket: lastBucket });
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      try {
        return Response.json(await processBucket(env, Date.now()));
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }
    }

    return new Response('Polymarket Perps Monitor', { status: 200 });
  },
};
