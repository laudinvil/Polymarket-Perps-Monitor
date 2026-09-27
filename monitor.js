import http from "node:http";

const PORT = Number(process.env.PORT || 3000);
const SOURCE = "https://polymarket.com/ru/sports/soccer/games";
let lastPoll = null;
let lastError = null;

async function poll() {
  try {
    const response = await fetch(SOURCE, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10000)
    });
    lastPoll = new Date().toISOString();
    lastError = response.ok ? null : "HTTP " + response.status;
    console.log("POLL", response.status);
  } catch (error) {
    lastPoll = new Date().toISOString();
    lastError = String(error.message || error);
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
