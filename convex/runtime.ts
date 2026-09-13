import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

const statusValidator = v.union(v.literal("running"), v.literal("completed"), v.literal("failed"));

export const start = internalMutation({
  args: { runId: v.number(), githubRunId: v.string(), commitSha: v.string(), startedAt: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("monitorRuntime").withIndex("by_run", q => q.eq("runId", args.runId)).unique();
    if (existing) {
      await ctx.db.patch(existing._id, { githubRunId: args.githubRunId, commitSha: args.commitSha, startedAt: args.startedAt, lastHeartbeatAt: args.startedAt, status: "running", finishedAt: undefined, exitCode: undefined });
      return existing._id;
    }
    return await ctx.db.insert("monitorRuntime", { ...args, lastHeartbeatAt: args.startedAt, status: "running" });
  },
});

export const heartbeat = internalMutation({
  args: { runId: v.number(), heartbeatAt: v.number() },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("monitorRuntime").withIndex("by_run", q => q.eq("runId", args.runId)).unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { lastHeartbeatAt: args.heartbeatAt, status: "running" });
    return row._id;
  },
});

export const log = internalMutation({
  args: { runId: v.number(), level: v.string(), message: v.string(), ts: v.number() },
  handler: async (ctx, args) => await ctx.db.insert("monitorRuntimeLogs", args),
});

export const finish = internalMutation({
  args: { runId: v.number(), finishedAt: v.number(), status: statusValidator, exitCode: v.union(v.number(), v.null()) },
  handler: async (ctx, args) => {
    const row = await ctx.db.query("monitorRuntime").withIndex("by_run", q => q.eq("runId", args.runId)).unique();
    if (!row) return null;
    await ctx.db.patch(row._id, { finishedAt: args.finishedAt, status: args.status, exitCode: args.exitCode });
    return row._id;
  },
});

export const status = query({
  args: {},
  handler: async (ctx) => {
    const row = (await ctx.db.query("monitorRuntime").withIndex("by_started_at").order("desc").take(1))[0];
    if (!row) return { ok: false, status: "offline", ageMs: Number.MAX_SAFE_INTEGER, run: null };
    const heartbeatAt = row.lastHeartbeatAt ?? row.startedAt;
    const ageMs = Date.now() - heartbeatAt;
    const ok = row.status === "running" && ageMs < 120000;
    return { ok, status: ok ? "running" : row.status === "running" ? "stale" : row.status, ageMs, run: row };
  },
});

export const logs = query({
  args: { runId: v.optional(v.number()), limit: v.number() },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(Math.floor(args.limit), 1), 200);
    if (args.runId !== undefined) return await ctx.db.query("monitorRuntimeLogs").withIndex("by_run_ts", q => q.eq("runId", args.runId!)).order("desc").take(limit);
    return await ctx.db.query("monitorRuntimeLogs").withIndex("by_ts").order("desc").take(limit);
  },
});

export const runs = query({
  args: { limit: v.number() },
  handler: async (ctx, args) => await ctx.db.query("monitorRuntime").withIndex("by_started_at").order("desc").take(Math.min(Math.max(Math.floor(args.limit), 1), 50)),
});
