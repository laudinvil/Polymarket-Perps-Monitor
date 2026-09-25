import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const MONITOR = "btc-5m-oi";

export const get = query({
  args: {},
  returns: v.object({
    lastAlertDirection: v.union(v.literal("BUY UP"), v.literal("BUY DOWN"), v.null()),
  }),
  handler: async (ctx) => {
    const row = await ctx.db
      .query("monitorState")
      .withIndex("by_monitor", (q) => q.eq("monitor", MONITOR))
      .first();

    return { lastAlertDirection: row?.lastAlertDirection ?? null };
  },
});

export const set = mutation({
  args: {
    lastAlertDirection: v.union(v.literal("BUY UP"), v.literal("BUY DOWN")),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("monitorState")
      .withIndex("by_monitor", (q) => q.eq("monitor", MONITOR))
      .first();

    if (row) {
      await ctx.db.patch(row._id, {
        lastAlertDirection: args.lastAlertDirection,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("monitorState", {
        monitor: MONITOR,
        lastAlertDirection: args.lastAlertDirection,
        updatedAt: Date.now(),
      });
    }

    return null;
  },
});

export const claim = mutation({
  args: {
    direction: v.union(v.literal("BUY UP"), v.literal("BUY DOWN")),
  },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("monitorState")
      .withIndex("by_monitor", (q) => q.eq("monitor", MONITOR))
      .first();

    if (row?.lastAlertDirection === args.direction) {
      return { allowed: false };
    }

    if (row) {
      await ctx.db.patch(row._id, {
        lastAlertDirection: args.direction,
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("monitorState", {
        monitor: MONITOR,
        lastAlertDirection: args.direction,
        updatedAt: Date.now(),
      });
    }

    return { allowed: true };
  },
});


export const claimTelegramMarketV3 = mutation({
  args: {
    marketSlug: v.string(),
  },
  returns: v.object({ allowed: v.boolean() }),
  handler: async (ctx, args) => {
    const monitor = MONITOR;
    const existing = await ctx.db
      .query("telegramDedupe")
      .withIndex("by_monitor_market", (q) =>
        q.eq("monitor", monitor).eq("marketSlug", args.marketSlug)
      )
      .first();

    if (existing) {
      return { allowed: false };
    }

    await ctx.db.insert("telegramDedupe", {
      monitor,
      marketSlug: args.marketSlug,
      claimedAt: Date.now(),
    });

    return { allowed: true };
  },
});


const OPENMARKET_MONITOR = "btc-openmarket-btc-liquidation";

export const logOpenMarketBatch = mutation({
  args: {
    logs: v.array(v.object({
      level: v.string(),
      event: v.string(),
      message: v.string(),
      data: v.optional(v.string()),
    })),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    for (const log of args.logs) {
      await ctx.db.insert("openMarketLogs", {
        monitor: OPENMARKET_MONITOR,
        level: log.level,
        event: log.event,
        message: log.message,
        data: log.data,
        createdAt: now,
      });
    }
    return null;
  },
});

export const logOpenMarket = mutation({
  args: {
    level: v.string(),
    event: v.string(),
    message: v.string(),
    data: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("openMarketLogs", {
      monitor: OPENMARKET_MONITOR,
      level: args.level,
      event: args.event,
      message: args.message,
      data: args.data,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const recentOpenMarketLogs = query({
  args: {},
  returns: v.array(v.object({
    level: v.string(),
    event: v.string(),
    message: v.string(),
    data: v.optional(v.string()),
    createdAt: v.number(),
  })),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("openMarketLogs")
      .withIndex("by_monitor_time", (q) => q.eq("monitor", OPENMARKET_MONITOR))
      .order("desc")
      .take(100);

    return rows.map((row) => ({
      level: row.level,
      event: row.event,
      message: row.message,
      data: row.data,
      createdAt: row.createdAt,
    }));
  },
});


const BTC5M_MONITOR = "btc-5m-chainlink-edge";

export const logBtc5m = mutation({
  args: {
    level: v.string(),
    event: v.string(),
    message: v.string(),
    data: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("btc5mLogs", {
      monitor: BTC5M_MONITOR,
      level: args.level,
      event: args.event,
      message: args.message,
      data: args.data,
      createdAt: Date.now(),
    });
    return null;
  },
});

export const recentBtc5mLogs = query({
  args: {},
  returns: v.array(v.object({
    level: v.string(),
    event: v.string(),
    message: v.string(),
    data: v.optional(v.string()),
    createdAt: v.number(),
  })),
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("btc5mLogs")
      .withIndex("by_monitor_time", (q) => q.eq("monitor", BTC5M_MONITOR))
      .order("desc")
      .take(200);

    return rows.map((row) => ({
      level: row.level,
      event: row.event,
      message: row.message,
      data: row.data,
      createdAt: row.createdAt,
    }));
  },
});
