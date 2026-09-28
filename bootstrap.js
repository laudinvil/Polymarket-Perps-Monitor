const fs = require("fs");
const path = require("path");

const runtimeLogFile = process.env.RUNTIME_LOG_FILE || "/data/deplexo-runtime.log";

function writeRuntime(event, data = {}) {
  try {
    fs.mkdirSync(path.dirname(runtimeLogFile), { recursive: true });
    fs.appendFileSync(runtimeLogFile, JSON.stringify({
      ts: new Date().toISOString(),
      event,
      ...data
    }) + "\n");
  } catch {}
}

process.on("uncaughtException", error => {
  writeRuntime("BOOTSTRAP_UNCAUGHT_EXCEPTION", { error: String(error && error.stack || error) });
  process.exit(1);
});

process.on("unhandledRejection", reason => {
  writeRuntime("BOOTSTRAP_UNHANDLED_REJECTION", { error: String(reason && reason.stack || reason) });
  process.exit(1);
});

writeRuntime("BOOTSTRAP_START", { command: process.argv.join(" "), node: process.version });

try {
  require("./monitor.js");
} catch (error) {
  writeRuntime("BOOTSTRAP_REQUIRE_ERROR", { error: String(error && error.stack || error) });
  process.exit(1);
}
