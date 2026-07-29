#!/usr/bin/env node
'use strict';
const cmd = (process.argv[2] || '').toLowerCase();
if (cmd === 'version' || cmd === '-v' || cmd === '--version') {
  console.log(require('../package.json').version);
  process.exit(0);
}
require('../dist/bot').main();
