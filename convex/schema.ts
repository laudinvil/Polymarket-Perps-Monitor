import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  monitorState: defineTable({
    monitor: v.string(),
    lastAlertDirection: v.union(v.literal("BUY UP"), v.literal("BUY DOWN"), v.null()),
    updatedAt: v.number(),
  }).index("by_monitor", ["monitor"]),
  telegramDedupe: defineTable({
    monitor: v.string(), marketSlug: v.string(), claimedAt: v.number(),
    telegramMessageId: v.optional(v.number()),
  }).index("by_monitor_market", ["monitor", "marketSlug"]),
  btc5mLogs: defineTable({
    monitor: v.string(), level: v.string(), event: v.string(), message: v.string(),
    data: v.optional(v.string()), createdAt: v.number(),
  }).index("by_monitor_time", ["monitor", "createdAt"]),
  footballCandidates: defineTable({
    monitor: v.string(),
    key: v.string(),
    data: v.string(),
    admittedAt: v.number(),
    updatedAt: v.number(),
    buySent: v.boolean(),
    startedSent: v.optional(v.boolean()),
    sellSent: v.optional(v.boolean()),
  }).index("by_monitor_key", ["monitor", "key"]).index("by_monitor", ["monitor"]),
  footballLogs: defineTable({
    monitor: v.string(), level: v.string(), event: v.string(), message: v.string(),
    data: v.optional(v.string()), createdAt: v.number(),
  }).index("by_monitor_time", ["monitor", "createdAt"]),
  footballStats: defineTable({
    monitor: v.string(),
    ticks: v.number(),
    eventsScanned: v.optional(v.number()),
    discoveryMatchesFound: v.optional(v.number()),
    footballEvents: v.optional(v.number()),
    candidateGatePassed: v.optional(v.number()),
    liveToday: v.optional(v.number()),
    preMatchFuture: v.optional(v.number()),
    unknownDate: v.optional(v.number()),
    childMarketFiltered: v.optional(v.number()),
    oneOneMarketFound: v.optional(v.number()),
    rejectedBuyFilter: v.optional(v.number()),
    candidates: v.number(), evaluations: v.number(), balanced: v.number(),
    marketMissing: v.number(), unresolved: v.number(), buyAlerts: v.number(),
    sellAlerts: v.number(), errors: v.number(), updatedAt: v.number(),
  }).index("by_monitor", ["monitor"]),
  openMarketLogs: defineTable({
    monitor: v.string(), level: v.string(), event: v.string(), message: v.string(),
    data: v.optional(v.string()), createdAt: v.number(),
  }).index("by_monitor_time", ["monitor", "createdAt"]),
});