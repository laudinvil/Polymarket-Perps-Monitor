const ALLOWED_HOSTS = new Set([
  'fapi.binance.com','fapi1.binance.com','fapi2.binance.com','fapi3.binance.com','fapi4.binance.com',
  'api.bybit.com','api.bytick.com','api.bybit.eu','api.bybit.nl','api.bybit.tr','api.bybit.kz','api.bybit.ae','api.bybit.id'
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/fetch') return new Response('Not found', {status:404});
    if (request.method !== 'GET') return new Response('Method not allowed', {status:405});
    const auth = request.headers.get('authorization') || '';
    if (!env.OI_PROXY_TOKEN || auth !== `Bearer ${env.OI_PROXY_TOKEN}`) return new Response('Unauthorized', {status:401});
    const target = url.searchParams.get('url');
    if (!target) return new Response('Missing url', {status:400});
    let targetUrl;
    try { targetUrl = new URL(target); } catch { return new Response('Invalid url', {status:400}); }
    if (targetUrl.protocol !== 'https:' || !ALLOWED_HOSTS.has(targetUrl.hostname)) return new Response('Host not allowed', {status:403});
    const upstream = await fetch(targetUrl.toString(), {method:'GET', headers:{accept:'application/json'}});
    const body = await upstream.text();
    return new Response(body, {status:upstream.status, headers:{'content-type':upstream.headers.get('content-type') || 'application/json','cache-control':'no-store'}});
  }
};