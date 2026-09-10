import { action } from "./_generated/server";
import { internal } from "./_generated/api";

const OWNER = "laudinvil";
const REPO = "Polymarket-Perps-Monitor";
const WORKFLOW = "monitor-health.yml";
const BRANCH = "main";
const GITHUB_API = "https://api.github.com";

export const ensureMonitorRunning = action({
  args: {},
  handler: async (ctx) => {
    const token = process.env.GITHUB_WORKFLOW_TOKEN;
    if (!token) {
      console.error("WATCHDOG: GITHUB_WORKFLOW_TOKEN is not configured");
      return { ok: false, action: "missing_token" };
    }

    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    };

    const refUrl = `${GITHUB_API}/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`;
    const refResponse = await fetch(refUrl, { headers });
    if (!refResponse.ok) {
      const body = await refResponse.text();
      throw new Error(`GitHub main ref lookup failed: ${refResponse.status} ${body.slice(0, 300)}`);
    }
    const ref = await refResponse.json();
    const mainSha = ref?.object?.sha;
    if (!mainSha) throw new Error("GitHub main ref lookup returned no SHA");

    const runsUrl = `${GITHUB_API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/runs?branch=${BRANCH}&per_page=20`;
    const runsResponse = await fetch(runsUrl, { headers });
    if (!runsResponse.ok) {
      const body = await runsResponse.text();
      throw new Error(`GitHub workflow lookup failed: ${runsResponse.status} ${body.slice(0, 300)}`);
    }

    const runs = await runsResponse.json();
    const active = (runs.workflow_runs || []).filter((run: any) =>
      run.status === "queued" || run.status === "in_progress" || run.status === "waiting" || run.status === "requested",
    );

    const health = await ctx.runQuery(internal.monitor.monitorHealth, {});
    const stale = active.filter((run: any) => run.head_sha !== mainSha);

    for (const run of stale) {
      const cancelUrl = `${GITHUB_API}/repos/${OWNER}/${REPO}/actions/runs/${run.id}/cancel`;
      const cancelResponse = await fetch(cancelUrl, { method: "POST", headers });
      if (!cancelResponse.ok && cancelResponse.status !== 409) {
        const body = await cancelResponse.text();
        throw new Error(`GitHub stale-run cancel failed for ${run.id}: ${cancelResponse.status} ${body.slice(0, 300)}`);
      }
      console.log(`WATCHDOG: cancelled stale run ${run.id}; head=${run.head_sha}; main=${mainSha}`);
    }

    const current = active.filter((run: any) => run.head_sha === mainSha);
    if (current.length > 0) {
      console.log(`WATCHDOG: current workflow run ${current[0].id} matches main=${mainSha}; health=${health.ok}; no dispatch`);
      return { ok: true, action: "already_running", runId: current[0].id, mainSha, health };
    }

    const dispatchUrl = `${GITHUB_API}/repos/${OWNER}/${REPO}/actions/workflows/${WORKFLOW}/dispatches`;
    const dispatchResponse = await fetch(dispatchUrl, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ ref: BRANCH }),
    });

    if (!dispatchResponse.ok) {
      const body = await dispatchResponse.text();
      throw new Error(`GitHub workflow dispatch failed: ${dispatchResponse.status} ${body.slice(0, 300)}`);
    }

    console.log(`WATCHDOG: dispatched ${WORKFLOW} on ${BRANCH}; main=${mainSha}; previous health=${health.ok} ageMs=${health.ageMs}`);
    return { ok: true, action: "dispatched", mainSha, health };
  },
});
