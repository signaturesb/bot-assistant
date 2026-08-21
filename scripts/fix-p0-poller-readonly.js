'use strict';

const fs = require('fs');
const path = 'bot.js';
let code = fs.readFileSync(path, 'utf8');
const original = code;

// 1) Incoming Gmail/webhook leads may READ Pipedrive, but never create/update/cleanup automatically.
const p1 = code.indexOf('  // 1. Créer deal Pipedrive');
const p2 = code.indexOf('  // 2. Matching Dropbox AVANCÉ', p1);
if (p1 < 0 || p2 < 0) throw new Error('P0 poller patch aborted: Pipedrive lead-write block markers not found');
const readonlyBlock = `  // 1. Pipedrive READ-ONLY — un lead entrant ne constitue JAMAIS une autorisation d'écriture\n  let dealTxt = 'ℹ️ Pipedrive lecture seule — aucune création/modification automatique';\n  let dealId  = null;\n  if (PD_KEY) {\n    try {\n      const lookupTerm = email || telephone || nom || centris || '';\n      if (lookupTerm) {\n        const sr = await pdGet(\`/deals/search?term=\${encodeURIComponent(lookupTerm)}&limit=3\`);\n        const existing = sr?.data?.items?.[0]?.item || null;\n        if (existing) {\n          dealId = existing.id;\n          dealTxt = \`🔎 Deal existant trouvé (lecture seule): \${existing.title || lookupTerm} #\${existing.id}\`;\n        }\n      }\n    } catch (e) {\n      dealTxt = \`⚠️ Lecture Pipedrive: \${e.message.substring(0, 80)}\`;\n      log('WARN', 'POLLER', dealTxt);\n    }\n  }\n\n  // AUCUN cleanup/complete/create/update d'activité ici. Le poller analyse et notifie seulement.\n\n`;
code = code.slice(0, p1) + readonlyBlock + code.slice(p2);

// 2) A lead quality score can never self-authorize an email.
const autoSafeRe = /const AUTO_SAFE = exactMatch && aiValidated && completeContact && sourceTrusted && hasMatch && !!dealId && !autoSendPaused && isValidProspectName\(nom\);/;
if (!autoSafeRe.test(code)) throw new Error('P0 poller patch aborted: AUTO_SAFE expression not found');
code = code.replace(autoSafeRe, "const AUTO_SAFE = false; // P0: aucune donnée/score/source ne remplace le consentement explicite de Shawn");

// 3) Preview email must never be sent automatically. Keep function as a no-op notifier for old callers.
const fpStart = code.indexOf('function firePreviewDocs({ email, nom, centris, deal, match }) {');
const fpEndMarker = '\n\n// ─── Template HTML v11';
const fpEnd = code.indexOf(fpEndMarker, fpStart);
if (fpStart < 0 || fpEnd < 0) throw new Error('P0 poller patch aborted: firePreviewDocs block not found');
const noPreview = `function firePreviewDocs({ email, nom, centris, deal, match }) {\n  // P0: aucun email, même un preview à Shawn, sans confirmation explicite one-shot.\n  // Les données restent disponibles dans pendingDocSends/Telegram pour inspection.\n  if (!email || !match?.folder) return;\n  log('INFO', 'DOCS', \`PREVIEW EMAIL BLOQUÉ par règle de consentement — docs préparables pour \${email}\`);\n}\n`;
code = code.slice(0, fpStart) + noPreview + code.slice(fpEnd);

// 4) Audit semantics: an existing deal found by read-only lookup is not a deal created by the poller.
code = code.replace('    dealId, dealCreated: !!dealId,', '    dealId, dealCreated: false, existingDealFound: !!dealId,');

// 5) User-facing status must not claim a preview email was sent.
code = code.replaceAll(`Preview envoyé sur \${AGENT.email} pour validation visuelle.`, 'Aucun email preview envoyé — validation dans Telegram requise.');
code = code.replaceAll(`📧 Preview envoyé sur \${AGENT.email}`, '🔒 Preview email désactivé — aucun email envoyé');
code = code.replaceAll('pending_preview_sent', 'pending_no_email_sent');

if (code === original) {
  console.log('P0 poller already read-only; no change.');
  process.exit(0);
}

fs.writeFileSync(path, code);
console.log('P0 poller hardening applied: read-only CRM + no auto-send + no automatic preview email.');
