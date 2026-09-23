import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  monitorState: defineTable({
    monitor: v.string(),
    lastAlertDirection: v.union(v.literal("BUY UP"), v.literal("BUY DOWN"), v.null()),
    updatedAt: v.number(),
  }).index("by_monitor", ["monitor"]),
});
