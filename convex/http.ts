import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api, internal } from "./_generated/api";

const http = httpRouter();
// CVD deployment sync: ensure production Convex runtime includes cvd5m.period ingest/query handlers.
function authorized(request: Request) { const expected=process.env.CONVEX_INGEST_TOKEN; if(!expected)return false; return (request.headers.get("authorization")||"")===`Bearer ${expected}`; }
const ingest=httpAction(async(ctx,request)=>{if(!authorized(request))return new Response("Unauthorized",{status:401});let body:any;try{body=await request.json();}catch{return new Response("Invalid JSON",{status:400});}try{if(body.type==="run.start")await ctx.runMutation(internal.monitor.startRun,body.data);else if(body.type==="run.heartbeat")await ctx.runMutation(internal.monitor.heartbeat,body.data);else if(body.type==="run.finish")await ctx.runMutation(internal.monitor.finishRun,body.data);else if(body.type==="snapshot")await ctx.runMutation(internal.monitor.saveSnapshot,body.data);else if(body.type==="alert")await ctx.runMutation(internal.monitor.saveAlert,body.data);else if(body.type==="crowdFlow.period")await ctx.runMutation(internal.monitor.saveCrowdFlowPeriod,body.data);else if(body.type==="cvd5m.period")await ctx.runMutation(internal.monitor.saveCvd5mPeriod,body.data);else if(body.type==="streakHit.period")await ctx.runMutation(internal.monitor.saveStreakHitPeriod,body.data);else if(body.type==="paper.upsert")await ctx.runMutation(internal.monitor.upsertPaperTrade,body.data);else if(body.type==="liveTrade.upsert")await ctx.runMutation(internal.monitor.upsertLiveTrade,body.data);else if(body.type==="recovery.set")await ctx.runMutation(internal.monitor.setRecoveryState,body.data);else if(body.type==="strategyStability")await ctx.runMutation(internal.monitor.saveStrategyStability,body.data);else if(body.type==="holder.snapshot")await ctx.runMutation(internal.monitor.saveHolderSnapshot,body.data);else if(body.type==="liquidation.event")await ctx.runMutation(internal.monitor.saveLiquidationEvent,body.data);else if(body.type==="runtime.start")await ctx.runMutation(internal.runtime.start,body.data);else if(body.type==="runtime.heartbeat")await ctx.runMutation(internal.runtime.heartbeat,body.data);else if(body.type==="runtime.log")await ctx.runMutation(internal.runtime.log,body.data);else if(body.type==="runtime.finish")await ctx.runMutation(internal.runtime.finish,body.data);else return new Response("Unknown event type",{status:400});return Response.json({ok:true});}catch(error){console.error("Convex ingest failed",error);return new Response("Ingest failed",{status:500});}});
const holderSnapshot=httpAction(async(ctx,request)=>{if(!authorized(request))return new Response("Unauthorized",{status:401});const url=new URL(request.url);const symbol=String(url.searchParams.get("symbol")||"BTC");const periodStart=Number(url.searchParams.get("periodStart"));if(!Number.isFinite(periodStart))return new Response("Invalid periodStart",{status:400});try{return Response.json(await ctx.runQuery(api.monitor.getHolderSnapshot,{symbol,periodStart}));}catch{return new Response("Holder snapshot query failed",{status:500});}});
const holderAlertState=httpAction(async(ctx,request)=>{if(!authorized(request))return new Response("Unauthorized",{status:401});const url=new URL(request.url);const symbol=String(url.searchParams.get("symbol")||"BTC");try{return Response.json(await ctx.runQuery(api.monitor.getHolderAlertState,{symbol}));}catch{return new Response("Holder alert state query failed",{status:500});}});
const setHolderAlertState=httpAction(async(ctx,request)=>{if(!authorized(request))return new Response("Unauthorized",{status:401});let body:any;try{body=await request.json();}catch{return new Response("Invalid JSON",{status:400});}try{await ctx.runMutation(internal.monitor.setHolderAlertState,{symbol:String(body.symbol||"BTC"),lastDirection:body.lastDirection,directionCount:Number(body.directionCount||1),lastImbalance:Number(body.lastImbalance||0),updatedAt:Number(body.updatedAt||Date.now())});return Response.json({ok:true});}catch{return new Response("Holder alert state update failed",{status:500});}});
const claimEsportsAlert=httpAction(async(ctx,request)=>{if(!authorized(request))return new Response("Unauthorized",{status:401});let body:any;try{body=await request.json();}catch{return new Response("Invalid JSON",{status:400});}try{const claimed=await ctx.runMutation(internal.monitor.claimEsportsAlert,{fingerprint:String(body.fingerprint||""),strategy:String(body.strategy||""),team:String(body.team||""),url:String(body.url||""),matchId:String(body.matchId||""),sentAt:Number(body.sentAt||Date.now())});return Response.json({claimed});}catch(error){console.error("Convex esports claim failed",error);return new Response("Esports claim failed",{status:500});}});
const claimCrowdFlowAlert=httpAction(async(ctx,request)=>{if(!authorized(request))return new Response("Unauthorized",{status:401});let body:any;try{body=await request.json();}catch{return new Response("Invalid JSON",{status:400});}try{const claimed=await ctx.runMutation(internal.monitor.claimCrowdFlowAlert,{symbol:String(body.symbol||"BTC"),periodStart:Number(body.periodStart),alertType:String(body.alertType||"LOW_TRADES"),sentAt:Number(body.sentAt||Date.now())});return Response.json({claimed});}catch(error){console.error("Convex Crowd Flow claim failed",error);return new Response("Crowd Flow claim failed",{status:500});}});
const claimCvd5mAlert=httpAction(async(ctx,request)=>{if(!authorized(request))return new Response("Unauthorized",{status:401});let body:any;try{body=await request.json();}catch{return new Response("Invalid JSON",{status:400});}try{const claimed=await ctx.runMutation(internal.monitor.claimCvd5mAlert,{symbol:String(body.symbol||"BTC"),periodStart:Number(body.periodStart),sentAt:Number(body.sentAt||Date.now())});return Response.json({claimed});}catch(error){console.error("Convex CVD claim failed",error);return new Response("CVD claim failed",{status:500});}});
const latestCvd5mAlert=httpAction(async(ctx,request)=>{const symbol=String(new URL(request.url).searchParams.get("symbol")||"BTC");try{return Response.json(await ctx.runQuery(api.monitor.latestCvd5mAlert,{symbol}));}catch{return new Response("CVD alert query failed",{status:500});}});
const buySnapshot=httpAction(async(ctx,request)=>{
  if(!authorized(request))return new Response("Unauthorized",{status:401});
  let body:any;try{body=await request.json();}catch{return new Response("Invalid JSON",{status:400});}
  try{await ctx.runMutation(internal.monitor.saveBuySnapshot,body);return Response.json({ok:true});}
  catch(error){console.error("Convex BUY snapshot save failed",error);return new Response("BUY snapshot save failed",{status:500});}
});
const buySnapshots=httpAction(async(ctx,request)=>{
  if(!authorized(request))return new Response("Unauthorized",{status:401});
  const url=new URL(request.url);const symbol=String(url.searchParams.get("symbol")||"BTC");
  const limit=Math.min(Math.max(Number(url.searchParams.get("limit")||20),1),200);
  try{return Response.json(await ctx.runQuery(api.monitor.latestBuySnapshots,{symbol,limit}));}
  catch{return new Response("BUY snapshots query failed",{status:500});}
});
const rollingAlertStatus=httpAction(async(ctx,request)=>{
  if(!authorized(request))return new Response("Unauthorized",{status:401});
  const url=new URL(request.url);const symbol=String(url.searchParams.get("symbol")||"BTC");
  const windowMs=Math.min(Math.max(Number(url.searchParams.get("windowMs")||3600000),60000),86400000);
  try{return Response.json(await ctx.runQuery(api.monitor.rollingAlertClaimsStatus,{symbol,windowMs}));}
  catch{return new Response("Rolling alert status query failed",{status:500});}
});
const releaseRollingAlert=httpAction(async(ctx,request)=>{
  if(!authorized(request))return new Response("Unauthorized",{status:401});
  let body:any;try{body=await request.json();}catch{return new Response("Invalid JSON",{status:400});}
  try{
    const released=await ctx.runMutation(internal.monitor.releaseRollingAlert,{
      symbol:String(body.symbol||"BTC"),
      periodStart:Number(body.periodStart)
    });
    return Response.json({released});
  }catch(error){console.error("Convex rolling alert release failed",error);return new Response("Rolling alert release failed",{status:500});}
});
const claimLiquidationAlert=httpAction(async(ctx,request)=>{if(!authorized(request))return new Response("Unauthorized",{status:401});let body:any;try{body=await request.json();}catch{return new Response("Invalid JSON",{status:400});}try{const claimed=await ctx.runMutation(internal.monitor.claimLiquidationAlert,{symbol:String(body.symbol||"BTC"),periodStart:Number(body.periodStart),sentAt:Number(body.sentAt||Date.now())});return Response.json({claimed});}catch(error){console.error("Convex liquidation claim failed",error);return new Response("Liquidation claim failed",{status:500});}});
const claimRollingAlert=httpAction(async(ctx,request)=>{
  if(!authorized(request))return new Response("Unauthorized",{status:401});
  let body:any;try{body=await request.json();}catch{return new Response("Invalid JSON",{status:400});}
  try{
    const claimed=await ctx.runMutation(internal.monitor.claimRollingAlert,{
      symbol:String(body.symbol||"BTC"),
      periodStart:Number(body.periodStart),
      sentAt:Number(body.sentAt||Date.now()),
      windowMs:Number(body.windowMs||60*60*1000),
      maxAlerts:Number(body.maxAlerts||5)
    });
    return Response.json({claimed});
  }catch(error){console.error("Convex rolling alert claim failed",error);return new Response("Rolling alert claim failed",{status:500});}
});
const marginpadBtcLiquidations=httpAction(async(ctx,request)=>{
  if(!authorized(request))return new Response("Unauthorized",{status:401});
  const url=new URL(request.url);
  const limit=Math.min(Math.max(Number(url.searchParams.get("limit")||400),1),400);
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),4500);
  try{
    const response=await fetch("https://marginpad.io/api/v1/liquidations/live?symbol=BTC&limit="+limit,{headers:{"accept":"application/json","cache-control":"no-cache","user-agent":"Polymarket-Perps-Monitor-Convex/1.0"},signal:controller.signal});
    const body=await response.text();
    if(!response.ok)return Response.json({ok:false,events:[],liveEvents:0,feedEvents:0,liveError:"HTTP "+response.status+" "+body.slice(0,300),feedError:null,ts:Date.now()},{status:200});
    let json;
    try{json=JSON.parse(body);}catch(error){return Response.json({ok:false,events:[],liveEvents:0,feedEvents:0,liveError:"Invalid JSON: "+body.slice(0,300),feedError:null,ts:Date.now()},{status:200});}
    const data=json?.data;
    const raw=Array.isArray(json?.events)?json.events:
      Array.isArray(json?.liquidations)?json.liquidations:
      Array.isArray(data?.events)?data.events:
      Array.isArray(data?.liquidations)?data.liquidations:
      Array.isArray(data?.data?.events)?data.data.events:
      Array.isArray(data?.data?.liquidations)?data.data.liquidations:
      Array.isArray(data)?data:[];
    const isBtc=event=>{
      const symbol=String(event?.symbol||event?.market||event?.pair||"").toUpperCase().replace(/[-_/]/g,"");
      return symbol==="" || symbol==="BTC" || symbol.startsWith("BTC") || symbol.startsWith("XBT");
    };
    const events=raw.filter(isBtc);
    return Response.json({ok:true,source:"convex-marginpad-live-btc",events,liveEvents:events.length,rawEvents:raw.length,feedEvents:0,liveError:null,feedError:null,ts:Date.now()});
  }catch(error){
    return Response.json({ok:false,events:[],liveEvents:0,feedEvents:0,liveError:String(error?.message||error),feedError:null,ts:Date.now()},{status:200});
  }finally{clearTimeout(timeout);}
});
const health=httpAction(async()=>Response.json({ok:true}));
const runtimeStatus=httpAction(async(ctx)=>{try{return Response.json(await ctx.runQuery(api.runtime.status,{}));}catch{return new Response("Runtime status query failed",{status:500});}});
const runtimeLogs=httpAction(async(ctx,request)=>{const url=new URL(request.url);const rawRunId=url.searchParams.get("runId");const rawLimit=Number(url.searchParams.get("limit")||100);const limit=Math.min(Math.max(Number.isFinite(rawLimit)?Math.floor(rawLimit):100,1),200);const runId=rawRunId===null||rawRunId===""?undefined:Number(rawRunId);if(runId!==undefined&&!Number.isFinite(runId))return new Response("Invalid runId",{status:400});try{return Response.json(await ctx.runQuery(api.runtime.logs,{runId,limit}));}catch{return new Response("Runtime logs query failed",{status:500});}});
const runtimeRuns=httpAction(async(ctx,request)=>{const rawLimit=Number(new URL(request.url).searchParams.get("limit")||20);const limit=Math.min(Math.max(Number.isFinite(rawLimit)?Math.floor(rawLimit):20,1),50);try{return Response.json(await ctx.runQuery(api.runtime.runs,{limit}));}catch{return new Response("Runtime runs query failed",{status:500});}});
const latestStats=httpAction(async(ctx,request)=>{const timeframe=String(new URL(request.url).searchParams.get("timeframe")||"").trim();if(!["5m","15m","1h","4h"].includes(timeframe))return new Response("Invalid timeframe",{status:400});try{return Response.json(await ctx.runQuery(api.monitor.latestStats,{timeframe}));}catch{return new Response("Stats query failed",{status:500});}});
const snapshots=httpAction(async(ctx,request)=>{const url=new URL(request.url);const timeframe=String(url.searchParams.get("timeframe")||"5m").trim();const symbol=String(url.searchParams.get("symbol")||"").trim()||undefined;const requestedLimit=Number(url.searchParams.get("limit")||50);const limit=Math.min(Math.max(Number.isFinite(requestedLimit)?Math.floor(requestedLimit):50,1),200);if(!["5m","15m","1h","4h"].includes(timeframe))return new Response("Invalid timeframe",{status:400});try{return Response.json(await ctx.runQuery(api.monitor.latestSnapshots,{timeframe,symbol,limit}));}catch{return new Response("Snapshots query failed",{status:500});}});
const crowdFlowPeriods=httpAction(async(ctx,request)=>{const url=new URL(request.url);const symbol=String(url.searchParams.get("symbol")||"").trim()||undefined;const requestedLimit=Number(url.searchParams.get("limit")||50);const limit=Math.min(Math.max(Number.isFinite(requestedLimit)?Math.floor(requestedLimit):50,1),200);try{return Response.json(await ctx.runQuery(api.monitor.latestCrowdFlowPeriods,{symbol,limit}));}catch{return new Response("Crowd Flow stats query failed",{status:500});}});
const cvd5mPeriods=httpAction(async(ctx,request)=>{const url=new URL(request.url);const symbol=String(url.searchParams.get("symbol")||"").trim()||undefined;const requestedLimit=Number(url.searchParams.get("limit")||100);const limit=Math.min(Math.max(Number.isFinite(requestedLimit)?Math.floor(requestedLimit):100,1),500);try{return Response.json(await ctx.runQuery(api.monitor.latestCvd5mPeriods,{symbol,limit}));}catch{return new Response("CVD 5M stats query failed",{status:500});}});
const streakHitPeriods=httpAction(async(ctx,request)=>{const url=new URL(request.url);const symbol=String(url.searchParams.get("symbol")||"").trim()||undefined;const timeframe=String(url.searchParams.get("timeframe")||"").trim()||undefined;const requestedLimit=Number(url.searchParams.get("limit")||100);const limit=Math.min(Math.max(Number.isFinite(requestedLimit)?Math.floor(requestedLimit):100,1),500);try{return Response.json(await ctx.runQuery(api.monitor.latestStreakHitPeriods,{symbol,timeframe,limit}));}catch{return new Response("StreakHit stats query failed",{status:500});}});
const streakHits=httpAction(async(ctx,request)=>{const url=new URL(request.url);const symbol=String(url.searchParams.get("symbol")||"").trim()||undefined;const timeframe=String(url.searchParams.get("timeframe")||"").trim()||undefined;const requestedLimit=Number(url.searchParams.get("limit")||100);const limit=Math.min(Math.max(Number.isFinite(requestedLimit)?Math.floor(requestedLimit):100,1),500);try{return Response.json(await ctx.runQuery(api.monitor.latestStreakHits,{symbol,timeframe,limit}));}catch{return new Response("StreakHit hits query failed",{status:500});}});
const alerts=httpAction(async(ctx,request)=>{const url=new URL(request.url);const timeframe=String(url.searchParams.get("timeframe")||"").trim()||undefined;const symbol=String(url.searchParams.get("symbol")||"").trim()||undefined;const requestedLimit=Number(url.searchParams.get("limit")||50);const limit=Math.min(Math.max(Number.isFinite(requestedLimit)?Math.floor(requestedLimit):50,1),100);if(timeframe&&!['5m','15m','1h','4h'].includes(timeframe))return new Response("Invalid timeframe",{status:400});try{return Response.json(await ctx.runQuery(api.monitor.latestAlerts,{timeframe,symbol,limit}));}catch{return new Response("Alerts query failed",{status:500});}});
const tradingRecovery=httpAction(async(ctx,request)=>{
    if(!authorized(request))return new Response("Unauthorized",{status:401});
    const symbol=String(new URL(request.url).searchParams.get("symbol")||"BTC");
    try{return Response.json(await ctx.runQuery(api.monitor.getRecoveryState,{symbol}));}
    catch{return new Response("Recovery state query failed",{status:500});}
  });
const latestLiveTrades=httpAction(async(ctx,request)=>{
  if(!authorized(request))return new Response("Unauthorized",{status:401});
  const url=new URL(request.url);const symbol=url.searchParams.get("symbol")||undefined;
  const limit=Math.min(Math.max(Number(url.searchParams.get("limit")||20),1),100);
  try{return Response.json(await ctx.runQuery(api.monitor.latestLiveTrades,{symbol,limit}));}
  catch{return new Response("Live trade history query failed",{status:500});}
});
const openPaperTrade=httpAction(async(ctx,request)=>{if(!authorized(request))return new Response("Unauthorized",{status:401});try{return Response.json(await ctx.runQuery(api.monitor.getOpenPaperTrade,{}));}catch{return new Response("Paper state query failed",{status:500});}});
const latestPaperTrades=httpAction(async(ctx,request)=>{if(!authorized(request))return new Response("Unauthorized",{status:401});const limit=Math.min(Math.max(Number(new URL(request.url).searchParams.get("limit")||20),1),100);try{return Response.json(await ctx.runQuery(api.monitor.latestPaperTrades,{limit}));}catch{return new Response("Paper history query failed",{status:500});}});
http.route({path:"/ingest",method:"POST",handler:ingest});
http.route({path:"/holder-snapshot",method:"GET",handler:holderSnapshot});
http.route({path:"/holder-alert-state",method:"GET",handler:holderAlertState});
http.route({path:"/holder-alert-state",method:"POST",handler:setHolderAlertState});
http.route({path:"/claim-esports-alert",method:"POST",handler:claimEsportsAlert});
http.route({path:"/claim-crowd-flow-alert",method:"POST",handler:claimCrowdFlowAlert});
http.route({path:"/claim-cvd-5m-alert",method:"POST",handler:claimCvd5mAlert});
http.route({path:"/cvd-5m/latest-alert",method:"GET",handler:latestCvd5mAlert});
http.route({path:"/claim-liquidation-alert",method:"POST",handler:claimLiquidationAlert});
http.route({path:"/claim-rolling-alert",method:"POST",handler:claimRollingAlert});
http.route({path:"/release-rolling-alert",method:"POST",handler:releaseRollingAlert});
http.route({path:"/buy-snapshot",method:"POST",handler:buySnapshot});
http.route({path:"/buy-snapshots",method:"GET",handler:buySnapshots});
http.route({path:"/rolling-alert-status",method:"GET",handler:rollingAlertStatus});
http.route({path:"/health",method:"GET",handler:health});
http.route({path:"/marginpad-btc-liquidations",method:"GET",handler:marginpadBtcLiquidations});
const liquidationEvents=httpAction(async(ctx,request)=>{const url=new URL(request.url);const symbol=String(url.searchParams.get("symbol")||"BTC");const limit=Math.min(Math.max(Number(url.searchParams.get("limit")||100),1),500);try{return Response.json(await ctx.runQuery(api.monitor.latestLiquidationEvents,{symbol,limit}));}catch{return new Response("Liquidation events query failed",{status:500});}});
http.route({path:"/liquidation-events",method:"GET",handler:liquidationEvents});
http.route({path:"/runtime/status",method:"GET",handler:runtimeStatus});
http.route({path:"/runtime/logs",method:"GET",handler:runtimeLogs});
http.route({path:"/runtime/runs",method:"GET",handler:runtimeRuns});
http.route({path:"/latest-stats",method:"GET",handler:latestStats});
http.route({path:"/snapshots",method:"GET",handler:snapshots});
http.route({path:"/crowd-flow/periods",method:"GET",handler:crowdFlowPeriods});
http.route({path:"/cvd-5m/periods",method:"GET",handler:cvd5mPeriods});
http.route({path:"/streak-hit/periods",method:"GET",handler:streakHitPeriods});
http.route({path:"/streak-hit/hits",method:"GET",handler:streakHits});
http.route({path:"/alerts",method:"GET",handler:alerts});
http.route({path:"/trading/recovery",method:"GET",handler:tradingRecovery});
http.route({path:"/trading/history",method:"GET",handler:latestLiveTrades});
http.route({path:"/paper/open",method:"GET",handler:openPaperTrade});
http.route({path:"/paper/history",method:"GET",handler:latestPaperTrades});
export default http;
