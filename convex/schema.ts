import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  monitorRuns: defineTable({
    runId: v.number(), githubRunId: v.string(), commitSha: v.string(), startedAt: v.number(),
    lastHeartbeatAt: v.optional(v.number()), finishedAt: v.optional(v.number()),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
  }).index("by_run", ["runId"]).index("by_started_at", ["startedAt"]),
  snapshots: defineTable({
    runId:v.number(), timeframe:v.string(), symbol:v.string(), boundaryTs:v.number(), imbalanceUsd:v.number(), longUsd:v.number(), shortUsd:v.number(), longEvents:v.number(), shortEvents:v.number(), events:v.number(),
  }).index("by_timeframe_symbol_boundary",["timeframe","symbol","boundaryTs"]).index("by_timeframe_boundary",["timeframe","boundaryTs"]).index("by_boundary",["boundaryTs"]),
  alerts: defineTable({
    runId:v.number(), timeframe:v.string(), symbol:v.string(), boundaryTs:v.number(), alertType:v.string(), previousImbalanceUsd:v.number(), newImbalanceUsd:v.number(), sentAt:v.number(),
  }).index("by_symbol_timeframe_boundary",["symbol","timeframe","boundaryTs"]).index("by_sent_at",["sentAt"]),
  lineAlerts: defineTable({
    runId:v.number(), eventId:v.string(), home:v.string(), away:v.string(), market:v.string(), selection:v.string(), line:v.number(), movePercent:v.number(), bookmakers:v.any(), polymarketUrl:v.optional(v.string()), sentAt:v.number(),
  }).index("by_sent_at",["sentAt"]).index("by_event",["eventId"]),
  esportsAlerts: defineTable({
    fingerprint: v.string(), strategy: v.string(), team: v.string(), url: v.string(), matchId: v.string(), sentAt: v.number(),
  }).index("by_fingerprint", ["fingerprint"]),
});
