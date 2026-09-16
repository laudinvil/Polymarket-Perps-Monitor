import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// Deployment trigger: keep Convex production schema/runtime in sync with main.
// Crowd Flow and BTC CVD persistence are part of the production deployment contract.
export default defineSchema({
  monitorRuns: defineTable({
    runId: v.number(), githubRunId: v.string(), commitSha: v.string(), startedAt: v.number(),
    lastHeartbeatAt: v.optional(v.number()), finishedAt: v.optional(v.number()),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
  }).index("by_run", ["runId"]).index("by_started_at", ["startedAt"]),
  monitorRuntime: defineTable({
    runId: v.number(), githubRunId: v.string(), commitSha: v.string(), startedAt: v.number(),
    lastHeartbeatAt: v.optional(v.number()), finishedAt: v.optional(v.number()),
    status: v.union(v.literal("running"), v.literal("completed"), v.literal("failed")),
    exitCode: v.optional(v.union(v.number(), v.null())),
  }).index("by_run", ["runId"]).index("by_started_at", ["startedAt"]),
  monitorRuntimeLogs: defineTable({
    runId: v.number(), level: v.string(), message: v.string(), ts: v.number(),
  }).index("by_run_ts", ["runId", "ts"]).index("by_ts", ["ts"]),
  snapshots: defineTable({
    runId:v.number(), timeframe:v.string(), symbol:v.string(), boundaryTs:v.number(), imbalanceUsd:v.number(), longUsd:v.number(), shortUsd:v.number(), longEvents:v.number(), shortEvents:v.number(), events:v.number(),
  }).index("by_timeframe_symbol_boundary",["timeframe","symbol","boundaryTs"]).index("by_timeframe_boundary",["timeframe","boundaryTs"]).index("by_boundary",["boundaryTs"]),
  alerts: defineTable({
    runId:v.number(), timeframe:v.string(), symbol:v.string(), boundaryTs:v.number(), alertType:v.string(), previousImbalanceUsd:v.number(), newImbalanceUsd:v.number(), sentAt:v.number(),
  }).index("by_symbol_timeframe_boundary",["symbol","timeframe","boundaryTs"]).index("by_sent_at",["sentAt"]),
  crowdFlowPeriods: defineTable({
    symbol:v.string(), periodStart:v.number(), periodEnd:v.number(), trades:v.number(), previousTrades:v.optional(v.number()), change:v.optional(v.number()), direction:v.optional(v.string()), streak:v.optional(v.number()), closeUp:v.optional(v.number()), closeDown:v.optional(v.number()), recordedAt:v.number(),
  }).index("by_symbol_period",["symbol","periodStart"]).index("by_recorded_at",["recordedAt"]),
  crowdFlowAlerts: defineTable({
    symbol:v.string(), periodStart:v.number(), alertType:v.string(), sentAt:v.number(),
  }).index("by_symbol_period",["symbol","periodStart"]),
  cvd5mPeriods: defineTable({
    symbol:v.string(), periodStart:v.number(), periodEnd:v.number(), buyUsd:v.number(), sellUsd:v.number(), cvdUsd:v.number(), imbalancePct:v.number(), buyEvents:v.number(), sellEvents:v.number(), trades:v.number(), direction:v.string(), recordedAt:v.number(),
  }).index("by_symbol_period",["symbol","periodStart"]).index("by_recorded_at",["recordedAt"]),
  cvd5mAlerts: defineTable({
    symbol:v.string(), periodStart:v.number(), sentAt:v.number(),
  }).index("by_symbol_period",["symbol","periodStart"]).index("by_sent_at",["sentAt"]),
  streakHitPeriods: defineTable({
    symbol:v.string(), timeframe:v.string(), periodStart:v.number(), periodEnd:v.number(),
    result:v.string(), streak:v.number(), direction:v.string(), threshold:v.number(),
    isHit:v.boolean(), isContinuation:v.boolean(), recordedAt:v.number(),
  }).index("by_symbol_timeframe_period",["symbol","timeframe","periodStart"])
    .index("by_timeframe_period",["timeframe","periodStart"])
    .index("by_recorded_at",["recordedAt"]),
  lineAlerts: defineTable({
    runId:v.number(), eventId:v.string(), home:v.string(), away:v.string(), market:v.string(), selection:v.string(), line:v.number(), movePercent:v.number(), bookmakers:v.any(), polymarketUrl:v.optional(v.string()), sentAt:v.number(),
  }).index("by_sent_at",["sentAt"]).index("by_event",["eventId"]),
  esportsAlerts: defineTable({
    fingerprint: v.string(), strategy: v.string(), team:v.string(), url:v.string(), matchId:v.string(), sentAt:v.number(),
  }).index("by_fingerprint", ["fingerprint"]),
  paperTrades: defineTable({
    symbol:v.string(), marketStart:v.number(), outcome:v.string(), entryPrice:v.number(), shares:v.number(), alertTs:v.number(),
    sourceMessageId:v.optional(v.number()), resultMessageId:v.optional(v.number()), settled:v.boolean(), result:v.optional(v.string()), winner:v.optional(v.string()), pnl:v.optional(v.number()),
    closedPrice:v.optional(v.number()), closeTs:v.optional(v.number()), closePnl:v.optional(v.number()), updatedAt:v.number(),
  }).index("by_market",["symbol","marketStart"]).index("by_settled_updated",["settled","updatedAt"]),
});
