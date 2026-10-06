const fs = require("fs");
const path = require("path");

const STATE_DIR = path.join(__dirname, "state");

const DEFAULTS = {
  markets: {},
  predictions: {},
  cursors: { batches: {} },
  seenTrades: [],
  metrics: {},
};

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

function loadJson(name, fallback) {
  ensureStateDir();
  const file = path.join(STATE_DIR, name);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(name, value) {
  ensureStateDir();
  const file = path.join(STATE_DIR, name);
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function loadState() {
  return {
    markets: loadJson("markets.json", DEFAULTS.markets),
    predictions: loadJson("predictions.json", DEFAULTS.predictions),
    cursors: loadJson("cursors.json", DEFAULTS.cursors),
    seenTrades: loadJson("seen-trades.json", DEFAULTS.seenTrades),
    metrics: loadJson("metrics.json", DEFAULTS.metrics),
  };
}

function saveState(state) {
  saveJson("markets.json", state.markets);
  saveJson("predictions.json", state.predictions);
  saveJson("cursors.json", state.cursors);
  saveJson("seen-trades.json", state.seenTrades);
  saveJson("metrics.json", state.metrics);
}

module.exports = { STATE_DIR, loadState, saveState };
