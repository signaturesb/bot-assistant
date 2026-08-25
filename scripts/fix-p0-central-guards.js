'use strict';

const fs = require('fs');
const path = 'bot.js';
let code = fs.readFileSync(path, 'utf8');
const original = code;

function mustReplace(label, from, to) {
  if (code.includes(to)) return;
  if (!code.includes(from)) throw new Error(`P0 central patch aborted: expected block missing: ${label}`);
  code = code.replace(from, to);
}

// Import central email and Pipedrive safety guards close to the other requires.
const importAnchor = "const leadParser  = require('./lead_parser');";
if (!code.includes("require('./lib/email_send_guard')")) {
  mustReplace('guard imports', importAnchor, `${importAnchor}\nconst { createOneShotAuthorization, consumeOneShotAuthorization } = require('./lib/email_send_guard');\nconst { requirePipedriveWriteIntent } = require('./lib/pipedrive_write_guard');`);
}

// Telegram authorization must fail closed when ALLOWED_ID is missing/invalid.
mustReplace(
  'isAllowed fail-closed',
  `function isAllowed(msg) {\n  if (!msg.from) return false;\n  return !ALLOWED_ID || msg.from.id === ALLOWED_ID;\n}`,
  `function isAllowed(msg) {\n  if (!msg.from) return false;\n  if (!Number.isInteger(ALLOWED_ID) || ALLOWED_ID <= 0) {\n    log('ERR', 'AUTH', 'TELEGRAM_ALLOWED_USER_ID absent/invalide — action Telegram bloquée (fail-closed)');\n    return false;\n  }\n  return Number(msg.from.id) === ALLOWED_ID;\n}`
);

// Canonical crash-report repository only.
code = code.replaceAll("repo='kira-bot'", "repo='bot-assistant'");
code = code.replaceAll('repos/signaturesb/kira-bot/contents/CRASH_REPORT.md', 'repos/signaturesb/bot-assistant/contents/CRASH_REPORT.md');
code = code.replaceAll('GitHub → kira-bot/CRASH_REPORT.md', 'GitHub → bot-assistant/CRASH_REPORT.md');

// envoyerEmailGmail must require and consume a one-shot authorization immediately before the provider call.
mustReplace(
  'envoyerEmailGmail signature',
  `async function envoyerEmailGmail({ to, toName, sujet, texte }) {`,
  `async function envoyerEmailGmail({ to, toName, sujet, texte, authorization }) {`
);
mustReplace(
  'envoyerEmailGmail provider guard',
  `  const raw = Buffer.from(msgLines.join('\\r\\n'), 'utf-8')\n    .toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');\n  await gmailAPI('/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });`,
  `  const raw = Buffer.from(msgLines.join('\\r\\n'), 'utf-8')\n    .toString('base64').replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');\n\n  // P0: one explicit confirmation = exactly one Gmail attempt.\n  consumeOneShotAuthorization(authorization, {\n    via: 'gmail', to, cc: [], bcc: [AGENT.email], subject: sujet, body: texte, attachments: []\n  });\n  await gmailAPI('/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });`
);

// Normal email confirmation: one-shot Gmail only. No automatic Gmail -> Brevo fallback.
const handlerStart = code.indexOf('async function handleEmailConfirmation(chatId, text) {');
const handlerEndMarker = '\n// ─── Handlers Telegram';
const handlerEnd = code.indexOf(handlerEndMarker, handlerStart);
if (handlerStart < 0 || handlerEnd < 0) throw new Error('P0 central patch aborted: email confirmation handler not found');
const newHandler = `async function handleEmailConfirmation(chatId, text) {\n  if (!CONFIRM_REGEX.test(text.trim())) return false;\n  const pending = pendingEmails.get(chatId);\n  if (!pending) return false;\n\n  // Une confirmation = UNE tentative Gmail précise. Aucune réutilisation, aucun fallback automatique.\n  let authorization;\n  try {\n    authorization = createOneShotAuthorization({\n      message: text,\n      via: 'gmail',\n      to: pending.to,\n      cc: [],\n      bcc: [AGENT.email],\n      subject: pending.sujet,\n      body: pending.texte,\n      attachments: [],\n    });\n  } catch (e) {\n    log('WARN', 'EMAIL', \`Confirmation bloquée: \${e.code || e.message}\`);\n    await send(chatId, '❌ Envoi bloqué — confirmation explicite requise pour cet email précis.');\n    return true;\n  }\n\n  try {\n    await envoyerEmailGmail({ ...pending, authorization });\n  } catch (e) {\n    log('ERR', 'EMAIL', \`Gmail fail après autorisation one-shot: \${e.message}\`);\n    // L'autorisation est consommée même si le provider échoue. Nouveau "envoie" requis.\n    await send(chatId, \`❌ Email non envoyé par Gmail: \${String(e.message || e).substring(0, 180)}\\n_Brouillon conservé. Dis "envoie" de nouveau pour une nouvelle tentative._\`);\n    return true;\n  }\n\n  pendingEmails.delete(chatId);\n  logActivity(\`Email envoyé (Gmail) → \${pending.to} — "\${pending.sujet.substring(0,60)}"\`);\n  mTick('emailsSent', 0); metrics.emailsSent++;\n  await send(chatId, \`✅ *Email envoyé* (Gmail)\\nÀ: \${pending.toName || pending.to}\\nObjet: \${pending.sujet}\`);\n  return true;\n}\n`;
code = code.slice(0, handlerStart) + newHandler + code.slice(handlerEnd);

if (code === original) {
  console.log('P0 central guards already compliant; no change.');
  process.exit(0);
}

fs.writeFileSync(path, code);
console.log('P0 central guards applied: Telegram fail-closed, canonical crash repo, Gmail one-shot/no fallback.');
