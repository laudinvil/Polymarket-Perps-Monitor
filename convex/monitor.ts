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
    return await ctx.db.insert("monitorRuns", { ...args, status: "running" });
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
