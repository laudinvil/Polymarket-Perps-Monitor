import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/football/logs",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    await ctx.runMutation(internal.footballLogs.ingest, {
      logs: Array.isArray(body.logs) ? body.logs : [],
      tickCount: typeof body.tickCount === "number" ? body.tickCount : 0,
    });
    return new Response("ok", { status: 200 });
  }),
});

http.route({
  path: "/football/release",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const monitor = typeof body.monitor === "string" ? body.monitor : "polymarket-football-1-1";
    const marketSlug = typeof body.marketSlug === "string" ? body.marketSlug : "";
    if (!marketSlug) return new Response("missing marketSlug", { status: 400 });
    await ctx.runMutation(internal.footballLogs.releaseTelegramAlert, { monitor, marketSlug });
    return new Response("released", { status: 200 });
  }),
});

http.route({
  path: "/football/status",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const stats = await ctx.runQuery(internal.footballLogs.stats, {});
    const recentLogs = await ctx.runQuery(internal.footballLogs.recentLogs, { limit: 500 });
    return Response.json({
      monitor: "polymarket-football-1-1",
      status: "ok",
      stats,
      recentLogs,
    });
  }),
});

http.route({
  path: "/football/health",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const stats = await ctx.runQuery(internal.footballLogs.stats, {});
    return Response.json({
      status: "ok",
      monitor: "polymarket-football-1-1",
      updatedAt: stats?.updatedAt ?? null,
      ticks: stats?.ticks ?? 0,
      candidates: stats?.candidates ?? 0,
      evaluations: stats?.evaluations ?? 0,
      balanced: stats?.balanced ?? 0,
      marketMissing: stats?.marketMissing ?? 0,
      unresolved: stats?.unresolved ?? 0,
      buyAlerts: stats?.buyAlerts ?? 0,
      sellAlerts: stats?.sellAlerts ?? 0,
      errors: stats?.errors ?? 0,
    });
  }),
});

http.route({
  path: "/football/claim",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const monitor = typeof body.monitor === "string" ? body.monitor : "polymarket-football-1-1";
    const marketSlug = typeof body.marketSlug === "string" ? body.marketSlug : "";
    if (!marketSlug) return new Response("missing marketSlug", { status: 400 });
    const claimed = await ctx.runMutation(internal.footballLogs.claimTelegramAlert, { monitor, marketSlug });
    return new Response(claimed ? "claimed" : "already_claimed", { status: claimed ? 200 : 409 });
  }),
});

export default http;
