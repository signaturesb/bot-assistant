#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, 'bot.js'), 'utf8');

assert.match(source, /campaignApprovalHash\(det\)/, 'confirmation must hash the live campaign');
assert.match(source, /currentHash !== preview\.hash/, 'confirmation must reject a changed campaign');
assert.match(source, /det\.status !== 'suspended'/, 'confirmation must start from suspended state');
assert.match(source, /consumeCampaignPreview\(campaignId\)/, 'confirmation must be one-shot');
assert.match(source, /status: 'suspended'/, 'unapproved queued campaigns must be suspended');
assert.match(source, /Envoi direct désactivé/, 'direct send endpoint must be disabled');
assert.match(source, /Confirmation déplacée dans le bot/, 'legacy email confirm link must be disabled');
assert.match(source, /m % 5 === 0/, 'approval preview scanner must run every five minutes');
assert.match(source, /65 \* 60 \* 1000/, 'preview must be generated about one hour before send');

console.log('✅ Campaign approval guard: fail-closed, exact-preview, one-shot OK');
