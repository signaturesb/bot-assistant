'use strict';

const assert = require('assert');
const fs = require('fs');

const code = fs.readFileSync(require.resolve('./bot.js'), 'utf8');

assert.match(code, /dbx_liste_terrains:\s*process\.env\.DBX_LISTE_TERRAINS/);
assert.match(code, /async function envoyerListeTerrains/);
assert.match(code, /downloadDropboxFile\(sourcePath\)/);
assert.match(code, /file\.buffer\.subarray\(0, 4\)\.toString\(\) !== '%PDF'/);
assert.match(code, /name: 'envoyer_liste_terrains'/);
assert.match(code, /envoyer_liste_terrains:\s*input\.email/);
assert.match(code, /case 'envoyer_liste_terrains': return await envoyerListeTerrains\(input, userMessage\)/);
assert.match(code, /createOneShotAuthorization\(\{ message: confirmationMessage, \.\.\.emailPayload \}\)/);
assert.match(code, /category: 'liste-terrains-signaturesb'/);

console.log('✅ Liste terrains: intégration Dropbox, Gmail et garde de confirmation présentes');
