'use strict';

const fs = require('fs');
const assert = require('assert');

const code = fs.readFileSync('scripts/brevo_readonly_diagnostic.js', 'utf8');

assert.ok(code.includes("method: 'GET'"), 'Brevo diagnostic must use GET requests');
assert.ok(!/method:\s*['\"](?:POST|PUT|PATCH|DELETE)['\"]/i.test(code), 'Brevo diagnostic contains a write HTTP method');
assert.ok(!/\/emailCampaigns\/\{?[^\n]*\/send/i.test(code), 'Brevo diagnostic must not call campaign send endpoints');
assert.ok(!/smtp\/email|transactionalSMS\/sms|contacts\/import|contacts\/export/i.test(code), 'Brevo diagnostic contains a potentially mutating endpoint');
assert.ok(/SAFE_ENDPOINTS/.test(code), 'Brevo diagnostic must use an explicit allowlist');
assert.ok(/sanitize\(/.test(code), 'Brevo diagnostic must sanitize output');

console.log('✅ Brevo diagnostic is READ-ONLY');
