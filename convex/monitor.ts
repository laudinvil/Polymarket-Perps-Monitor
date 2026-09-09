import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

export const startRun = internalMutation({
  args: {
    runId: v.number(),
    githubRunId: v.string(),
    commitSha: v.string(),
    startedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("monitorRuns")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("monitorRuns", { ...args, lastHeartbeatAt: args.startedAt, status: "running" });
  },
});

export const heartbeat = internalMutation({
  args: { runId: v.number(), heartbeatAt: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("monitorRuns")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .unique();
    if (!existing || existing.status !== "running") return null;
    await ctx.db.patch(existing._id, { lastHeartbeatAt: args.heartbeatAt });
    return existing._id;
  },
});

export const finishRun = internalMutation({
  args: {
    runId: v.number(),
    finishedAt: v.number(),
    status: v.union(v.literal("completed"), v.literal("failed")),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("monitorRuns")
      .withIndex("by_run", (q) => q.eq("runId", args.runId))
      .unique();
    if (!existing) return null;
    await ctx.db.patch(existing._id, {
      finishedAt: args.finishedAt,
      status: args.status,
    });
    return existing._id;
  },
});

export const saveSnapshot = internalMutation({
  args: {
    runId: v.number(),
    timeframe: v.string(),
    symbol: v.string(),
    boundaryTs: v.number(),
    imbalanceUsd: v.number(),
    longUsd: v.number(),
    shortUsd: v.number(),
    longEvents: v.number(),
    shortEvents: v.number(),
    events: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("snapshots")
      .withIndex("by_timeframe_symbol_boundary", (q) =>
        q.eq("timeframe", args.timeframe)
          .eq("symbol", args.symbol)
          .eq("boundaryTs", args.boundaryTs),
      )
      .unique();
    if (existing) return existing._id;
    return await ctx.db.insert("snapshots", args);
  },
});

export const saveAlert = internalMutation({
  args: {
    runId: v.number(),
    timeframe: v.string(),
    symbol: v.string(),
    boundaryTs: v.number(),
    alertType: v.string(),
    previousImbalanceUsd: v.number(),
    newImbalanceUsd: v.number(),
    sentAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("alerts")
      .withIndex("by_symbol_timeframe_boundary", (q) =>
        q.eq("symbol", args.symbol)
          .eq("timeframe", args.timeframe)
          .eq("boundaryTs", args.boundaryTs),
      )
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("alerts", args);
  },
});

export const pruneOldData = internalMutation({
  args: {},
  returns: v.object({
    monitorRuns: v.number(),
    snapshots: v.number(),
    alerts: v.number(),
  }),
  handler: async (ctx) => {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    let monitorRuns = 0;
    let snapshots = 0;
    let alerts = 0;

    const oldRuns = await ctx.db
      .query("monitorRuns")
      .withIndex("by_started_at", (q) => q.lt("startedAt", cutoff))
      .order("asc")
      .take(500);
    for (const row of oldRuns) {
      await ctx.db.delete(row._id);
      monitorRuns += 1;
    }

    const oldSnapshots = await ctx.db
      .query("snapshots")
      .withIndex("by_boundary", (q) => q.lt("boundaryTs", cutoff))
      .order("asc")
      .take(500);
    for (const row of oldSnapshots) {
      await ctx.db.delete(row._id);
      snapshots += 1;
    }

    const oldAlerts = await ctx.db
      .query("alerts")
      .withIndex("by_sent_at", (q) => q.lt("sentAt", cutoff))
      .order("asc")
      .take(500);
    for (const row of oldAlerts) {
      await ctx.db.delete(row._id);
      alerts += 1;
    }

    return { monitorRuns, snapshots, alerts };
  },
});

export const monitorHealth = query({
  args: {},
  returns: v.object({ ok: v.boolean(), ageMs: v.number() }),
  handler: async (ctx) => {
    const latest = await ctx.db
      .query("monitorRuns")
      .withIndex("by_started_at")
      .order("desc")
      .take(1);
    const row = latest[0];
    if (!row) return { ok: false, ageMs: Number.MAX_SAFE_INTEGER };
    const heartbeatAt = row.lastHeartbeatAt ?? row.startedAt;
    const ageMs = Date.now() - heartbeatAt;
    return { ok: row.status === "running" && ageMs < 3 * 60 * 1000, ageMs };
  },
});

export const latestSnapshots = query({
  args: {
    timeframe: v.string(),
    symbol: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.symbol) {
      return await ctx.db
        .query("snapshots")
        .withIndex("by_timeframe_symbol_boundary", (q) =>
          q.eq("timeframe", args.timeframe).eq("symbol", args.symbol!),
        )
        .order("desc")
        .take(args.limit);
    }
    return await ctx.db
      .query("snapshots")
      .withIndex("by_timeframe_boundary", (q) =>
        q.eq("timeframe", args.timeframe),
      )
      .order("desc")
      .take(args.limit);
  },
});

export const latestStats = query({
  args: {
    timeframe: v.string(),
  },
  returns: v.array(
    v.object({
      timeframe: v.string(),
      symbol: v.string(),
      boundaryTs: v.number(),
      imbalanceUsd: v.number(),
      longUsd: v.number(),
      shortUsd: v.number(),
      longEvents: v.number(),
      shortEvents: v.number(),
      events: v.number(),
    }),
  ),
  handler: async (ctx, args) => {
    const symbols = ["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB", "HYPE"];
    const rows = [];
    for (const symbol of symbols) {
      const row = await ctx.db
        .query("snapshots")
        .withIndex("by_timeframe_symbol_boundary", (q) =>
          q.eq("timeframe", args.timeframe).eq("symbol", symbol),
        )
        .order("desc")
        .take(1);
      if (row[0]) {
        rows.push({
          timeframe: row[0].timeframe,
          symbol: row[0].symbol,
          boundaryTs: row[0].boundaryTs,
          imbalanceUsd: row[0].imbalanceUsd,
          longUsd: row[0].longUsd,
          shortUsd: row[0].shortUsd,
          longEvents: row[0].longEvents,
          shortEvents: row[0].shortEvents,
          events: row[0].events,
        });
      }
    }
    return rows;
  },
});
