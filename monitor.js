import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const SOURCE = "https://polymarket.com/sports/soccer/games";
let lastPoll = null;
let lastError = null;

async function poll() {
  try {
    const doh = await fetch("https://cloudflare-dns.com/dns-query?name=polymarket.com&type=A", {
      headers: {"accept":"application/dns-json"},
      signal: AbortSignal.timeout(5000)
    });
    if (!doh.ok) throw new Error("DoH HTTP " + doh.status);
    const data = await doh.json();
    const ip = data.Answer?.find(x => x.type === 1)?.data;
    if (!ip) throw new Error("DoH returned no IPv4");
    lastPoll = new Date().toISOString();
    lastError = "DoH OK: " + ip;
    console.log("DOH OK", ip);
  } catch (e) {
    lastPoll = new Date().toISOString();
    lastError = String(e.message || e);
    console.log("NETWORK ERROR", lastError);
  }
}

const server = http.createServer((req,res) => {
  res.writeHead(200, {"content-type":"application/json"});
  res.end(JSON.stringify({ok:true,service:"polymarket-live-soccer-monitor",source:SOURCE,lastPoll,lastError}));
});

server.listen(PORT,"0.0.0.0",() => {
  console.log("MONITOR STARTING");
  console.log("HEALTH LISTENING",PORT);
  poll();
  setInterval(poll,15000);
});
