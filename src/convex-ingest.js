const DEFAULT_TIMEOUT_MS = 10000;

function getConfig() {
  const baseUrl = String(process.env.CONVEX_URL || '').trim().replace(/\/$/, '');
  const token = String(process.env.CONVEX_INGEST_TOKEN || '').trim();
  return { baseUrl, token };
}

async function postConvex(type, data) {
  const { baseUrl, token } = getConfig();
  if (!baseUrl || !token) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ type, data }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.warn(`CONVEX ${type} FAILED: ${response.status}${text ? ` ${text}` : ''}`);
      return false;
    }

    return true;
  } catch (error) {
    console.warn(`CONVEX ${type} FAILED: ${error?.message || error}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function startRun(data) {
  return postConvex('run.start', data);
}

async function finishRun(data) {
  return postConvex('run.finish', data);
}

async function saveSnapshot(data) {
  return postConvex('snapshot', data);
}

async function saveAlert(data) {
  return postConvex('alert', data);
}

module.exports = { startRun, finishRun, saveSnapshot, saveAlert };
