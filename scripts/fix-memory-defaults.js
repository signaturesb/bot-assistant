'use strict';

const fs = require('fs');
const path = 'bot.js';
let code = fs.readFileSync(path, 'utf8');

const replacements = [
  ["const MAX_HIST       = parseInt(process.env.MAX_HIST || '500');", "const MAX_HIST       = parseInt(process.env.MAX_HIST || '1200');"],
  ["const SUMMARY_AT     = parseInt(process.env.SUMMARY_AT || '600');", "const SUMMARY_AT     = parseInt(process.env.SUMMARY_AT || '600');"],
  ["const SUMMARY_KEEP   = parseInt(process.env.SUMMARY_KEEP || '300');", "const SUMMARY_KEEP   = parseInt(process.env.SUMMARY_KEEP || '300');"],
];

let changed = false;
for (const [from, to] of replacements) {
  if (from === to) continue;
  if (!code.includes(from)) {
    throw new Error(`Expected memory config not found: ${from}`);
  }
  code = code.replace(from, to);
  changed = true;
}

if (!changed) {
  console.log('Memory defaults already compliant; no change.');
  process.exit(0);
}

fs.writeFileSync(path, code);
console.log('Updated memory defaults: MAX_HIST=1200 SUMMARY_AT=600 SUMMARY_KEEP=300');
