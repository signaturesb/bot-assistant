'use strict';

const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const code = fs.readFileSync(require.resolve('./bot.js'), 'utf8');

assert.match(code, /async function buildTransactionalEmailFromMaster/);
assert.match(code, /await buildEmailFromMasterTpl\(/);
assert.match(code, /Groupe Immobilier SignatureSB · RE\/MAX PRESTIGE/);
assert.match(code, /EMAIL_BRAND_TEMPLATE_UNAVAILABLE/);
assert.match(code, /renderedHtmlSha256/);
assert.match(code, /await envoyerEmailGmail\(\{ \.\.\.action, authorization, renderedHtml \}\)/);
assert.match(code, /SignatureSB officiel Dropbox · logos \+ couleurs/);
assert.doesNotMatch(
  code.match(/async function envoyerEmailGmail[\s\S]*?\n\}/)?.[0] || '',
  /HTML branded dynamique \(utilise AGENT_CONFIG\)/
);

const helperStart = code.indexOf('function transactionalEmailParts(texte)');
const helperEnd = code.indexOf('async function buildTransactionalEmailFromMaster', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'helper transactionnel introuvable');
const helperSource = code.slice(helperStart, helperEnd);
const sandbox = {};
vm.runInNewContext(helperSource, sandbox);

const duplicateSignature = sandbox.transactionalEmailParts(`Bonjour,\n\nMerci de votre intérêt.\n\nAu plaisir,\nShawn Barrette\nCourtier immobilier | RE/MAX PRESTIGE\n514-927-1340\nshawn@signaturesb.com`);
assert.strictEqual(duplicateSignature.greeting, 'Bonjour,');
assert.match(duplicateSignature.body, /Merci de votre intérêt\./);
assert.match(duplicateSignature.body, /Au plaisir,/);
assert.doesNotMatch(duplicateSignature.body, /Shawn Barrette|Courtier immobilier|514-927-1340|shawn@signaturesb\.com/);

const customClosing = sandbox.transactionalEmailParts('Bonjour,\n\nMerci.\n\nAu plaisir,\nVotre équipe de projet');
assert.match(customClosing.body, /Votre équipe de projet/);

assert.match(code, /Toute réponse, relance, demande de feedback/);
assert.doesNotMatch(fs.readFileSync(require.resolve('./ASSETS_OFFICIELS.md'), 'utf8'), /Fallback inline HTML si Dropbox indispo/);

console.log('✅ Réponses Gmail: master Dropbox obligatoire, HTML lié à la confirmation');
