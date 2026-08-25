'use strict';

const assert = require('assert');
const fs = require('fs');

const code = fs.readFileSync('./bot.js', 'utf8');
const handler = code.match(/async function executeMatrixAnnexesTool[\s\S]*?\n}\n\nasync function executeTool/)?.[0] || '';
assert.ok(handler, 'executeMatrixAnnexesTool absent');

assert.match(handler, /modèle officiel SignatureSB est indisponible/,
  'un envoi client doit échouer fermé sans le modèle compagnie');
assert.match(handler, /multipart\/alternative/,
  'le MIME doit offrir une version texte et une version HTML');
assert.match(handler, /Content-Type: text\/plain; charset=UTF-8/);
assert.match(handler, /Content-Type: text\/html; charset=UTF-8/);
assert.match(handler, /filename\*=UTF-8''/,
  'les noms de fichiers UTF-8 doivent utiliser RFC 5987');
assert.match(handler, /replace\(\/\[\\r\\n\\0\]\+\/g/,
  'les valeurs externes ne doivent pas injecter des en-têtes MIME');
assert.match(handler, /24 \* 1024 \* 1024/,
  'la taille du MIME complet doit être contrôlée avant Gmail');
assert.match(handler, /const cc = emailDestination\.toLowerCase\(\) === AGENT\.email\.toLowerCase\(\) \? \[\] : \[AGENT\.email\]/,
  'Shawn doit être en Cc visible pour un client externe');
assert.match(handler, /attachments: documents\.map/,
  'le manifeste d’autorisation doit contenir toutes les pièces jointes');
assert.match(handler, /const clientInstruction = String\(messagePerso/,
  'les informations données après le numéro doivent devenir le message client');
assert.match(handler, /escapeHtml\(introText\)/,
  'le message personnalisé doit être échappé dans le template HTML');
assert.match(code, /UN SEUL courriel avec le modèle officiel SignatureSB/,
  'le routage doit demander un seul courriel contenant tous les PDF');

console.log('✅ Courriel Matrix: template obligatoire, MIME texte+HTML, UTF-8, Cc et limite Gmail');
