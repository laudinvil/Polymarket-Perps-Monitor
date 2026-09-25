import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const MONITOR = "polymarket-football-1-1";

export const ingest = mutation({
  args: {
    logs: v.array(v.object({
      level: v.string(),
      event: v.string(),
      message: v.string(),
      data: v.optional(v.string()),
      createdAt: v.number(),
    })),
    tickCount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("footballStats")
      .withIndex("by_monitor", (q) => q.eq("monitor", MONITOR)).first();

    let candidates = 0, evaluations = 0, balanced = 0, marketMissing = 0;
    let unresolved = 0, buyAlerts = 0, sellAlerts = 0, errors = 0;

    for (const item of args.logs) {
      await ctx.db.insert("footballLogs", {
        monitor: MONITOR, level: item.level, event: item.event,
        message: item.message, data: item.data, createdAt: item.createdAt,
      });
      candidates += item.event === "candidate_match_found" ? 1 : 0;
      evaluations += item.event === "one_one_evaluation" ? 1 : 0;
      marketMissing += item.event === "one_one_market_missing" ? 1 : 0;
      unresolved += item.event === "match_unresolved" ? 1 : 0;
      buyAlerts += item.event === "one_one_buy_alert_sent" ? 1 : 0;
      sellAlerts += item.event === "one_one_sell_alert_sent" ? 1 : 0;
      errors += item.event === "discovery_failed" ? 1 : 0;
      if (item.event === "one_one_evaluation" && item.data) {
        try { if (JSON.parse(item.data).balanced === true) balanced += 1; } catch {}
      }
    }

    const patch = {
      ticks: (existing?.ticks ?? 0) + (args.tickCount ?? 0),
      candidates: (existing?.candidates ?? 0) + candidates,
      evaluations: (existing?.evaluations ?? 0) + evaluations,
      balanced: (existing?.balanced ?? 0) + balanced,
      marketMissing: (existing?.marketMissing ?? 0) + marketMissing,
      unresolved: (existing?.unresolved ?? 0) + unresolved,
      buyAlerts: (existing?.buyAlerts ?? 0) + buyAlerts,
      sellAlerts: (existing?.sellAlerts ?? 0) + sellAlerts,
      errors: (existing?.errors ?? 0) + errors,
      updatedAt: now,
    };

    if (existing) await ctx.db.patch(existing._id, patch);
    else await ctx.db.insert("footballStats", { monitor: MONITOR, ...patch });
    return null;
  },
});

export const stats = query({
  args: {},
  returns: v.union(
    v.object({
      monitor: v.string(), ticks: v.number(), candidates: v.number(),
      evaluations: v.number(), balanced: v.number(), marketMissing: v.number(),
      unresolved: v.number(), buyAlerts: v.number(), sellAlerts: v.number(),
      errors: v.number(), updatedAt: v.number(),
    }), v.null(),
  ),
  handler: async (ctx) => await ctx.db.query("footballStats")
    .withIndex("by_monitor", (q) => q.eq("monitor", MONITOR)).first(),
});

export const recentLogs = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object({
    _id: v.id("footballLogs"), _creationTime: v.number(),
    level: v.string(), event: v.string(), message: v.string(),
    data: v.optional(v.string()), createdAt: v.number(),
  })),
  handler: async (ctx, args) => await ctx.db.query("footballLogs")
    .withIndex("by_monitor_time", (q) => q.eq("monitor", MONITOR))
    .order("desc").take(Math.min(args.limit ?? 100, 500)),
});
