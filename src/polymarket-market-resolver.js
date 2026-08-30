const CLOB_HOST = 'https://clob.polymarket.com';
const GAMMA_HOST = 'https://gamma-api.polymarket.com';

const json = async (url) => {
  const response = await fetch(url, { headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`Polymarket API ${response.status}: ${url}`);
  return response.json();
};

const normalize = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

function parseTokens(market) {
  const raw = market.tokens ?? market.clobTokenIds ?? market.token_ids ?? [];
  if (Array.isArray(raw)) {
    return raw.map((token) => ({
      tokenId: String(token.token_id ?? token.tokenId ?? token.id ?? token),
      outcome: String(token.outcome ?? token.name ?? '')
    })).filter((x) => x.tokenId);
  }
  if (typeof raw === 'string') {
    try { return parseTokens({ tokens: JSON.parse(raw) }); } catch { return []; }
  }
  return [];
}

function isOpen(market) {
  return market.active !== false && market.closed !== true && market.archived !== true && market.accepting_orders !== false;
}

function hasTimeWindow(market, startMs, endMs) {
  const start = Date.parse(market.startDate ?? market.start_date ?? market.startTime ?? '');
  const end = Date.parse(market.endDate ?? market.end_date ?? market.endTime ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return start <= startMs + 60000 && end >= endMs - 60000;
}

function scoreMarket(market, asset, period, startMs, endMs) {
  const text = normalize([
    market.question, market.title, market.slug, market.eventSlug,
    market.description, ...(market.outcomes ?? [])
  ].join(' '));
  const a = normalize(asset);
  const p = normalize(period);
  let score = 0;
  if (text.includes(a)) score += 10;
  if (text.includes(p)) score += 10;
  if (hasTimeWindow(market, startMs, endMs)) score += 100;
  if (market.accepting_orders === true) score += 20;
  return score;
}

export async function resolveNextMarket(asset, period, now = Date.now()) {
  const duration = period === '15M' ? 15 * 60 * 1000 : 5 * 60 * 1000;
  const startMs = Math.ceil(now / duration) * duration;
  const endMs = startMs + duration;

  const params = new URLSearchParams({ active: 'true', closed: 'false', limit: '100' });
  const data = await json(`${GAMMA_HOST}/markets?${params}`);
  const markets = Array.isArray(data) ? data : (data.data ?? []);
  const candidates = markets
    .filter(isOpen)
    .filter((market) => hasTimeWindow(market, startMs, endMs))
    .map((market) => ({ market, score: scoreMarket(market, asset, period, startMs, endMs) }))
    .filter((x) => x.score >= 100)
    .sort((a, b) => b.score - a.score);

  if (!candidates.length) throw new Error(`No open ${asset} ${period} market for ${new Date(startMs).toISOString()}`);

  const market = candidates[0].market;
  let tokens = parseTokens(market);
  if (tokens.length < 2 && market.conditionId) {
    const clob = await json(`${CLOB_HOST}/clob-markets/${encodeURIComponent(market.conditionId)}`);
    tokens = (clob.t ?? []).map((t) => ({ tokenId: String(t.t), outcome: String(t.o ?? '') }));
  }

  const up = tokens.find((t) => normalize(t.outcome) === 'up' || normalize(t.outcome) === 'yes') ?? tokens[0];
  const down = tokens.find((t) => normalize(t.outcome) === 'down' || normalize(t.outcome) === 'no') ?? tokens[1];
  if (!up?.tokenId || !down?.tokenId) throw new Error(`Market found but UP/DOWN token IDs are missing: ${market.conditionId ?? market.id}`);

  const [upBook, downBook] = await Promise.all([
    json(`${CLOB_HOST}/book?token_id=${encodeURIComponent(up.tokenId)}`),
    json(`${CLOB_HOST}/book?token_id=${encodeURIComponent(down.tokenId)}`)
  ]);

  return {
    asset,
    period,
    startMs,
    endMs,
    conditionId: market.conditionId ?? market.condition_id ?? null,
    slug: market.slug ?? null,
    question: market.question ?? market.title ?? null,
    upTokenId: up.tokenId,
    downTokenId: down.tokenId,
    upAsk: Number(upBook.asks?.[0]?.price ?? NaN),
    downAsk: Number(downBook.asks?.[0]?.price ?? NaN),
    upBook,
    downBook
  };
}

export async function getTokenAsk(tokenId) {
  const book = await json(`${CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`);
  return { price: Number(book.asks?.[0]?.price ?? NaN), book };
}
