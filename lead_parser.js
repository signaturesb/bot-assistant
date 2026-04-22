// lead_parser.js — Parser de leads email, extrait de bot.js pour testabilité
// Utilisé par bot.js (production) + test_parser.js (suite de tests)
'use strict';

const LEAD_EMAIL_PATTERNS = [
  { re: /centris/i,               source: 'centris',   label: 'Centris.ca' },
  { re: /remax/i,                 source: 'remax',     label: 'RE/MAX Québec' },
  { re: /realtor|crea\.ca/i,      source: 'realtor',   label: 'Realtor.ca' },
  { re: /duproprio/i,             source: 'duproprio', label: 'DuProprio' },
  { re: /kijiji|facebook/i,       source: 'social',    label: 'Réseau social' },
];

const LEAD_SUBJECT_RE = /demande|lead|prospect|contact|information|intéress|inquiry|visite|acheteur|request/i;

function detectLeadSource(from, subject) {
  const txt = `${from} ${subject}`.toLowerCase();
  for (const s of LEAD_EMAIL_PATTERNS) {
    if (s.re.test(txt)) return s;
  }
  if (LEAD_SUBJECT_RE.test(subject)) return { source: 'direct', label: 'Demande directe' };
  return null;
}

function isJunkLeadEmail(subject, from, body) {
  const s = (subject || '').toLowerCase();
  const f = (from || '').toLowerCase();
  const b = (body || '').toLowerCase();
  // Notifications Centris / saved search alerts (vérifier sujet ET corps)
  if (f.includes('no-reply@centris') || f.includes('noreply@centris') || f.includes('notifications@centris')) {
    if (/notification|r[eé]pondent\s+à\s+vos\s+crit[eè]res|découvrez-les|inscriptions?\s+(correspondantes|matching)/i.test(s + ' ' + b)) return true;
  }
  // Newsletters / promotions
  if (/(newsletter|infolettre|promotion|offre\s+sp[eé]ciale|super\s+promo|last\s+call|ending\s+soon|spring\s+sale)/i.test(s)) return true;
  // Alertes système internes
  if (/watchdog|system\s+alert|hmac/i.test(s)) return true;
  return false;
}

function parseLeadEmail(body, subject, from) {
  let clean = (body || '')
    .replace(/\r/g, '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ');
  // Inclut from dans la zone de recherche pour extraire l'email de l'expéditeur si pas dans le body
  const full = `${subject || ''} ${clean} ${from || ''}`;

  const extract = (...patterns) => {
    for (const p of patterns) {
      const m = full.match(p);
      if (m?.[1]?.trim()) return m[1].trim().substring(0, 100);
    }
    return '';
  };

  // Nom — CRITIQUE: pas de flag /i sur patterns qui exigent première lettre majuscule,
  // sinon [A-ZÀ-Ü] accepte aussi minuscule et capture "je suis intéressé" comme nom
  // Stop lookahead: coupe avant Téléphone|Email|Courriel|Adresse|Message|Type|Vous|Phone|etc.
  // Non-greedy {1,3}? pour stopper dès que le lookahead STOP matche
  const STOP = '(?=\\s+(?:T[eé]l[eé]phone|t[eé]l[eé]phone|Tel|tel|Phone|phone|Courriel|courriel|Email|email|E-mail|e-mail|Adresse|adresse|Message|message|Type|type|Vous|vous|MLS|mls|Centris|centris)\\b|\\s*[:;|<>\\n\\r]|\\s*$)';
  // Première lettre majuscule, puis lettres mixtes (supporte "LeBlanc", "O'Brien", "Saint-Pierre")
  const UC = '[A-ZÀ-Ü][A-Za-zÀ-Üà-ü\\-\']+';
  const nom = extract(
    // Labellé explicite (Centris contact form, RE/MAX, Realtor)
    new RegExp(`\\b(?:Nom(?:\\s+complet)?|Name|Client|Acheteur|Vendeur|Pr[eé]nom\\s+et\\s+nom)\\s*:?\\s+(${UC}(?:\\s+${UC}){1,3}?)${STOP}`),
    // "Nom Prénom Nom " sans deux points (format Centris condensé)
    new RegExp(`\\bNom\\s+(${UC}(?:\\s+${UC}){1,3}?)${STOP}`),
    // "Mon nom est X" / "je m'appelle X" — FR
    new RegExp(`\\b(?:Mon\\s+nom\\s+est|mon\\s+nom\\s+est|Je\\s+m'appelle|je\\s+m'appelle)\\s+(${UC}(?:\\s+${UC}){1,2}?)(?=\\b)`),
    // "my name is X" — EN, case-insensitive uniquement sur le keyword
    new RegExp(`\\b[Mm]y\\s+[Nn]ame\\s+[Ii]s\\s+(${UC}(?:\\s+${UC}){1,2}?)(?=\\b)`),
    // Salutation "Bonjour X" uniquement si suivi de 2+ mots majuscule (évite "Bonjour, je suis")
    new RegExp(`(?:Bonjour|Salut|Hello),?\\s+(${UC}\\s+${UC})\\b`),
  );

  // Téléphone — préférer après mot-clé, sinon format 3-3-4 avec séparateur
  let telephone = '';
  const telLabelMatch = full.match(/(?:t[eé]l[eé]phone|tel\.?|phone)\s*:?\s*((?:\+1[-.\s]?)?(?:\(\s*\d{3}\s*\)\s*\d{3}[-.\s]?\d{4}|\d{3}[-.\s]?\d{3}[-.\s]?\d{4}))/i);
  if (telLabelMatch) telephone = telLabelMatch[1].replace(/[^\d+]/g, '').replace(/^1/, '');
  else {
    const telFallback = full.match(/\b((?:\+1[-.\s]?)?\d{3}[-.\s]\d{3}[-.\s]\d{4})\b/);
    if (telFallback) telephone = telFallback[1].replace(/[^\d+]/g, '').replace(/^1/, '');
  }

  // Email — préférer après "Courriel/Email" label, sinon chercher + filtrer
  let email = '';
  const emailLabelMatch = full.match(/(?:courriel|email|e-mail)\s*:?\s*([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i);
  if (emailLabelMatch) email = emailLabelMatch[1].toLowerCase();
  if (!email) {
    const emailRe = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
    const allEmails = [...full.matchAll(emailRe)].map(m => m[1].toLowerCase())
      .filter(e => !e.includes('signaturesb') && !e.includes('remax') && !e.includes('centris') && !e.includes('noreply') && !e.includes('nepasrepondre') && !e.includes('no-reply'));
    email = allEmails[0] || '';
  }

  const centris = extract(
    /\(#\s*(\d{7,9})\)/,
    /#\s*(\d{7,9})\b/,
    /(?:centris|mls|inscription|listing)[^\d]{0,60}(\d{7,9})\b/i,
    /\b(\d{8})\b/,
  );

  const adresse = extract(
    /(?:adresse|propriét[eé]|property|address|bien)\s*:?\s*([^\n\r:;|<>]{10,80})/i,
    /\b(\d+[,\s]+(?:rue|avenue|boul\.?|chemin|ch\.|rang|route|rte|place|pl\.|cour|court|dr\.?|blvd)[^\n\r:;|<>]{5,60})/i,
  );

  let type = 'terrain';
  const typeText = full.toLowerCase();
  if (/maison|unifamili|résidenti|bungalow|cottage|chalet/i.test(typeText))  type = 'maison_usagee';
  else if (/plex|duplex|triplex|quadruplex|multilogement/i.test(typeText))   type = 'plex';
  else if (/construction\s+neuve|neuve?|new\s+build/i.test(typeText))        type = 'construction_neuve';
  else if (/terrain|lot\b|land/i.test(typeText))                             type = 'terrain';

  return { nom, telephone, email, centris, adresse, type };
}

// AI FALLBACK — appelle Claude Haiku si regex échoue (<2 infos extraites)
// Retourne les infos extraites par AI, merge avec le regex (regex prioritaire)
async function parseLeadEmailWithAI(body, subject, from, regexResult, { apiKey, logger }) {
  if (!apiKey) return regexResult;
  const _log = logger || (() => {});
  const clean = (body || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .substring(0, 4000);

  const prompt = `Extrait les informations du CLIENT (pas du courtier) de cet email immobilier. Réponds UNIQUEMENT avec un JSON valide.

SUJET: ${subject}
FROM: ${from}
CORPS: ${clean}

Format attendu (utilise "" si absent):
{"nom":"Prénom Nom du CLIENT","telephone":"10 chiffres ex 5149271340","email":"email du client","centris":"7-9 chiffres","adresse":"adresse sans ville","type":"terrain|maison_usagee|plex|construction_neuve"}

Ne retourne QUE le JSON, rien d'autre. Pas de markdown, pas d'explication.`;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    clearTimeout(t);
    if (!res.ok) { _log('WARN', 'AI_PARSER', `HTTP ${res.status}`); return regexResult; }
    const d = await res.json();
    const txt = d.content?.[0]?.text?.trim() || '';
    const jsonMatch = txt.match(/\{[\s\S]*\}/);
    if (!jsonMatch) { _log('WARN', 'AI_PARSER', `Pas de JSON: ${txt.substring(0, 100)}`); return regexResult; }
    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch (e) { _log('WARN', 'AI_PARSER', `JSON.parse fail`); return regexResult; }

    // Merge: regex a priorité quand présent, AI comble les trous
    const merged = {
      nom:       regexResult.nom       || (parsed.nom || '').trim().substring(0, 100),
      telephone: regexResult.telephone || (parsed.telephone || '').replace(/\D/g, '').replace(/^1/, '').substring(0, 11),
      email:     regexResult.email     || (parsed.email || '').toLowerCase().trim(),
      centris:   regexResult.centris   || String(parsed.centris || '').replace(/\D/g, '').substring(0, 9),
      adresse:   regexResult.adresse   || (parsed.adresse || '').trim().substring(0, 100),
      type:      regexResult.type      || parsed.type || 'terrain',
      _aiUsed:   true,
    };
    // Validation: rejeter si email ou phone du courtier (faux positifs de l'AI)
    if (merged.email.includes('signaturesb') || merged.email.includes('nepasrepondre')) merged.email = '';
    if (merged.telephone === '5149271340' && !regexResult.telephone) merged.telephone = ''; // tel Shawn = pas un client
    _log('OK', 'AI_PARSER', `Extracted: nom=${!!merged.nom} tel=${!!merged.telephone} email=${!!merged.email} centris=${!!merged.centris}`);
    return merged;
  } catch (e) {
    _log('WARN', 'AI_PARSER', `Exception: ${e.message}`);
    return regexResult;
  }
}

module.exports = {
  LEAD_EMAIL_PATTERNS,
  LEAD_SUBJECT_RE,
  detectLeadSource,
  isJunkLeadEmail,
  parseLeadEmail,
  parseLeadEmailWithAI,
};
