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


export const claimTelegramMarket = mutation({
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
