'use strict';

const assert = require('assert');
const fs = require('fs');

const code = fs.readFileSync('./bot.js', 'utf8');
const handler = code.match(/async function executeMatrixAnnexesTool[\s\S]*?\n}\n\nasync function executeTool/)?.[0] || '';
assert.ok(handler, 'executeMatrixAnnexesTool absent');
assert.match(handler, /pendingExternalEmailActions\.set/);
assert.match(handler, /deferActivePendingEmail\(chatId\)/,
  'une nouvelle demande Matrix doit désarmer tout ancien brouillon avant même un échec de taille');
assert.doesNotMatch(handler, /encodedBytes > 22 \* 1024 \* 1024/,
  'une estimation partielle à 22 MB ne doit pas rejeter un MIME complet encore admissible');
assert.match(handler, /mimeBytes > gmailApiMaxMessageBytes/,
  'la limite officielle doit être évaluée sur le MIME complet avec toutes les pièces');
assert.match(handler, /matrixPreviewExpiresAt: Date\.now\(\) \+ MATRIX_PREVIEW_TTL_MS/);
assert.match(handler, /approvedPreview\.matrixFingerprint !== payloadFingerprint/);
assert.match(handler, /telegramReceipt\?\.message_id/);
assert.match(handler, /previewReceipt\?\.message_id/);
assert.match(handler, /Aucun courriel n'est armé/);
assert.match(handler, /pendingExternalEmailActions\.set\(chatId, pendingMatrixPreview\)/);
assert.match(handler, /if \(!chatId\)[\s\S]*?Aucun courriel n'est armé/,
  'aucune confirmation Matrix ne doit être armée sans conversation Telegram vérifiable');
assert.ok(
  handler.indexOf('const token = await getGmailToken()') >
    handler.indexOf('approvedPreview.matrixFingerprint !== payloadFingerprint'),
  'OAuth Gmail doit être demandé après l’aperçu et sa validation, jamais avant le preview Telegram',
);
assert.ok(
  handler.indexOf('pendingExternalEmailActions.set(chatId, pendingMatrixPreview)') >
    handler.indexOf('if (!previewReceipt?.message_id)'),
  'la confirmation ne doit être armée qu’après un accusé Telegram vérifié',
);
assert.match(handler, /renderedHtmlSha256/);
assert.match(code, /const pendingMatrixArtifacts = new Map\(\)/);
assert.match(code, /let pendingMatrixRequestQueue = \[\]/,
  'plusieurs inscriptions pour le même destinataire doivent utiliser une file dédiée');
assert.match(code, /matrixQueue: pendingMatrixRequestQueue\.slice/,
  'la file Matrix doit survivre aux redéploiements');
assert.match(code, /function enqueueMatrixRequests/);
assert.match(code, /async function startNextQueuedMatrixRequest/);
assert.match(code, /const directMatrixBatchRequest = parseDirectMatrixBatchRequest\(text\)/,
  'une commande Telegram peut contenir plusieurs numéros et un destinataire exact');
assert.match(code, /const matrixStarted = await startNextQueuedMatrixRequest\(chatId\)/,
  'après un succès, la prochaine inscription doit préparer son aperçu sans écraser la précédente');
assert.match(handler, /les PDF figés de l’aperçu Matrix/);
assert.match(handler, /pendingMatrixArtifacts\.set\(chatId/);
assert.match(handler, /writeMatrixArtifactCache\(/,
  'les PDF du preview doivent être figés dans un cache privé avant d’armer la confirmation');
assert.match(code, /function hydrateMatrixArtifactForAction/);
assert.match(code, /loadMatrixArtifactCache\(/,
  'un redémarrage doit recharger puis revalider le cache exact au lieu de produire un faux PDF expiré');
assert.match(handler, /forceDurableReload: isSendConfirmation/,
  'la confirmation finale doit relire les PDF du cache durable et recalculer leur intégrité');
assert.match(code, /exact && !forceDurableReload/,
  'une copie RAM ne doit jamais court-circuiter la revalidation finale du cache');
assert.match(code, /removeMatrixArtifactCache\(DATA_DIR/,
  'annulation, expiration, correction et succès doivent nettoyer le cache privé');
assert.match(handler, /listing: result\.listing \|\| null/,
  'l’adresse Matrix doit être figée avec les PDF du preview');
assert.match(handler, /listing: cachedArtifact\.listing \|\| null/,
  'la confirmation doit réutiliser la même adresse sans nouvelle recherche');
assert.match(handler, /pendingMatrixArtifacts\.delete\(chatId\)/);
assert.match(handler, /gmailProviderReceipt\?\.id/);
assert.match(handler, /Preuve Gmail:/);
assert.match(handler, /verifyGmailSentFolder\(/,
  'un reçu messages\/send doit être suivi d’une vérification en lecture seule du message exact dans Envoyés');
assert.match(handler, /scheduleGmailControlCopyVerification\(/,
  'la copie Shawn doit être surveillée en arrière-plan sans relance fournisseur');
assert.match(handler, /Gmail a accepté le message et le destinataire exact est confirmé dans Envoyés/,
  'le résultat utilisateur doit distinguer acceptation Gmail, dossier Envoyés et livraison finale');
assert.match(handler, /Aucune relance automatique/,
  'une vérification de livraison ne doit jamais réexpédier les pièces jointes');
assert.match(handler, /APERÇU HTML — aucun envoi/);
assert.match(handler, /const workflowRequestId = String\([\s\S]*?matrixRequestId\(\)/,
  'un seul identifiant de corrélation doit être créé avant Matrix puis réutilisé par l’aperçu');
assert.match(handler, /const requestId = workflowRequestId/,
  'l’aperçu doit conserver le même identifiant que le téléchargement et la télémétrie');
assert.match(handler, /clientOverride[\s\S]*?resolveMatrixClientContext\(emailDestination, num\)/,
  'le client vient de Pipedrive ou d’une correction Telegram explicite revalidée');
assert.match(handler, /returnedCentris !== String\(num\)/);
assert.match(handler, /l’adresse complète \(rue et municipalité\)/);
assert.match(handler, /result\?\.listing\?\.address_complete === true/);
assert.match(handler, /listingAddressSource !== 'matrix-listing-report-pdf'/);
assert.match(handler, /const computedSha256 = crypto\.createHash\('sha256'\)\.update\(buffer\)\.digest\('hex'\)/,
  'le bot doit recalculer lui-même le SHA-256 des octets avant tout aperçu');
assert.match(handler, /reportedSha256 && reportedSha256 !== computedSha256/,
  'une empreinte amont incohérente doit bloquer le workflow');
assert.match(handler, /matrixClientEligibility\(approvedPreview\.client \|\| \{\}\)/);
assert.match(handler, /État Gmail incertain/);
assert.match(handler, /Gmail bloqué avant livraison/);
assert.match(handler, /if \(!isSendConfirmation && ALLOWED_ID && chatId\)/);
assert.match(handler, /PDF\(s\) Matrix #\$\{num\} validés\. Remise des pièces et préparation de l’aperçu en cours/,
  'une opération Matrix longue doit rendre sa progression visible sans annoncer un faux succès courriel');
assert.match(handler, /PDF Telegram \$\{index \+ 1\}\/\$\{documents\.length\} confirmé/,
  'chaque remise Telegram doit produire une preuve de progression exploitable');
assert.match(handler, /Aperçu \$\{requestId\} armé pour #\$\{num\}/,
  'le journal doit distinguer clairement la création de l’aperçu de l’envoi Gmail');
assert.match(handler, /String\(chatId\) !== String\(ALLOWED_ID\)/,
  'Matrix doit être inaccessible depuis tout autre chat Telegram');
assert.match(handler, /Confirmation refusée:.*PDF ont changé/s);
assert.ok(code.includes('Ne jamais conclure « courtier concurrent / accès restreint » sans un code HTTP 401/403 observé'));
assert.ok(code.includes('ne jamais créer/prétendre sauvegarder chatgpt_config.md'));
assert.ok(code.includes('ne jamais déclarer les documents inaccessibles à cause du courtier sans preuve 401/403'));
assert.ok(code.includes("name !== 'telecharger_annexes_centris'"), 'le preview Matrix doit passer avant le garde générique');
assert.ok(code.includes('parseDirectMatrixRequest(text)'),
  'la commande Matrix naturelle doit être reconnue sans choix du modèle');
assert.match(code, /if \(directMatrixBatchRequest \|\| directMatrixRequest\)[\s\S]*?enqueueMatrixRequests[\s\S]*?startNextQueuedMatrixRequest/,
  'la demande directe doit entrer dans la file déterministe puis ouvrir son aperçu');
assert.match(code, /directMatrixRequest[\s\S]*?Aucun email envoyé/,
  'la demande directe ne doit jamais être interprétée comme la confirmation Gmail');
assert.match(code, /looksLikeMatrixSendWithoutEmail\(text\)[\s\S]*?Il me manque seulement le courriel du client/,
  'un numéro sans destinataire doit être bloqué avant toute recherche ou inférence');
assert.match(code, /looksLikeMatrixSendCommand\(text\)[\s\S]*?Commande Matrix ambiguë ou adresse courriel invalide/,
  'une commande avec plusieurs numéros ou destinataires doit être bloquée avant Claude');
assert.match(code, /action\.name === 'telecharger_annexes_centris'[\s\S]*?\^🔒 Confirmation refusée:[\s\S]*?pendingExternalEmailActions\.delete\(chatId\)/);

// Le mot seul « envoie » ne reconstruit jamais le numéro ou le destinataire:
// il reprend l'action exacte figée dans pendingExternalEmailActions.
const confirmationHandler = code.match(/async function handleEmailConfirmation[\s\S]*?\n}\n\n\/\/ ─── Handlers Telegram/)?.[0] || '';
assert.ok(confirmationHandler, 'handleEmailConfirmation absent');
assert.match(confirmationHandler, /const firstConfirmation = CONFIRM_REGEX\.test\(text\)/);
assert.match(confirmationHandler, /const external = pendingExternalEmailActions\.get\(chatId\)/);
assert.match(confirmationHandler, /executeTool\(\s*action\.name,\s*action\.input,\s*chatId,\s*'envoie'/);
assert.doesNotMatch(confirmationHandler, /action\.input\s*=|email_destination\s*=|centris_num\s*=/,
  'la confirmation ne doit pas reconstruire ou modifier le destinataire/numéro du preview');
assert.match(confirmationHandler, /reply_to_message\?\.message_id/,
  'les anciens prompts de confirmation déjà émis restent vérifiables');
assert.match(confirmationHandler, /const directSelection = firstConfirmation/,
  '« envoie » doit sélectionner directement la transaction unique active');
assert.match(confirmationHandler, /finalConfirmationMessageId/);
assert.match(confirmationHandler, /confirmationStage === 'awaiting-final'/);
assert.match(confirmationHandler, /Plusieurs actions courriel sont en attente[\s\S]*?Aucune priorité automatique/,
  'deux actions simultanées ne doivent jamais choisir un destinataire par ordre de Map');
assert.match(confirmationHandler, /if \(finalMatch \|\| directSelection\?\.ok\)/,
  'une confirmation exacte doit entrer immédiatement dans la transaction d’envoi');
assert.match(code, /telecharger_annexes_centris:\s*360000/,
  'le délai du tool doit couvrir l’attente du verrou et les sessions Matrix séquentielles');
assert.match(code, /centris-session-maintenance'[\s\S]*?90 \* 60 \* 1000/,
  'la session Centris doit être vérifiée avant son expiration observée de moins de 3 h');
assert.match(code, /function matrixPreviewButtons[\s\S]*?mxconfirm:[\s\S]*?mxcancel:[\s\S]*?mxrefresh:[\s\S]*?mxclient:[\s\S]*?mxemail:/,
  'les cinq actions Telegram doivent être liées à la demande Matrix unique');
assert.match(code, /function matrixPreviewSummary[\s\S]*?Client:[\s\S]*?Téléphone:[\s\S]*?CONTENU COMPLET DU COURRIEL/,
  'le résumé doit montrer identité, téléphone et contenu complet');
assert.match(code, /function purgeExpiredMatrixTransactions/);
assert.match(code, /safeCron\('matrix-preview-expiry-purge'/);
assert.match(confirmationHandler, /requestId: action\.requestId \|\| null/,
  'la deuxième confirmation doit transmettre le même identifiant unique au garde final');
assert.match(confirmationHandler, /external\?\.name === 'telecharger_annexes_centris' && external\.correctionMode/,
  'une correction en cours doit révoquer tout ancien prompt final');
assert.match(code, /Révoquer l'ancien prompt final[\s\S]*?confirmationStage = 'preview'[\s\S]*?finalConfirmationMessageId = null/,
  'le clic de correction doit révoquer et persister l’ancien prompt avant de demander les nouvelles données');

console.log('✅ Aperçu Matrix lié au destinataire, modèle et PDF avant confirmation');
