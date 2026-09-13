const fs = require('fs');
const path = require('path');
const { fetchFeed, eventKey, normalizeTs, DEFAULT_SYMBOLS, POLL_MS } = require('../src/liquidation-monitor');
const { bucketStart, findNextMarket, findMarketByEpoch, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage } = require('../src/telegram');

// Temporary restoration marker. Full source will be restored from the known-good commit before the next workflow run.
