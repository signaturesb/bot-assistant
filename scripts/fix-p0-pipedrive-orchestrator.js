'use strict';

const fs = require('fs');
const path = 'bot.js';
let code = fs.readFileSync(path, 'utf8');
const original = code;

function mustReplace(label, from, to) {
  if (code.includes(to)) return;
  if (!code.includes(from)) throw new Error(`P0 Pipedrive patch aborted: expected block missing: ${label}`);
  code = code.replace(from, to);
}

// Central classification of tools that mutate Pipedrive.
const marker = "async function executeTool(name, input, chatId) {\n  try {";
const replacement = `const PIPEDRIVE_WRITE_TOOL_ACTIONS = Object.freeze({\n  marquer_perdu: 'update',\n  ajouter_note: 'create',\n  creer_deal: 'create',\n  planifier_visite: 'create',\n  changer_etape: 'move',\n  creer_activite: 'create',\n  completer_activite: 'update',\n  fusionner_personnes: 'merge',\n  fusionner_deals: 'merge',\n  supprimer_activite: 'delete',\n  supprimer_deal: 'delete',\n  supprimer_personne: 'delete',\n  supprimer_note: 'delete',\n  modifier_personne: 'update',\n  marquer_gagne: 'update',\n  classer_deal: 'move',\n  classer_activite: 'update',\n});\n\nasync function executeTool(name, input, chatId, userMessage = '') {\n  try {\n    const pdAction = PIPEDRIVE_WRITE_TOOL_ACTIONS[name];\n    if (pdAction) {\n      // The model/tool input is NEVER proof of authorization. Only the exact current\n      // Telegram user message is considered. Delete/merge stay blocked until a\n      // separate confirmation transaction is implemented.\n      requirePipedriveWriteIntent({\n        message: userMessage,\n        action: pdAction,\n        source: 'telegram-current-message',\n        confirmed: false,\n      });\n      auditLogEvent('pipedrive-write', 'authorized-by-current-message', {\n        tool: name, action: pdAction, chatId,\n      });\n    }`;
mustReplace('executeTool central guard', marker, replacement);

// executeToolSafe must carry request-scoped user intent.
mustReplace(
  'executeToolSafe signature',
  `async function executeToolSafe(name, input, chatId) {\n  return Promise.race([\n    executeTool(name, input, chatId),`,
  `async function executeToolSafe(name, input, chatId, userMessage = '') {\n  return Promise.race([\n    executeTool(name, input, chatId, userMessage),`
);

// Main text conversation: pass the exact user message that triggered this agent run.
const callClaudeStart = code.indexOf('async function callClaude(chatId, userMsg, retries = 3) {');
if (callClaudeStart < 0) throw new Error('P0 Pipedrive patch aborted: callClaude not found');
const callClaudeVisionStart = code.indexOf('async function callClaudeVision(', callClaudeStart);
if (callClaudeVisionStart < 0) throw new Error('P0 Pipedrive patch aborted: callClaudeVision not found');
const mainSegment = code.slice(callClaudeStart, callClaudeVisionStart);
if (!mainSegment.includes('executeToolSafe(b.name, b.input, chatId)')) throw new Error('P0 Pipedrive patch aborted: main tool execution call not found');
const newMainSegment = mainSegment.replaceAll('executeToolSafe(b.name, b.input, chatId)', 'executeToolSafe(b.name, b.input, chatId, userMsg)');
code = code.slice(0, callClaudeStart) + newMainSegment + code.slice(callClaudeVisionStart);

// Vision/multimodal runs have no trusted plain-text authorization channel here.
// Explicitly pass an empty message so every Pipedrive mutation fails closed.
const visionStart = code.indexOf('async function callClaudeVision(');
const visionEnd = code.indexOf('\n// ─── Envoyer (découpe', visionStart);
if (visionStart < 0 || visionEnd < 0) throw new Error('P0 Pipedrive patch aborted: vision boundaries not found');
const visionSegment = code.slice(visionStart, visionEnd);
const newVisionSegment = visionSegment.replaceAll('executeToolSafe(b.name, b.input, chatId)', "executeToolSafe(b.name, b.input, chatId, '')");
code = code.slice(0, visionStart) + newVisionSegment + code.slice(visionEnd);

if (code === original) {
  console.log('Pipedrive orchestrator already guarded; no change.');
  process.exit(0);
}

fs.writeFileSync(path, code);
console.log('P0 Pipedrive orchestrator guard applied: current-message authorization only.');
