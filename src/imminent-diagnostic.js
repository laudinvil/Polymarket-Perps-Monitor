const PINAX_API_KEY=process.env.PINAX_API_KEY||process.env.PINAX_API_TOKEN;
const ASSETS=['BTC','ETH','XRP','SOL','DOGE','HYPE','BNB'];
const PINAX_ACTIVITY_URL='https://api.pinax.network/v1/hyperliquid/markets/activity';
const PINAX_USERS_URL='https://api.pinax.network/v1/hyperliquid/users';
const HL_INFO_URL='https://api.hyperliquid.xyz/info';
const LOOKBACK_MS=Number(process.env.IMMINENT_LIQUIDATION_LOOKBACK_MS||1800000);
const THRESHOLD_PCT=Number(process.env.IMMINENT_LIQUIDATION_PCT||1.95);
const MIN_USD=1000;
const LIMIT=10;

if(!PINAX_API_KEY) throw Error('PINAX_API_KEY/PINAX_API_TOKEN is not configured');

async function pinax(url){
  const t0=Date.now();
  const r=await fetch(url,{headers:{Authorization:`Bearer ${PINAX_API_KEY}`,Accept:'application/json'}});
  const t1=Date.now();
  const text=await r.text();
  if(!r.ok) throw Error(`Pinax HTTP ${r.status}: ${text.slice(0,300)}`);
  return {body:JSON.parse(text),latency:t1-t0,requested:t0,received:t1};
}

async function hl(body){
  const t0=Date.now();
  const r=await fetch(HL_INFO_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const t1=Date.now();
  if(!r.ok) throw Error(`Hyperliquid HTTP ${r.status}`);
  return {body:await r.json(),latency:t1-t0,requested:t0,received:t1};
}

function pct(side,mark,liq){return side==='Long'?((mark-liq)/mark)*100:((liq-mark)/mark)*100;}
function usd(v){return `$${Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}`;}

async function main(){
  const started=Date.now();
  console.log(`[DIAG] started=${new Date(started).toISOString()} threshold=${THRESHOLD_PCT}% min=${usd(MIN_USD)} lookback=${LOOKBACK_MS/60000}m`);
  const markRes=await hl({type:'metaAndAssetCtxs',dex:''});
  const marks=new Map();
  for(let i=0;i<(markRes.body?.[0]?.universe||[]).length;i++){
    const c=markRes.body[0].universe[i]?.name, p=Number(markRes.body?.[1]?.[i]?.markPx);
    if(c&&p>0) marks.set(c,p);
  }
  console.log(`[HYPERLIQUID][MARKS] latency=${markRes.latency}ms`);
  const grand={pinaxUsers:0,uniqueUsers:0,hlChecks:0,positions:0,belowMin:0,qualifying:0,errors:0};
  for(const coin of ASSETS){
    const now=Date.now();
    const u=new URL(PINAX_ACTIVITY_URL);
    u.searchParams.set('coin',coin);u.searchParams.set('dex','perps');
    u.searchParams.set('start_time',new Date(now-LOOKBACK_MS).toISOString());u.searchParams.set('end_time',new Date(now).toISOString());
    u.searchParams.set('limit',String(LIMIT));u.searchParams.set('page','1');
    try{
      const a=await pinax(u); const rows=Array.isArray(a.body?.data)?a.body.data:[];
      const activityUsers=[...new Set(rows.map(x=>String(x?.user||'').toLowerCase()).filter(Boolean))];
      const topUrl=new URL(PINAX_USERS_URL);topUrl.searchParams.set('coin',coin);topUrl.searchParams.set('dex','perps');topUrl.searchParams.set('interval','1h');topUrl.searchParams.set('sort_by','total_volume');topUrl.searchParams.set('limit',String(LIMIT));topUrl.searchParams.set('page','1');
      const top=await pinax(topUrl); const topUsers=(Array.isArray(top.body?.data)?top.body.data:[]).map(x=>String(x?.user||'').toLowerCase()).filter(Boolean);
      const users=[...new Set([...activityUsers,...topUsers])];
      let hlChecks=0,positions=0,belowMin=0,qualifying=0,best=null;
      for(const user of users){
        const s=await hl({type:'clearinghouseState',user,dex:''}); hlChecks++;
        for(const w of Array.isArray(s.body?.assetPositions)?s.body.assetPositions:[]){
          const p=w?.position; if(p?.coin!==coin) continue; positions++;
          const value=Math.abs(Number(p?.positionValue)); if(Number.isFinite(value)&&value<MIN_USD){belowMin++;continue;}
          const size=Number(p?.szi),liq=Number(p?.liquidationPx),mark=marks.get(coin); if(!size||!Number.isFinite(liq)||!mark) continue;
          const side=size>0?'Long':'Short',distance=pct(side,mark,liq);
          if(Number.isFinite(distance)&&distance>=0&&distance<=THRESHOLD_PCT){qualifying++;const x={user,side,value,distance,liq};if(!best||distance<best.distance)best=x;}
        }
      }
      grand.pinaxUsers+=activityUsers.length;grand.uniqueUsers+=users.length;grand.hlChecks+=hlChecks;grand.positions+=positions;grand.belowMin+=belowMin;grand.qualifying+=qualifying;
      console.log(`[COIN][${coin}] pinaxActivityRows=${rows.length} activityUsers=${activityUsers.length} topUsers=${topUsers.length} uniqueCandidates=${users.length} hlChecks=${hlChecks} positions=${positions} belowMin=${belowMin} qualifying=${qualifying}${best?` best=${best.side} ${usd(best.value)} ${best.distance.toFixed(4)}% liq=${usd(best.liq)}`:''}`);
    }catch(e){grand.errors++;console.error(`[COIN][${coin}][ERROR] ${e?.message??e}`);}
  }
  console.log(`[SUMMARY] pinaxActivityUsers=${grand.pinaxUsers} uniqueCandidates=${grand.uniqueUsers} hyperliquidChecks=${grand.hlChecks} positions=${grand.positions} belowMin=${grand.belowMin} qualifying=${grand.qualifying} errors=${grand.errors} totalMs=${Date.now()-started}`);
}
main().catch(e=>{console.error(`[FATAL] ${e?.stack??e}`);process.exitCode=1;});
