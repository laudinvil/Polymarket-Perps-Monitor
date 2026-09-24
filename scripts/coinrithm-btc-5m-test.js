const API = "https://api.coinrithm.com/api/prediction-markets";
const RUN_MS = 120000;

function isBtc5m(event) {
  const text = String(event?.title || "") + " " + String(event?.slug || "");
  return /\bbitcoin\b|\bbtc\b/i.test(text) && /5\s*min|5m|5-minute|5 minute/i.test(text);
}
function printEvent(e, prefix="MATCH") {
  const outcomes = Array.isArray(e?.outcomes) ? e.outcomes.map(o => `${o.name}=${o.probability}`).join(" | ") : "n/a";
  console.log(`[${new Date().toISOString()}] ${prefix}`);
  console.log(`  SOURCE: ${e?.source?.id || "n/a"}`);
  console.log(`  TITLE: ${e?.title || "n/a"}`);
  console.log(`  SLUG: ${e?.slug || "n/a"}`);
  console.log(`  END: ${e?.endDate || e?.end_date || "n/a"}`);
  console.log(`  OUTCOMES: ${outcomes}`);
  console.log(`  VOLUME24H: ${e?.volume24h ?? "n/a"}`);
  console.log(`  UPDATED: ${e?.sparkline?.capturedAt || "n/a"}`);
}
async function getJson(url) {
  const res = await fetch(url, {headers:{accept:"application/json"}});
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0,500)}`);
  return JSON.parse(body);
}
async function discover() {
  const urls = [
    `${API}/events?status=open&source=polymarket&q=Bitcoin%20Up%20or%20Down&limit=100`,
    `${API}/events?status=open&source=polymarket&q=BTC&limit=100`
  ];
  const all = [];
  for (const url of urls) {
    try {
      const d = await getJson(url);
      if (Array.isArray(d?.data)) all.push(...d.data);
    } catch(e) { console.log(`DISCOVERY ERROR: ${e.message}`); }
  }
  const unique = [...new Map(all.map(e => [`${e?.source?.id}:${e?.slug}`,e])).values()];
  const matches = unique.filter(isBtc5m);
  console.log(`DISCOVERY: ${unique.length} candidates, ${matches.length} BTC 5M matches`);
  matches.slice(0,5).forEach(e=>printEvent(e));
  return matches[0] || null;
}
async function detail(source, slug) {
  const d = await getJson(`${API}/events/${encodeURIComponent(source)}/${encodeURIComponent(slug)}`);
  const e = d?.event || d;
  printEvent(e, "DETAIL");
  if (Array.isArray(d?.crossSourceMatches)) {
    console.log(`CROSS-SOURCE MATCHES: ${d.crossSourceMatches.length}`);
    d.crossSourceMatches.slice(0,10).forEach(m=>console.log(`  ${m?.source?.id || m?.source || "?"}: ${m?.title || m?.slug || "?"}`));
  }
}
async function stream(slug) {
  console.log(`SSE: connecting target=${slug}`);
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), RUN_MS);
  try {
    const res = await fetch(`${API}/stream`, {headers:{accept:"text/event-stream","cache-control":"no-cache"},signal:controller.signal});
    console.log(`SSE: HTTP ${res.status}, content-type=${res.headers.get("content-type") || "n/a"}`);
    if (!res.ok || !res.body) throw new Error(`SSE unavailable: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const {value,done} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value,{stream:true});
      let cut;
      while ((cut=buffer.indexOf("\n\n"))>=0) {
        const raw=buffer.slice(0,cut); buffer=buffer.slice(cut+2);
        let name="message", data="";
        for (const line of raw.split("\n")) {
          if (line.startsWith("event:")) name=line.slice(6).trim();
          else if (line.startsWith("data:")) data+=line.slice(5).trim();
          else if (line.startsWith(":")) console.log(`SSE HEARTBEAT: ${new Date().toISOString()}`);
        }
        if (!data) continue;
        try {
          const p=JSON.parse(data);
          const rows=Array.isArray(p)?p:(Array.isArray(p?.data)?p.data:[p]);
          for (const x of rows) {
            const t=String(x?.title||""); const s=String(x?.slug||"");
            if (s.toLowerCase()===String(slug).toLowerCase() || (isBtc5m(x))) {
              console.log(`SSE EVENT ${name}: ${JSON.stringify(x).slice(0,3000)}`);
            }
          }
        } catch { console.log(`SSE EVENT ${name} RAW: ${data.slice(0,1000)}`); }
      }
    }
  } finally { clearTimeout(timer); }
}
(async()=>{
  console.log("=== CoinRithm BTC 5M TEST ===");
  console.log(`START: ${new Date().toISOString()}`);
  const e=await discover();
  if(!e){console.log("RESULT: no BTC 5M Polymarket event found");process.exitCode=2;return;}
  try{await detail(e?.source?.id||"polymarket",e.slug);}catch(err){console.log(`DETAIL ERROR: ${err.message}`);}
  try{await stream(e.slug);console.log("RESULT: SSE test completed");}
  catch(err){console.log(`SSE ERROR: ${err.name==="AbortError"?"timeout":err.message}`);process.exitCode=3;}
})();