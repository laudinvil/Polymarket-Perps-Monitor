import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const SOURCE = "https://polymarket.com/sports/soccer/games";
let lastPoll = null;
let lastError = null;

async function poll() {
  try {
    const dns = await import("node:dns/promises");
    const lookup = await dns.lookup("polymarket.com", {all:true});
    console.log("DNS", JSON.stringify(lookup));

    const response = await fetch(SOURCE, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000)
    });

    lastPoll = new Date().toISOString();
    lastError = response.ok ? null : "HTTP " + response.status;
    console.log("POLL", response.status, response.headers.get("content-type"));
  } catch (error) {
    lastPoll = new Date().toISOString();
    lastError = (error && error.cause)
      ? String(error.message || error) + " | cause=" + JSON.stringify({
          name: error.cause.name,
          code: error.cause.code,
          message: error.cause.message,
          syscall: error.cause.syscall,
          hostname: error.cause.hostname
        })
      : String(error.message || error);
    console.log("POLL ERROR", lastError);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    service: "polymarket-live-soccer-monitor",
    source: SOURCE,
    lastPoll,
    lastError
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("MONITOR STARTING");
  console.log("HEALTH LISTENING", PORT);
  poll();
  setInterval(poll, 15000);
});
