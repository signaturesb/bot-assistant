'use strict';

// External writes must preserve the order selected by the model. Parallel
// execution is reserved for read-only work because two simultaneous writes can
// otherwise produce a partial result, a duplicate send, or an unverifiable
// final state.
const MUTATING_TOOLS = new Set([
  'marquer_perdu', 'ajouter_note', 'creer_deal', 'planifier_visite',
  'changer_etape', 'creer_activite', 'completer_activite',
  'fusionner_personnes', 'fusionner_deals', 'supprimer_activite',
  'supprimer_deal', 'supprimer_personne', 'supprimer_note',
  'modifier_personne', 'marquer_gagne', 'classer_deal',
  'classer_activite', 'modifier_deal', 'deplacer_activite',
  'enregistrer_resume_appel', 'envoyer_email', 'envoyer_docs_prospect',
  'envoyer_rapport_comparables', 'telecharger_fiche_centris',
  'envoyer_fiche_centris_native', 'envoyer_tous_documents_zone',
  'telecharger_docs_centris_complet', 'telecharger_annexes_centris',
  'analyser_zonage_adresse', 'write_github_file', 'write_bot_file',
  'ajouter_brevo',
]);

function isMutatingTool(name, input = {}) {
  if (MUTATING_TOOLS.has(name)) return true;
  return false;
}

async function executeToolBatch(toolBlocks, execute) {
  const hasWrite = toolBlocks.some((block) => isMutatingTool(block.name, block.input));
  if (!hasWrite) return Promise.all(toolBlocks.map(execute));

  const results = [];
  for (const block of toolBlocks) results.push(await execute(block));
  return results;
}

module.exports = { MUTATING_TOOLS, isMutatingTool, executeToolBatch };
