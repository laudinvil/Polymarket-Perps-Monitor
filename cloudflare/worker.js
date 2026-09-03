const FEED_URL = 'https://marginpad.io/api/v1/feed';
const LIVE_URL = 'https://marginpad.io/api/v1/liquidations/live';
const TELEGRAM_API = 'https://api.telegram.org';
const SYMBOLS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'HYPE'];
const WINDOW_MS = 5 * 60 * 1000;
const SENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
  if (json?.data && Array.isArray(json.data.events)) return json.data.events;
  if (json && Array.isArray(json.data)) return json.data;
  return [];
}

function eventKey(event) {
  return [event.ts, event.exchange, event.symbol, event.side, event.price, event.qty, event.notional].join('|');
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

async function fetchEvents() {
  const feed = await fetchJson(FEED_URL);
  const all = [...extractEvents(feed)];

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
  const rows = new Map();
  const allowed = new Set(SYMBOLS);

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
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value || 0);
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
    signal: AbortSignal.timeout(10000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok !== true) {
    throw new Error(`Telegram HTTP ${response.status}: ${data.description || 'unknown error'}`);
  }
  return data.result;
}

function getMonitor(env) {
  return env.MONITOR.get(env.MONITOR.idFromName('global'));
}

export class MonitorState {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async cleanup(now) {
    const index = (await this.ctx.storage.get('sent_index')) || [];
    const cutoff = now - SENT_TTL_MS;
    const keep = [];
    for (const bucketId of index) {
      if (Number(bucketId) >= cutoff) keep.push(bucketId);
      else await this.ctx.storage.delete(`sent:${bucketId}`);
    }
    if (keep.length !== index.length) await this.ctx.storage.put('sent_index', keep);
  }

  async process(now) {
    const target = bucketStart(now) - WINDOW_MS;
    const bucketId = String(target);
    const sentKey = `sent:${bucketId}`;

    const existing = await this.ctx.storage.get(sentKey);
    if (existing) {
      return { ok: true, skipped: true, reason: 'already_processed', bucket: new Date(target).toISOString(), existing };
    }

    const events = await fetchEvents();
    const winner = selectWinner(events, target);

    if (!winner || winner.notionalUsd <= 0) {
      await this.ctx.storage.put(sentKey, { result: 'no_liquidations', at: Date.now() });
      const index = (await this.ctx.storage.get('sent_index')) || [];
      if (!index.includes(bucketId)) await this.ctx.storage.put('sent_index', [...index, bucketId]);
      await this.ctx.storage.put('last_result', { ok: true, skipped: true, reason: 'no_liquidations', bucket: new Date(target).toISOString(), at: Date.now() });
      await this.cleanup(now);
      return { ok: true, skipped: true, reason: 'no_liquidations', bucket: new Date(target).toISOString() };
    }

    const dominant = winner.longNotionalUsd >= winner.shortNotionalUsd ? 'LONG liquidations' : 'SHORT liquidations';
    const text = [
      '🔥 5m Liquidation Leader',
      `${winner.symbol} — ${formatUsd(winner.notionalUsd)}`,
      `${dominant}: ${formatUsd(Math.max(winner.longNotionalUsd, winner.shortNotionalUsd))}`,
      `Events: ${winner.events}`,
      `Bucket: ${new Date(target).toISOString()}`,
    ].join('\n');

    const sent = await sendTelegram(this.env, text);
    const record = { result: 'sent', messageId: sent?.message_id || null, at: Date.now() };
    await this.ctx.storage.put(sentKey, record);
    const index = (await this.ctx.storage.get('sent_index')) || [];
    if (!index.includes(bucketId)) await this.ctx.storage.put('sent_index', [...index, bucketId]);

    const result = {
      ok: true,
      sent: true,
      bucket: new Date(target).toISOString(),
      winner,
      telegramMessageId: sent?.message_id || null,
    };
    await this.ctx.storage.put('last_result', { ...result, at: Date.now() });
    await this.cleanup(now);
    return result;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({
        ok: true,
        service: 'polymarket-perps-monitor',
        lastResult: (await this.ctx.storage.get('last_result')) || null,
      });
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      const body = await request.json().catch(() => ({}));
      try {
        return Response.json(await this.process(Number(body.now) || Date.now()));
      } catch (error) {
        const failure = { ok: false, error: error.message, at: Date.now() };
        await this.ctx.storage.put('last_result', failure);
        return Response.json(failure, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  }
}

async function runThroughDurableObject(env, now) {
  const response = await getMonitor(env).fetch('https://monitor/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ now }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Monitor HTTP ${response.status}`);
  return result;
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runThroughDurableObject(env, controller.scheduledTime)
        .then((result) => console.log(JSON.stringify(result)))
        .catch((error) => console.error(JSON.stringify({ ok: false, error: error.message }))),
    );
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return getMonitor(env).fetch('https://monitor/health');
    }

    if (url.pathname === '/run' && request.method === 'POST') {
      try {
        return Response.json(await runThroughDurableObject(env, Date.now()));
      } catch (error) {
        return Response.json({ ok: false, error: error.message }, { status: 500 });
      }
    }

    return new Response('Polymarket Perps Monitor', { status: 200 });
  },
};
