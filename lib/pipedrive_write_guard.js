'use strict';

const WRITE_ACTIONS = new Set(['create','update','delete','merge','move']);
const EXPLICIT_WRITE_RE = /\b(cr[eé]e|cr[eé]er|ajoute|ajouter|modifie|modifier|change|changer|d[eé]place|d[eé]placer|fusionne|fusionner|supprime|supprimer|efface|effacer|mets?-?moi|planifie|planifier)\b/i;
const PIPEDRIVE_CONTEXT_RE = /\b(lead|deal|prospect|client|pipedrive|activit[eé]|t[aâ]che|rappel|suivi|visite)\b/i;
const DESTRUCTIVE_RE = /\b(supprime|supprimer|efface|effacer|fusionne|fusionner|delete|merge)\b/i;

function hasExplicitWriteIntent(message, action) {
  const text = String(message || '').trim();
  if (!text) return false;
  if (!WRITE_ACTIONS.has(action)) return false;
  if (!EXPLICIT_WRITE_RE.test(text)) return false;
  if (!PIPEDRIVE_CONTEXT_RE.test(text)) return false;
  if ((action === 'delete' || action === 'merge') && !DESTRUCTIVE_RE.test(text)) return false;
  return true;
}

function requirePipedriveWriteIntent({ message, action, source = 'unknown', confirmed = false }) {
  if (!hasExplicitWriteIntent(message, action)) {
    const err = new Error(`Pipedrive ${action} bloqu\u00e9: aucune demande explicite de Shawn dans le message courant`);
    err.code = 'PIPEDRIVE_WRITE_BLOCKED';
    err.source = source;
    throw err;
  }
  if ((action === 'delete' || action === 'merge') && confirmed !== true) {
    const err = new Error(`Pipedrive ${action} bloqu\u00e9: confirmation s\u00e9par\u00e9e requise`);
    err.code = 'PIPEDRIVE_CONFIRM_REQUIRED';
    err.source = source;
    throw err;
  }
  return true;
}

module.exports = {
  hasExplicitWriteIntent,
  requirePipedriveWriteIntent,
};
