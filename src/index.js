const https = require('https');
const { DEFAULT_SYMBOLS, fetchSymbolFeed, normalizeTs, normalizeSymbol, bucketStart, eventKey } = require('./liquidation-monitor');
const { findCurrentMarket } = require('./polymarket');
const { sendTelegramMessage } = require('./telegram');

const symbols = ['BTC'];
