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
  path: "/football/candidates",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const rows = await ctx.runQuery(internal.footballLogs.admittedCandidates, {});
    return Response.json(rows);
  }),
});

http.route({
  path: "/football/candidates/admit",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const key = typeof body.key === "string" ? body.key : "";
    const data = typeof body.data === "string" ? body.data : "";
    if (!key || !data) return new Response("missing key/data", { status: 400 });
    await ctx.runMutation(internal.footballLogs.admitCandidate, { key, data });
    return new Response("admitted", { status: 200 });
  }),
});

http.route({
  path: "/football/candidates/mark-buy",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const key = typeof body.key === "string" ? body.key : "";
    const buyOneOnePrice = Number(body.buyOneOnePrice);
    if (!key || !Number.isFinite(buyOneOnePrice)) return new Response("invalid key/price", { status: 400 });
    await ctx.runMutation(internal.footballLogs.markCandidateBuySent, { key, buyOneOnePrice });
    return new Response("marked", { status: 200 });
  }),
});

http.route({
  path: "/football/candidates/mark-started",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const key = typeof body.key === "string" ? body.key : "";
    if (!key) return new Response("missing key", { status: 400 });
    await ctx.runMutation(internal.footballLogs.markCandidateStartedSent, { key });
    return new Response("marked", { status: 200 });
  }),
});

http.route({
  path: "/football/candidates/mark-sell",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const key = typeof body.key === "string" ? body.key : "";
    if (!key) return new Response("missing key", { status: 400 });
    await ctx.runMutation(internal.footballLogs.markCandidateSellSent, { key });
    return new Response("marked", { status: 200 });
  }),
});

http.route({
  path: "/football/release",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const monitor = typeof body.monitor === "string" ? body.monitor : "polymarket-football";
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
    return Response.json({ monitor: "polymarket-football", status: "ok", stats, recentLogs });
  }),
});

http.route({
  path: "/football/health",
  method: "GET",
  handler: httpAction(async (ctx) => {
    const stats = await ctx.runQuery(internal.footballLogs.stats, {});
    return Response.json({
      status: "ok", monitor: "polymarket-football",
      updatedAt: stats?.updatedAt ?? null, ticks: stats?.ticks ?? 0,
      candidates: stats?.candidates ?? 0, evaluations: stats?.evaluations ?? 0,
      balanced: stats?.balanced ?? 0, marketMissing: stats?.marketMissing ?? 0,
      unresolved: stats?.unresolved ?? 0, buyAlerts: stats?.buyAlerts ?? 0,
      sellAlerts: stats?.sellAlerts ?? 0, errors: stats?.errors ?? 0,
    });
  }),
});

http.route({
  path: "/football/claim",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const monitor = typeof body.monitor === "string" ? body.monitor : "polymarket-football";
    const marketSlug = typeof body.marketSlug === "string" ? body.marketSlug : "";
    if (!marketSlug) return new Response("missing marketSlug", { status: 400 });
    const result = await ctx.runMutation(internal.footballLogs.claimTelegramAlert, { monitor, marketSlug });
    return Response.json(result, { status: result.claimed ? 200 : 409 });
  }),
});

http.route({
  path: "/football/telegram-message",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    const monitor = typeof body.monitor === "string" ? body.monitor : "polymarket-football";
    const marketSlug = typeof body.marketSlug === "string" ? body.marketSlug : "";
    const messageId = Number(body.messageId);
    if (!marketSlug || !Number.isInteger(messageId)) return new Response("invalid request", { status: 400 });
    await ctx.runMutation(internal.footballLogs.saveTelegramMessageId, { monitor, marketSlug, messageId });
    return new Response("saved", { status: 200 });
  }),
});

http.route({
  path: "/football/telegram-message",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const monitor = url.searchParams.get("monitor") || "polymarket-football";
    const marketSlug = url.searchParams.get("marketSlug") || "";
    if (!marketSlug) return new Response("missing marketSlug", { status: 400 });
    const row = await ctx.runQuery(internal.footballLogs.telegramMessage, { monitor, marketSlug });
    return Response.json({ messageId: row?.telegramMessageId ?? null });
  }),
});

export default http;

// trigger: run monitor after candidate persistence route fix