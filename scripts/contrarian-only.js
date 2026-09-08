const fs = require('fs');
const path = require('path');
const Module = require('module');

const sourcePath = path.join(__dirname, '..', 'src', 'index.js');
let source = fs.readFileSync(sourcePath, 'utf8');

source = source.replace(
  "const INVERTED_DIRECTION_TIMEFRAMES = new Set(['15m']);",
  "const INVERTED_DIRECTION_TIMEFRAMES = new Set();",
);
source = source.replace(
  /async function sendLargestAlert[\\s\\S]*?async function sendContrarianAlert/,
  'async function sendContrarianAlert',
);
source = source.replace(
  /const effectiveSign=INVERTED_DIRECTION_TIMEFRAMES\.has\(timeframe\)\?-sign:sign;/g,
  'const effectiveSign=sign;',
);
source = source.replace(
  /if\(timeframe==='5m'\)return;const rows=[\\s\\S]*?await sendLargestAlert\(timeframe,period,rows\[0\]\);}/,
  '}',
);
source = source.replace(
  /Liquidation monitor started; 5m=6-vs-1 contrarian; 15m=inverted direction \+ largest \+ contrarian; 1h\/4h=largest \+ contrarian/,
  'Liquidation monitor started; 6-vs-1 contrarian only on 5m/15m/1h/4h',
);

const runtimeModule = new Module(sourcePath, module);
runtimeModule.filename = sourcePath;
runtimeModule.paths = module.paths;
runtimeModule._compile(source, sourcePath);
