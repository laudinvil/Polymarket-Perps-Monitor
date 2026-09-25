import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/football/logs",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const body = await request.json();
    await ctx.runMutation(internal.footballLogs.ingest, {
      logs: Array.isArray(body.logs) ? body.logs : [],
      tickCount: typeof body.tickCount === "number" ? body.tickCount : 0,
    });
    return new Response("ok", { status: 200 });
  }),
});

export default http;
