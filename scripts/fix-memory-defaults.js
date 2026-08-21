'use strict';

// Deterministic audit-branch autofix for unreachable memory compaction defaults.
// Uses regexes so formatting changes in bot.js do not silently break the fixer.
const fs = require('fs');
const path = 'bot.js';
let code = fs.readFileSync(path, 'utf8');

const before = code;

function replaceDefault(name, fromValue, toValue) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*parseInt\\(process\\.env\\.${name}\\s*\\|\\|\\s*['\"]${fromValue}['\"]\\);`);
  if (!re.test(code)) {
    const already = new RegExp(`const\\s+${name}\\s*=\\s*parseInt\\(process\\.env\\.${name}\\s*\\|\\|\\s*['\"]${toValue}['\"]\\);`);
    if (already.test(code)) return;
    throw new Error(`Expected ${name} default ${fromValue} not found and target ${toValue} not already present`);
  }
  code = code.replace(re, `const ${name} = parseInt(process.env.${name} || '${toValue}');`);
}

replaceDefault('MAX_HIST', '500', '1200');
replaceDefault('SUMMARY_AT', '600', '600');
replaceDefault('SUMMARY_KEEP', '300', '300');

if (code === before) {
  console.log('Memory defaults already compliant; no change.');
  process.exit(0);
}

fs.writeFileSync(path, code);
console.log('Updated memory defaults: MAX_HIST=1200 SUMMARY_AT=600 SUMMARY_KEEP=300');
