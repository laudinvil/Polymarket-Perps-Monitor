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
    const recentLogs = await ctx.runQuery(internal.footballLogs.recentLogs, { limit: 50 });
    return Response.json({
      monitor: "polymarket-football-1-1",
      stats,
      recentLogs,
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
