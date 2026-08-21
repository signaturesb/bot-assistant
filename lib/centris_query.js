'use strict';

const ALLOWED_TYPES = new Set([
  'terrain', 'lot', 'maison', 'maison_usagee', 'unifamiliale',
  'bungalow', 'plex', 'duplex', 'triplex', 'condo',
]);
const ALLOWED_STATUSES = new Set(['vendu', 'actif']);

function normalizeText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function parseCentrisComparableQuery(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl || '/', 'http://localhost');
  } catch {
    return { ok: false, status: 400, error: 'URL_INVALID' };
  }

  const ville = normalizeText(parsed.searchParams.get('ville'));
  const type = normalizeText(parsed.searchParams.get('type') || 'terrain').toLowerCase();
  const statut = normalizeText(parsed.searchParams.get('statut') || 'vendu').toLowerCase();
  const joursRaw = normalizeText(parsed.searchParams.get('jours') || '14');

  if (!ville || ville.length < 2 || ville.length > 80) {
    return { ok: false, status: 400, error: 'VILLE_INVALID', detail: 'ville doit contenir de 2 à 80 caractères' };
  }
  if (!/^[\p{L}0-9 .'-]+$/u.test(ville)) {
    return { ok: false, status: 400, error: 'VILLE_INVALID', detail: 'caractères non permis dans ville' };
  }
  if (!ALLOWED_TYPES.has(type)) {
    return { ok: false, status: 400, error: 'TYPE_INVALID', detail: `types permis: ${[...ALLOWED_TYPES].join(', ')}` };
  }
  if (!ALLOWED_STATUSES.has(statut)) {
    return { ok: false, status: 400, error: 'STATUT_INVALID', detail: 'statut doit être vendu ou actif' };
  }
  if (!/^\d{1,3}$/.test(joursRaw)) {
    return { ok: false, status: 400, error: 'JOURS_INVALID', detail: 'jours doit être un entier entre 1 et 365' };
  }
  const jours = Number(joursRaw);
  if (!Number.isInteger(jours) || jours < 1 || jours > 365) {
    return { ok: false, status: 400, error: 'JOURS_INVALID', detail: 'jours doit être un entier entre 1 et 365' };
  }

  return { ok: true, value: { ville, type, statut, jours } };
}

function publicComparableListing(listing = {}) {
  return {
    mls: normalizeText(listing.mls).replace(/\D/g, '').slice(0, 9) || null,
    adresse: normalizeText(listing.adresse || listing.titre).slice(0, 180) || null,
    ville: normalizeText(listing.ville).slice(0, 80) || null,
    prix: Number.isFinite(Number(listing.prix)) ? Number(listing.prix) : null,
    superficie: Number.isFinite(Number(listing.superficie)) ? Number(listing.superficie) : null,
    dateVente: normalizeText(listing.dateVente).slice(0, 40) || null,
    dateISO: normalizeText(listing.dateISO).slice(0, 40) || null,
    annee: /^\d{4}$/.test(String(listing.annee || '')) ? Number(listing.annee) : null,
  };
}

module.exports = {
  ALLOWED_TYPES,
  parseCentrisComparableQuery,
  publicComparableListing,
};
