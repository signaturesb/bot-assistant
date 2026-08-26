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
assert.match(handler, /const cc = emailDestination\.toLowerCase\(\) === REQUIRED_VISIBLE_CC_EMAIL \? \[\] : \[REQUIRED_VISIBLE_CC_EMAIL\]/,
  'Shawn doit être en Cc visible pour un client externe');
assert.match(handler, /attachments: documents\.map/,
  'le manifeste d’autorisation doit contenir toutes les pièces jointes');
assert.match(handler, /const clientInstruction = String\(messagePerso/,
  'les informations données après le numéro doivent devenir le message client');
assert.match(handler, /escapeHtml\(introText\)/,
  'le message personnalisé doit être échappé dans le template HTML');
assert.match(handler, /const listingAddress = \/\^\\d\{1,6\}/,
  'l’adresse affichée doit provenir d’une valeur Matrix structurellement valide');
assert.match(handler, /TERRITOIRES: listingAddress \? `Centris #\$\{num\} ·/,
  'l’adresse doit apparaître à côté du numéro Centris dans l’en-tête');
assert.match(handler, /TITRE_SECTION_1: 'Dossier complet et vérifié'/);
assert.match(handler, /PRIX_MEDIAN: `\$\{documents\.length\} PDF`/);
assert.match(handler, /VARIATION_PRIX: totalPages \? `\$\{totalPages\} pages validées`/);
assert.match(handler, /TABLEAU_STATS_HTML: verificationHtml/);
assert.match(handler, /CONTENU_STRATEGIE: guidanceHtml/);
assert.match(handler, /01\\s\*·\\s\*Données du marché[\s\S]*?01 · Dossier documentaire/,
  'les intitulés génériques vides doivent devenir des sections documentaires utiles');
assert.match(code, /UN SEUL courriel avec le modèle officiel SignatureSB/,
  'le routage doit demander un seul courriel contenant tous les PDF');
assert.match(code, /EMAIL_SHAWN_VISIBLE_CC_REQUIRED/,
  'le garde central Gmail doit bloquer tout tiers sans Cc Shawn visible');
assert.match(code, /const hasExternalGmailRecipient[\s\S]*?const hasVisibleShawnCc/,
  'le contrôle Cc doit être calculé sur le payload exact remis au provider');
const genericGmail = code.match(/async function envoyerEmailGmail[\s\S]*?\n}\n\n\/\/ ─── Réponse rapide mobile/)?.[0] || '';
assert.ok(genericGmail, 'envoyerEmailGmail absent');
assert.match(genericGmail, /const toHeader\s*=\s*safeTo/,
  'le To MIME générique doit utiliser seulement l’adresse normalisée');
assert.match(genericGmail, /\.\.\.\(cc\.length \? \[`Cc:/,
  'le brouillon Gmail externe doit inclure Shawn en Cc visible');
assert.doesNotMatch(genericGmail, /Bcc: \$\{AGENT\.email\}/,
  'une copie Bcc ne doit jamais remplacer le Cc visible demandé');

console.log('✅ Courriel Matrix: template obligatoire, MIME texte+HTML, UTF-8, Cc et limite Gmail');
