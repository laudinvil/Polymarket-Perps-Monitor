import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const MONITOR = "polymarket-football-1-1";

export const ingest = mutation({
  args: {
    logs: v.array(v.object({
      level: v.string(), event: v.string(), message: v.string(),
      data: v.optional(v.string()), createdAt: v.number(),
    })),
    tickCount: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("footballStats").withIndex("by_monitor", (q) => q.eq("monitor", MONITOR)).first();
    let eventsScanned = 0, discoveryMatchesFound = 0, footballEvents = 0, candidateGatePassed = 0;
    let liveToday = 0, preMatchFuture = 0, unknownDate = 0, childMarketFiltered = 0;
    let oneOneMarketFound = 0, rejectedBuyFilter = 0, candidates = 0, evaluations = 0;
    let balanced = 0, marketMissing = 0, unresolved = 0, buyAlerts = 0, sellAlerts = 0, errors = 0;
    for (const item of args.logs) {
      await ctx.db.insert("footballLogs", { monitor: MONITOR, level: item.level, event: item.event, message: item.message, data: item.data, createdAt: item.createdAt });
      if (item.event === "event_source_response" && item.data) { try { eventsScanned += Number(JSON.parse(item.data).rowCount ?? 0); } catch {} }
      if (item.event === "discovery_done" && item.data) { try { discoveryMatchesFound += Number(JSON.parse(item.data).matchesFound ?? 0); } catch {} }
      footballEvents += item.event === "match_discovery_passed" ? 1 : 0;
      if (item.event === "match_timing_classified" && item.data) { try { const d = JSON.parse(item.data); liveToday += Number(d.liveToday ?? 0); preMatchFuture += Number(d.preMatchFuture ?? 0); unknownDate += Number(d.unknownDate ?? 0); } catch {} }
      childMarketFiltered += item.event === "fixture_event_grouped" ? 1 : 0;
      if (item.event === "event_markets_loaded" && item.data) { try { if (JSON.parse(item.data).oneOneMarketAvailable === true) oneOneMarketFound += 1; } catch {} }
      rejectedBuyFilter += item.event === "candidate_rejected_buy_filter" ? 1 : 0;
      candidateGatePassed += item.event === "candidate_match_found" ? 1 : 0;
      candidates += item.event === "candidate_match_found" ? 1 : 0;
      evaluations += item.event === "candidate_match_found" ? 1 : 0;
      marketMissing += item.event === "one_one_market_missing" ? 1 : 0;
      unresolved += item.event === "match_unresolved" ? 1 : 0;
      buyAlerts += item.event === "one_one_buy_alert_sent" ? 1 : 0;
      sellAlerts += item.event === "one_one_sell_alert_sent" ? 1 : 0;
      errors += ["discovery_failed","event_source_failed","event_source_http_error","event_source_json_error","nutmeg_fetch_failed","polymarket_live_state_failed","telegram_send_failed","telegram_claim_failed"].includes(item.event) ? 1 : 0;
      if (item.event === "candidate_match_found" && item.data) { try { if (JSON.parse(item.data).balanced === true) balanced += 1; } catch {} }
    }
    const patch = {
      ticks: (existing?.ticks ?? 0) + (args.tickCount ?? 0),
      eventsScanned: (existing?.eventsScanned ?? 0) + eventsScanned,
      discoveryMatchesFound: (existing?.discoveryMatchesFound ?? 0) + discoveryMatchesFound,
      footballEvents: (existing?.footballEvents ?? 0) + footballEvents,
      candidateGatePassed: (existing?.candidateGatePassed ?? 0) + candidateGatePassed,
      liveToday: (existing?.liveToday ?? 0) + liveToday, preMatchFuture: (existing?.preMatchFuture ?? 0) + preMatchFuture,
      unknownDate: (existing?.unknownDate ?? 0) + unknownDate, childMarketFiltered: (existing?.childMarketFiltered ?? 0) + childMarketFiltered,
      oneOneMarketFound: (existing?.oneOneMarketFound ?? 0) + oneOneMarketFound, rejectedBuyFilter: (existing?.rejectedBuyFilter ?? 0) + rejectedBuyFilter,
      candidates: (existing?.candidates ?? 0) + candidates, evaluations: (existing?.evaluations ?? 0) + evaluations,
      balanced: (existing?.balanced ?? 0) + balanced, marketMissing: (existing?.marketMissing ?? 0) + marketMissing,
      unresolved: (existing?.unresolved ?? 0) + unresolved, buyAlerts: (existing?.buyAlerts ?? 0) + buyAlerts,
      sellAlerts: (existing?.sellAlerts ?? 0) + sellAlerts, errors: (existing?.errors ?? 0) + errors, updatedAt: now,
    };
    if (existing) await ctx.db.patch(existing._id, patch); else await ctx.db.insert("footballStats", { monitor: MONITOR, ...patch });
    return null;
  },
});

export const stats = query({
  args: {}, returns: v.union(v.object({
    monitor: v.string(), ticks: v.number(), eventsScanned: v.optional(v.number()), discoveryMatchesFound: v.optional(v.number()),
    footballEvents: v.optional(v.number()), candidateGatePassed: v.optional(v.number()), liveToday: v.optional(v.number()),
    preMatchFuture: v.optional(v.number()), unknownDate: v.optional(v.number()), childMarketFiltered: v.optional(v.number()),
    oneOneMarketFound: v.optional(v.number()), rejectedBuyFilter: v.optional(v.number()), candidates: v.number(), evaluations: v.number(),
    balanced: v.number(), marketMissing: v.number(), unresolved: v.number(), buyAlerts: v.number(), sellAlerts: v.number(), errors: v.number(), updatedAt: v.number(),
  }), v.null()),
  handler: async (ctx) => {
    const row = await ctx.db.query("footballStats").withIndex("by_monitor", (q) => q.eq("monitor", MONITOR)).first();
    if (!row) return null;
    return {
      monitor: row.monitor, ticks: row.ticks, eventsScanned: row.eventsScanned ?? 0, discoveryMatchesFound: row.discoveryMatchesFound ?? 0,
      footballEvents: row.footballEvents ?? 0, candidateGatePassed: row.candidateGatePassed ?? 0, liveToday: row.liveToday ?? 0,
      preMatchFuture: row.preMatchFuture ?? 0, unknownDate: row.unknownDate ?? 0, childMarketFiltered: row.childMarketFiltered ?? 0,
      oneOneMarketFound: row.oneOneMarketFound ?? 0, rejectedBuyFilter: row.rejectedBuyFilter ?? 0, candidates: row.candidates, evaluations: row.evaluations,
      balanced: row.balanced, marketMissing: row.marketMissing, unresolved: row.unresolved, buyAlerts: row.buyAlerts, sellAlerts: row.sellAlerts, errors: row.errors, updatedAt: row.updatedAt,
    };
  },
});

export const claimTelegramAlert = mutation({
  args: { monitor: v.string(), marketSlug: v.string() },
  returns: v.object({ claimed: v.boolean(), replyToMessageId: v.union(v.number(), v.null()) }),
  handler: async (ctx, args) => {
    const now = Date.now();
    const existing = await ctx.db.query("telegramDedupe").withIndex("by_monitor_market", (q) => q.eq("monitor", args.monitor).eq("marketSlug", args.marketSlug)).first();
    if (existing && now - existing.claimedAt < 5 * 60 * 1000) return { claimed: false, replyToMessageId: null };
    if (args.marketSlug.endsWith(":SELL")) {
      const buyKey = args.marketSlug.slice(0, -5) + ":BUY";
      const buy = await ctx.db.query("telegramDedupe").withIndex("by_monitor_market", (q) => q.eq("monitor", args.monitor).eq("marketSlug", buyKey)).first();
      if (!buy) return { claimed: false, replyToMessageId: null };
      if (!buy.telegramMessageId) return { claimed: false, replyToMessageId: null };
      if (existing) await ctx.db.patch(existing._id, { claimedAt: now });
      else await ctx.db.insert("telegramDedupe", { monitor: args.monitor, marketSlug: args.marketSlug, claimedAt: now });
      return { claimed: true, replyToMessageId: buy.telegramMessageId };
    }
    if (args.marketSlug.endsWith(":FIRST_GOAL")) {
      const buyKey = args.marketSlug.slice(0, -11) + ":BUY";
      const buy = await ctx.db.query("telegramDedupe").withIndex("by_monitor_market", (q) => q.eq("monitor", args.monitor).eq("marketSlug", buyKey)).first();
      if (!buy) return { claimed: false, replyToMessageId: null };
    }
    if (args.marketSlug.endsWith(":SELL_11")) {
      const baseKey = args.marketSlug.slice(0, -8);
      const buy = await ctx.db.query("telegramDedupe").withIndex("by_monitor_market", (q) => q.eq("monitor", args.monitor).eq("marketSlug", baseKey + ":BUY")).first();
      const firstGoal = await ctx.db.query("telegramDedupe").withIndex("by_monitor_market", (q) => q.eq("monitor", args.monitor).eq("marketSlug", baseKey + ":FIRST_GOAL")).first();
      if (!buy || !firstGoal || !buy.telegramMessageId) return { claimed: false, replyToMessageId: null };
      if (existing) await ctx.db.patch(existing._id, { claimedAt: now });
      else await ctx.db.insert("telegramDedupe", { monitor: MONITOR, marketSlug: args.marketSlug, claimedAt: now });
      return { claimed: true, replyToMessageId: buy.telegramMessageId };
    }
    if (existing) await ctx.db.patch(existing._id, { claimedAt: now });
    else await ctx.db.insert("telegramDedupe", { monitor: args.monitor, marketSlug: args.marketSlug, claimedAt: now });
    return { claimed: true, replyToMessageId: null };
  },
});

export const saveTelegramMessageId = mutation({
  args: { monitor: v.string(), marketSlug: v.string(), messageId: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.query("telegramDedupe").withIndex("by_monitor_market", (q) => q.eq("monitor", args.monitor).eq("marketSlug", args.marketSlug)).first();
    if (!row) return null;
    await ctx.db.patch(row._id, { telegramMessageId: args.messageId });
    return null;
  },
});

export const releaseTelegramAlert = mutation({
  args: { monitor: v.string(), marketSlug: v.string() }, returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("telegramDedupe").withIndex("by_monitor_market", (q) => q.eq("monitor", args.monitor).eq("marketSlug", args.marketSlug)).first();
    if (existing) await ctx.db.delete(existing._id);
    return null;
  },
});

export const recentLogs = query({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.object({
    _id: v.id("footballLogs"), _creationTime: v.number(), monitor: v.string(), level: v.string(), event: v.string(),
    message: v.string(), data: v.optional(v.string()), createdAt: v.number(),
  })),
  handler: async (ctx, args) => await ctx.db.query("footballLogs").withIndex("by_monitor_time", (q) => q.eq("monitor", MONITOR)).order("desc").take(Math.min(args.limit ?? 500, 1000)),
});