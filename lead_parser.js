// lead_parser.js — Parser de leads email, extrait de bot.js pour testabilité
// Utilisé par bot.js (production) + test_parser.js (suite de tests)
'use strict';

// BLACKLIST: empêche le parser de capturer Shawn/RE-MAX/Signature SB comme PROSPECT.
// Causait: emails Centris réexpédiés par Gmail ont "De: Shawn Barrette <shawn@signaturesb.com>"
// en header → regex capturait Shawn comme nom du client → deal créé au mauvais nom →
// pas d'envoi auto. Bug résolu 2026-04-23 via sanitizeProspect().
const BLACKLIST_NAMES = ['shawn', 'shawn barrette', 'barrette', 'signature sb', 'signaturesb', 'remax', 're/max', 'kira'];
const BLACKLIST_EMAIL_PARTS = ['signaturesb.com', 'shawnbarrette', 'julielem', 'centris.ca', 'mlsmatrix', 'remax-quebec.com', 'noreply', 'no-reply', 'nepasrepondre'];

// Match whole-word ou exact — évite false positive sur "Jean Barrette-Tremblay"
// qui contiendrait "barrette" comme partie légitime du nom.
function _isBlacklistedName(nomLower) {
  if (!nomLower) return false;
  // Exact match
  if (BLACKLIST_NAMES.includes(nomLower)) return true;
  // Match avec word boundaries (espace/début/fin)
  const nomTokens = nomLower.split(/\s+/).filter(Boolean);
  for (const bl of BLACKLIST_NAMES) {
    const blTokens = bl.split(/\s+/).filter(Boolean);
    if (blTokens.length === 1) {
      // Single-word blacklist (ex: "shawn") → match si c'est un token complet
      if (nomTokens.includes(blTokens[0])) return true;
    } else {
      // Multi-word (ex: "shawn barrette") → match séquence complète
      const nomJoined = ' ' + nomLower + ' ';
      const blJoined = ' ' + bl + ' ';
      if (nomJoined.includes(blJoined)) return true;
    }
  }
  return false;
}

// Valide qu'un nom est acceptable pour créer un deal Pipedrive au nom du PROSPECT.
// Retourne false si nom absent, trop court, blacklisté, ou placeholder générique.
// Utilisé par traiterNouveauLead pour bloquer la création de deal "Prospect Centris"
// ou "Shawn Barrette" (quand parser capte mal l'émetteur).
const GENERIC_PLACEHOLDERS = new Set([
  'prospect', 'client', 'lead', 'madame', 'monsieur', 'mr', 'mme', 'mlle',
  'prospect centris', 'inconnu', 'unknown', 'n/a', 'na', 'test', 'centris',
  'formulaire centris', 'demande centris', 'demande', 'visiteur', 'utilisateur',
]);
function isValidProspectName(nom) {
  const s = String(nom || '').trim();
  if (s.length < 3) return false;
  const lower = s.toLowerCase();
  if (GENERIC_PLACEHOLDERS.has(lower)) return false;
  if (_isBlacklistedName(lower)) return false;
  // Doit contenir au moins 2 lettres alphabétiques consécutives (pas juste chiffres/symboles)
  if (!/[a-zà-ÿ]{2,}/i.test(s)) return false;
  // Rejet: ressemble à email local-part mal nettoyé (ex: "jean.dupont123")
  if (/\d/.test(s) && !/\s/.test(s)) return false;
  return true;
}

function sanitizeProspect(data) {
  const nomLower = (data.nom || '').toLowerCase().trim();
  if (_isBlacklistedName(nomLower)) {
    data.nom = ''; // Rejeté — forcera fallback AI
  }
  const emailLower = (data.email || '').toLowerCase().trim();
  if (emailLower && BLACKLIST_EMAIL_PARTS.some(b => emailLower.includes(b))) {
    data.email = ''; // Rejeté — c'est le courtier ou un système, pas un client
  }
  return data;
}

// Score qualité 0-100 pour décider si AI fallback nécessaire
function leadQualityScore(data) {
  let score = 0;
  if (data.nom && data.nom.length >= 3) score += 30;
  if (data.email && /@/.test(data.email)) score += 25;
  if (data.telephone && data.telephone.length >= 10) score += 20;
  if (data.centris && /^\d{7,9}$/.test(data.centris)) score += 15;
  if (data.adresse && data.adresse.length >= 5) score += 10;
  return score;
}

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
  const sb = s + ' ' + b;
  // Notifications Centris / saved search alerts (tous les domaines Centris)
  const isCentrisAuto = f.includes('no-reply@centris') || f.includes('noreply@centris')
    || f.includes('notifications@centris') || f.includes('@mlsmatrix') || f.includes('centris@');
  if (isCentrisAuto) {
    if (/notification|r[eé]pondent\s+à\s+vos\s+crit[eè]res|d[eé]couvrez-les|inscriptions?\s+(correspondantes|matching|nouvelles)|une\s+ou\s+plusieurs\s+nouvelles\s+propri[eé]t[eé]s|voir\s+les\s+inscriptions/i.test(sb)) return true;
  }
  // Pattern sujet saved-search typique: "[Nom, Prénom] Maison X et moins" ou "[Client] Critères"
  if (/^\[[^\]]+\]\s+(maison|terrain|plex|condo|chalet)\b/i.test(s)) return true;
  // Newsletters / promotions / marketing
  if (/(newsletter|infolettre|promotion|offre\s+sp[eé]ciale|super\s+promo|last\s+call|ending\s+soon|spring\s+sale|votre\s+campagne)/i.test(s)) return true;
  // Brevo / marketing tool notifications
  if (f.includes('brevo') || f.includes('brevosend')) return true;
  // Confirmations/annulations de visite entre courtiers (pas des leads, notifications internes)
  if (/(confirmation|annulation|modification)\s+de\s+visite\s+-/i.test(s)) return true;
  if (/demande\s+de\s+visite\s+-/i.test(s) && f.includes('remax')) return true;
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
    // Inclut "Nom du contact" (RE/MAX Québec) + "Nom complet" + etc.
    new RegExp(`\\b(?:Nom(?:\\s+(?:complet|du\\s+contact|et\\s+pr[eé]nom))?|Name|Client|Acheteur|Vendeur|Pr[eé]nom\\s+et\\s+nom|Contact)\\s*:?\\s+(${UC}(?:\\s+${UC}){1,3}?)${STOP}`),
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

  return sanitizeProspect({ nom, telephone, email, centris, adresse, type });
}

// AI FALLBACK — Claude Sonnet 4.6 avec tool-use structuré (fine pointe)
// Avantages vs ancien JSON text:
// - Output typé via input_schema → zéro parsing failure
// - Confidence par champ → Shawn voit la fiabilité
// - Body plain ET html envoyés (plus de contexte)
// - Retry 1× sur erreur API transient
// - Post-validation aggressive (format phone, email, centris)
async function parseLeadEmailWithAI(body, subject, from, regexResult, { apiKey, logger, htmlBody }) {
  if (!apiKey) return regexResult;
  const _log = logger || (() => {});

  const cleanTxt = (s, max = 6000) => (s || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/div>|<\/tr>|<\/td>|<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n')
    .substring(0, max);

  // Combiner tous les contextes disponibles
  const contextParts = [`SUJET: ${subject || ''}`, `FROM: ${from || ''}`];
  if (body) contextParts.push(`CORPS PLAIN:\n${cleanTxt(body, 5000)}`);
  if (htmlBody && htmlBody !== body) contextParts.push(`CORPS HTML (backup):\n${cleanTxt(htmlBody, 3000)}`);
  const context = contextParts.join('\n\n');

  // Tool-use schema: force output structuré
  const extractionTool = {
    name: 'enregistrer_infos_lead',
    description: 'Enregistre les informations du CLIENT (jamais du courtier) extraites d\'un email de lead immobilier.',
    input_schema: {
      type: 'object',
      properties: {
        nom: { type: 'string', description: 'Prénom Nom complet du CLIENT (pas du courtier expéditeur). Vide si absent.' },
        telephone: { type: 'string', description: '10 chiffres exactement, sans espaces/tirets. Ex: "5149271340". Vide si absent ou invalide.' },
        email: { type: 'string', description: 'Email du CLIENT en minuscules. Ignorer emails de notification (no-reply, noreply, centris@, signaturesb). Vide si absent.' },
        centris: { type: 'string', description: 'Numéro Centris/MLS: 7-9 chiffres exactement. Vide si absent.' },
        adresse: { type: 'string', description: 'Adresse civique de la propriété (sans ville/province). Ex: "456 rue Principale". Vide si absent.' },
        type: { type: 'string', enum: ['terrain','maison_usagee','plex','construction_neuve','maison_neuve','condo','chalet','autre'], description: 'Type de propriété mentionnée.' },
        message: { type: 'string', description: 'Le MESSAGE du client s\'il y en a un (texte libre qu\'il a écrit). Vide si formulaire sans message.' },
        confidence: {
          type: 'object',
          description: 'Score de confiance 0-100 par champ extrait.',
          properties: {
            nom:       { type: 'number' },
            telephone: { type: 'number' },
            email:     { type: 'number' },
            centris:   { type: 'number' },
            adresse:   { type: 'number' },
          },
        },
      },
      required: ['nom', 'telephone', 'email', 'centris', 'adresse', 'type'],
    },
  };

  const prompt = `Tu analyses un email reçu par un COURTIER IMMOBILIER (Shawn Barrette, shawn@signaturesb.com).
Extrais les informations du CLIENT PROSPECT — JAMAIS celles du courtier.

⚠️ IMPORTANT — Ignore ces noms/emails (c'est le destinataire, pas le prospect):
- "Shawn Barrette", "Shawn", "Barrette"
- "Signature SB", "SignatureSB", "RE/MAX", "REMAX"
- "Kira" (assistant IA), "Julie" (assistante de Shawn)
- shawn@signaturesb.com, julie@signaturesb.com
- Tout email @signaturesb.com, @remax-quebec.com, @centris.ca, @mlsmatrix, no-reply@*, noreply@*

Les formulaires Centris/RE-MAX contiennent souvent une section "Coordonnées du client" ou
"Informations de l'acheteur potentiel" — c'est LÀ qu'est le vrai prospect. Le header
"De: Shawn Barrette <shawn@signaturesb.com>" est juste Gmail qui réexpédie, pas le client.

Règles strictes:
- Si un champ n'est PAS présent ou ambigu, mets ""
- Téléphone: exactement 10 chiffres sans formatage ("5149271340")
- Centris#: 7-9 chiffres contigus
- Le "message" est le texte libre écrit par le client (pas les éléments de formulaire)
- Confidence 0-100: ton niveau de certitude que la valeur est correcte

${context}

Appelle enregistrer_infos_lead avec les valeurs extraites.`;

  const callAPI = async (attempt = 0) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: ctrl.signal,
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 800,
          tools: [extractionTool],
          tool_choice: { type: 'tool', name: 'enregistrer_infos_lead' },
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      clearTimeout(t);
      return res;
    } catch (e) {
      clearTimeout(t);
      if (attempt === 0 && (e.name === 'AbortError' || /ECONNRESET|ETIMEDOUT|network/i.test(e.message))) {
        _log('WARN', 'AI_PARSER', `Retry après: ${e.message}`);
        return callAPI(1);
      }
      throw e;
    }
  };

  try {
    const res = await callAPI();
    if (!res.ok) { _log('WARN', 'AI_PARSER', `HTTP ${res.status}`); return regexResult; }
    const d = await res.json();
    const toolUse = d.content?.find(c => c.type === 'tool_use');
    if (!toolUse?.input) { _log('WARN', 'AI_PARSER', `Pas de tool_use output`); return regexResult; }
    const parsed = toolUse.input;

    // Sanitize + validate
    const telClean = String(parsed.telephone || '').replace(/\D/g, '').replace(/^1/, '').substring(0, 10);
    const telValid = /^\d{10}$/.test(telClean) ? telClean : '';
    const emailClean = String(parsed.email || '').toLowerCase().trim();
    const emailValid = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(emailClean) &&
                       !emailClean.includes('signaturesb') &&
                       !emailClean.includes('noreply') &&
                       !emailClean.includes('no-reply') &&
                       !emailClean.includes('nepasrepondre') &&
                       !emailClean.includes('@centris') &&
                       !emailClean.includes('@mlsmatrix') &&
                       !emailClean.includes('@remax-quebec')
                       ? emailClean : '';
    const centrisClean = String(parsed.centris || '').replace(/\D/g, '').substring(0, 9);
    const centrisValid = /^\d{7,9}$/.test(centrisClean) ? centrisClean : '';
    const nomClean = String(parsed.nom || '').trim().replace(/\s+/g, ' ').substring(0, 100);
    // Rejeter nom si c'est visiblement pas une personne (Shawn, RE/MAX, compagnie)
    const nomValid = nomClean && !/shawn|barrette|remax|re\/max|centris|signature/i.test(nomClean) ? nomClean : '';
    const adresseClean = String(parsed.adresse || '').trim().substring(0, 150);

    // Merge: regex prioritaire quand présent, AI comble les trous
    const merged = {
      nom:       regexResult.nom       || nomValid,
      telephone: regexResult.telephone || telValid,
      email:     regexResult.email     || emailValid,
      centris:   regexResult.centris   || centrisValid,
      adresse:   regexResult.adresse   || adresseClean,
      type:      regexResult.type      || parsed.type || 'terrain',
      message:   (parsed.message || '').substring(0, 500),
      confidence: parsed.confidence || {},
      _aiUsed:   true,
      _model:    'claude-sonnet-4-6',
    };

    // Protection: rejeter tel Shawn si AI l'a retourné pour le client
    if (merged.telephone === '5149271340' && !regexResult.telephone) merged.telephone = '';

    // Sanitization finale: blacklist Shawn/RE-MAX/Signature SB
    const sanitized = sanitizeProspect(merged);
    _log('OK', 'AI_PARSER', `Extracted (sonnet tool-use): nom=${!!sanitized.nom} tel=${!!sanitized.telephone} email=${!!sanitized.email} centris=${!!sanitized.centris} adresse=${!!sanitized.adresse} conf=${JSON.stringify(sanitized.confidence)}`);
    return sanitized;
  } catch (e) {
    _log('WARN', 'AI_PARSER', `Exception: ${e.message}`);
    return regexResult;
  }
}

module.exports = {
  LEAD_EMAIL_PATTERNS,
  LEAD_SUBJECT_RE,
  BLACKLIST_NAMES,
  BLACKLIST_EMAIL_PARTS,
  detectLeadSource,
  isJunkLeadEmail,
  parseLeadEmail,
  parseLeadEmailWithAI,
  sanitizeProspect,
  leadQualityScore,
  isValidProspectName,
};
