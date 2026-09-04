'use strict';

function normalizeSingleRecipientEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return /^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$/.test(email) ? email : '';
}

function normalizeClientPhone(value) {
  const digits = String(value || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return /^\d{10}$/.test(digits) ? digits : '';
}

// Le destinataire exact et la propriété exacte viennent de la commande
// Telegram authentifiée. Pipedrive enrichit l'aperçu, mais une fiche CRM
// incomplète ne doit pas empêcher l'envoi explicitement demandé par Shawn.
function matrixClientEligibility(client = {}) {
  const missing = [];
  if (!normalizeSingleRecipientEmail(client.email)) missing.push('adresse courriel unique');
  if (!client.propertyIdentified) missing.push('propriété exacte');

  const enrichmentMissing = [];
  // Plusieurs fiches Pipedrive peuvent partager la même adresse. Cela rend le
  // nom CRM ambigu, mais pas le destinataire exact écrit par Shawn dans la
  // commande Telegram. L'ambiguïté reste visible sans bloquer l'aperçu.
  if (client.ambiguous) enrichmentMissing.push('correspondance CRM multiple');
  const name = String(client.name || '').trim();
  if (name.split(/\s+/).filter(Boolean).length < 2) enrichmentMissing.push('nom complet');
  if (!normalizeClientPhone(client.phone)) enrichmentMissing.push('téléphone');
  if (!String(client.context || '').trim()) enrichmentMissing.push('contexte CRM');

  return {
    eligible: missing.length === 0,
    missing,
    enrichmentMissing,
  };
}

module.exports = {
  matrixClientEligibility,
  normalizeSingleRecipientEmail,
  normalizeClientPhone,
};
