import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();

function authorized(request: Request) {
  const expected = process.env.CONVEX_INGEST_TOKEN;
  if (!expected) return false;
  const header = request.headers.get("authorization") || "";
  return header === `Bearer ${expected}`;
}

const ingest = httpAction(async (ctx, request) => {
  if (!authorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  try {
    if (body.type === "run.start") {
      await ctx.runMutation(internal.monitor.startRun, body.data);
    } else if (body.type === "run.finish") {
      await ctx.runMutation(internal.monitor.finishRun, body.data);
    } else if (body.type === "snapshot") {
      await ctx.runMutation(internal.monitor.saveSnapshot, body.data);
    } else if (body.type === "alert") {
      await ctx.runMutation(internal.monitor.saveAlert, body.data);
    } else {
      return new Response("Unknown event type", { status: 400 });
    }

    return Response.json({ ok: true });
  } catch (error) {
    console.error("Convex ingest failed", error);
    return new Response("Ingest failed", { status: 500 });
  }
});

const latestStats = httpAction(async (ctx, request) => {
  if (!authorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const timeframe = String(url.searchParams.get("timeframe") || "").trim();
  if (!["5m", "15m", "1h", "4h"].includes(timeframe)) {
    return new Response("Invalid timeframe", { status: 400 });
  }

  try {
    const rows = await ctx.runQuery(api.monitor.latestStats, { timeframe });
    return Response.json(rows);
  } catch (error) {
    console.error("Convex latest stats failed", error);
    return new Response("Stats query failed", { status: 500 });
  }
});

http.route({ path: "/ingest", method: "POST", handler: ingest });
http.route({ path: "/latest-stats", method: "GET", handler: latestStats });

export default http;
