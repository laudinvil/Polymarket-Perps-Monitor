import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  monitorState: defineTable({
    monitor: v.string(),
    lastAlertDirection: v.union(v.literal("BUY UP"), v.literal("BUY DOWN"), v.null()),
    updatedAt: v.number(),
  }).index("by_monitor", ["monitor"]),

  telegramDedupe: defineTable({
    monitor: v.string(),
    marketSlug: v.string(),
    claimedAt: v.number(),
  }).index("by_monitor_market", ["monitor", "marketSlug"]),

  btc5mLogs: defineTable({
    monitor: v.string(),
    level: v.string(),
    event: v.string(),
    message: v.string(),
    data: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_monitor_time", ["monitor", "createdAt"]),

  openMarketLogs: defineTable({
    monitor: v.string(),
    level: v.string(),
    event: v.string(),
    message: v.string(),
    data: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_monitor_time", ["monitor", "createdAt"]),
});
