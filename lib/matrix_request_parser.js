'use strict';

const EMAIL_RE = '[^\\s@]+@[^\\s@]+';
const CENTRIS_RE = '\\d{7,9}';

function cleanMessage(value) {
  return String(value || '').replace(/[\r\0]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDirectMatrixRequest(value) {
  const text = cleanMessage(value);
  if (!text) return null;

  // Formes courtes acceptées sans sacrifier l'unicité:
  // « 19465925 client@example.com »
  // « 19465925 à client@example.com »
  // « 19465925 envoie à client@example.com ».
  let match = text.match(new RegExp(
    `^#?(${CENTRIS_RE})\\s+` +
    `(?:(?:envoie(?:-moi)?|envoyer)\\s+)?` +
    `(?:(?:[àa]|vers|pour)\\s+)?` +
    `(${EMAIL_RE})(?:\\s+(.+))?$`,
    'i',
  ));
  if (!match) {
    // Forme naturelle privilégiée:
    // « Envoie les documents du #19465925 à client@example.com message ».
    // Le numéro et le destinataire restent obligatoires et uniques; aucun
    // modèle IA ne choisit le tool ou ne reconstruit une adresse manquante.
    match = text.match(new RegExp(
      `^(?:envoie(?:-moi)?|envoyer)\\s+` +
      `(?:(?:(?:la|le)\\s+)?fiche(?:\\s+descriptive)?(?:\\s+d[ée]taill[ée]e)?` +
      `(?:\\s+avec\\s+(?:album\\s+de\\s+)?photos?)?|` +
      `(?:(?:tous?|les)\\s+)*(?:docs?|documents?))?\\s*` +
      `(?:(?:(?:du|de|pour)(?:\\s+(?:le|la))?|listing|centris|no|num[ée]ro)\\s+)*` +
      `#?(${CENTRIS_RE})\\s+(?:(?:[àa]|vers|pour)\\s+)?` +
      `(${EMAIL_RE})(?:\\s+(.+))?$`,
      'i',
    ));
  }
  if (!match) return null;
  const emailMatches = text.match(new RegExp(EMAIL_RE, 'gi')) || [];
  const centrisMatches = text.match(/\b\d{7,9}\b/g) || [];
  if (emailMatches.length !== 1 || centrisMatches.length !== 1) return null;

  return {
    centrisNum: match[1],
    email: match[2].replace(/[.,;:!?]+$/, '').toLowerCase(),
    message: cleanMessage(match[3] || ''),
  };
}

function looksLikeMatrixSendWithoutEmail(value) {
  const text = cleanMessage(value);
  if (!/^(?:envoie(?:-moi)?|envoyer)\b/i.test(text) || new RegExp(EMAIL_RE, 'i').test(text)) return false;
  return new RegExp(`(?:^|\\D)#?${CENTRIS_RE}(?:\\D|$)`).test(text);
}

function looksLikeMatrixSendCommand(value) {
  const text = cleanMessage(value);
  const hasCentrisNumber = new RegExp(`(?:^|\\D)#?${CENTRIS_RE}(?:\\D|$)`).test(text);
  return hasCentrisNumber && (
    /^(?:envoie(?:-moi)?|envoyer)\b/i.test(text) ||
    new RegExp(`^#?${CENTRIS_RE}\\s+`).test(text)
  );
}

module.exports = {
  parseDirectMatrixRequest,
  looksLikeMatrixSendWithoutEmail,
  looksLikeMatrixSendCommand,
};
