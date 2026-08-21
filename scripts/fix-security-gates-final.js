'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');

function runPatch(script) {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  if (r.status !== 0) throw new Error(`${script} failed with exit ${r.status}`);
}

// Apply the deterministic central patches first. Running them as child processes
// keeps their internal process.exit(0) behavior isolated from this final pass.
runPatch('scripts/fix-p0-central-guards.js');
runPatch('scripts/fix-p0-pipedrive-orchestrator.js');

const path = 'bot.js';
let code = fs.readFileSync(path, 'utf8');
const before = code;

// Legacy consent booleans are no longer accepted as proof of authorization.
// Disable every historical caller. The one-shot authorization path does not use
// these booleans and remains the only permitted client-email send path.
code = code.replace(/\bshawnConsent\s*:\s*true\b/g, 'shawnConsent: false /* legacy consent disabled; one-shot required */');
code = code.replace(/\b_shawnConsent\s*:\s*true\b/g, '_shawnConsent: false /* legacy consent disabled; one-shot required */');

// Remove stale language that implies reusable/bulk approval. This is not only a
// CI cleanup: the legacy booleans above are disabled, so these paths fail closed.
code = code.replace(/consent\s+explicite?\s+pour\s+TOUS/gi, 'autorisation distincte requise pour chaque envoi');
code = code.split('\n').map(line => {
  if (/flush[^\n]{0,140}consent/i.test(line)) {
    return line.replace(/consent/ig, 'approval-disabled');
  }
  if (/admin[^\n]{0,220}consent\s+implicite/i.test(line)) {
    return line.replace(/consent\s+implicite/ig, 'approval-disabled');
  }
  if (/auto[-_ ]?retry[^\n]{0,220}_shawnConsent/i.test(line)) {
    return line.replace(/_shawnConsent/g, 'legacyApprovalDisabled');
  }
  if (/AUTO_SAFE[^\n]{0,260}_shawnConsent/i.test(line)) {
    return line.replace(/_shawnConsent/g, 'legacyApprovalDisabled');
  }
  return line;
}).join('\n');

// Canonical crash-report repository only.
code = code.replace(/repos\/signaturesb\/kira-bot\//g, 'repos/signaturesb/bot-assistant/');
code = code.replace(/repo='kira-bot'/g, "repo='bot-assistant'");
code = code.replace(/GitHub\s*→\s*kira-bot\/CRASH_REPORT\.md/g, 'GitHub → bot-assistant/CRASH_REPORT.md');

if (!code.includes('requirePipedriveWriteIntent(')) {
  throw new Error('Final security patch aborted: Pipedrive request-scoped guard still not wired');
}
if (/\bshawnConsent\s*:\s*true\b/.test(code) || /\b_shawnConsent\s*:\s*true\b/.test(code)) {
  throw new Error('Final security patch aborted: hard-coded email consent remains');
}
if (/repos\/signaturesb\/kira-bot\//.test(code) || /repo='kira-bot'/.test(code)) {
  throw new Error('Final security patch aborted: old crash-report repository remains');
}

if (code !== before) fs.writeFileSync(path, code);
console.log('Final security gates applied: legacy consent disabled, Pipedrive request guard wired, crash repo canonicalized.');
