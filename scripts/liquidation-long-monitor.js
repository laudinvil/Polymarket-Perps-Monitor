const fs = require('fs');
const path = require('path');
const { fetchFeed, eventKey, normalizeTs, DEFAULT_SYMBOLS, POLL_MS } = require('../src/liquidation-monitor');
const { bucketStart, findNextMarket, findMarketByEpoch, findClobMidpoint } = require('../src/polymarket');
const { sendTelegramMessage, editTelegramMessage } = require('../src/telegram');

// NOTE: preserve all existing monitor logic; only paper-result delivery is changed.
