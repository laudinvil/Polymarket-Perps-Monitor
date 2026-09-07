const DEFAULT_HTTP_TIMEOUT_MS = 8000;

const originalFetch = globalThis.fetch;
if (typeof originalFetch === 'function' && !originalFetch.__polymarketTimeout) {
  const wrappedFetch = async (input, options = {}) => {
    if (options.signal) return originalFetch(input, options);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEFAULT_HTTP_TIMEOUT_MS);
    try {
      return await originalFetch(input, { ...options, signal: controller.signal });
    } catch (error) {
      if (error?.name === 'AbortError') {
        const url = typeof input === 'string' ? input : input?.url || 'unknown-url';
        throw new Error(`HTTP timeout after ${DEFAULT_HTTP_TIMEOUT_MS}ms: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  wrappedFetch.__polymarketTimeout = true;
  globalThis.fetch = wrappedFetch;
  console.log(`HTTP TIMEOUT GUARD enabled: ${DEFAULT_HTTP_TIMEOUT_MS}ms`);
}
