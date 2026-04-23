'use strict';
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Anthropic   = require('@anthropic-ai/sdk');
const http        = require('http');
const fs          = require('fs');
const path        = require('path');
const leadParser  = require('./lead_parser');

// ─── Config ───────────────────────────────────────────────────────────────────
const BOT_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_ID  = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID || '0');
const API_KEY     = process.env.ANTHROPIC_API_KEY;
const PORT        = process.env.PORT || 3000;
const GITHUB_USER = 'signaturesb';
const PD_KEY      = process.env.PIPEDRIVE_API_KEY || '';
const BREVO_KEY   = process.env.BREVO_API_KEY || '';
const SHAWN_EMAIL = process.env.SHAWN_EMAIL || 'shawn@signaturesb.com';
const JULIE_EMAIL = process.env.JULIE_EMAIL || 'julie@signaturesb.com';
// Default Sonnet 4.6 — 5x moins cher qu'Opus pour 95% de la qualité sur ce use case.
// Shawn peut switch à la volée via /opus (deep reasoning) ou /haiku (rapide, ultra-économique).
let   currentModel = process.env.MODEL || 'claude-sonnet-4-6';

// ─── AGENT_CONFIG — Foundation SaaS multi-courtier ───────────────────────────
// Toutes les valeurs courtier-spécifiques ici. Pour un autre courtier: changer les env vars.
const AGENT = {
  nom:          process.env.AGENT_NOM       || 'Shawn Barrette',
  prenom:       process.env.AGENT_PRENOM    || 'Shawn',
  telephone:    process.env.AGENT_TEL       || '514-927-1340',
  email:        SHAWN_EMAIL,
  site:         process.env.AGENT_SITE      || 'signatureSB.com',
  compagnie:    process.env.AGENT_COMPAGNIE || 'RE/MAX PRESTIGE Rawdon',
  assistante:   process.env.AGENT_ASSIST    || 'Julie',
  ass_email:    JULIE_EMAIL,
  region:       process.env.AGENT_REGION    || 'Lanaudière · Rive-Nord',
  pipeline_id:  parseInt(process.env.PD_PIPELINE_ID || '7'),
  specialites:  process.env.AGENT_SPECS     || 'terrains, maisons usagées, plexs, construction neuve',
  partenaire:   process.env.AGENT_PARTNER   || 'ProFab — Jordan Brouillette 514-291-3018 (0$ comptant via Desjardins)',
  couleur:      process.env.AGENT_COULEUR   || '#aa0721',
  dbx_terrains: process.env.DBX_TERRAINS   || '/Terrain en ligne',
  dbx_templates:process.env.DBX_TEMPLATES  || '/Liste de contact/email_templates',
  dbx_contacts: process.env.DBX_CONTACTS   || '/Contacts',
};

// Pipedrive custom field IDs (from .env.shared / Render)
const PD_FIELD_TYPE     = process.env.PD_FIELD_TYPE     || 'd8961ad7b8b9bf9866befa49ff2afae58f9a888e';
const PD_FIELD_SOURCE   = process.env.PD_FIELD_SOURCE   || 'df69049da6f662bee6a3211068b993f6e465da71';
const PD_FIELD_CENTRIS  = process.env.PD_FIELD_CENTRIS  || '22d305edf31135fc455a032e81582b98afc80104';
const PD_FIELD_SEQ      = process.env.PD_FIELD_SEQUENCE || '17a20076566919bff80b59f06866251ed250fcab';
const PD_FIELD_SUIVI_J1 = process.env.PD_FIELD_SUIVI_J1 || 'f4d00fafcf7b73ff51fdc767049b3cbd939fc0de';
const PD_FIELD_SUIVI_J3 = process.env.PD_FIELD_SUIVI_J3 || 'a5ec34bcc22f2e82d2f528a88104c61c860e303e';
const PD_FIELD_SUIVI_J7 = process.env.PD_FIELD_SUIVI_J7 || '1d2861c540b698fce3e5638112d0af51d000d648';
const PD_TYPE_MAP = { terrain: 37, construction_neuve: 38, maison_neuve: 39, maison_usagee: 40, plex: 41, auto_construction: 37 };

if (!BOT_TOKEN) { console.error('❌ TELEGRAM_BOT_TOKEN manquant'); process.exit(1); }
if (!API_KEY)   { console.error('❌ ANTHROPIC_API_KEY manquant');  process.exit(1); }
if (!PD_KEY)    { console.warn('⚠️  PIPEDRIVE_API_KEY absent'); }
if (!BREVO_KEY) { console.warn('⚠️  BREVO_API_KEY absent'); }
if (!process.env.GMAIL_CLIENT_ID)  { console.warn('⚠️  GMAIL_CLIENT_ID absent — Gmail désactivé'); }
if (!process.env.OPENAI_API_KEY)   { console.warn('⚠️  OPENAI_API_KEY absent — Whisper désactivé'); }

// ─── Logging ──────────────────────────────────────────────────────────────────
const bootStartTs = Date.now();
const bootLogsCapture = [];
function log(niveau, cat, msg) {
  const ts  = new Date().toLocaleTimeString('fr-CA', { hour12: false });
  const ico = { INFO:'📋', OK:'✅', WARN:'⚠️ ', ERR:'❌', IN:'📥', OUT:'📤' }[niveau] || '•';
  const line = `[${ts}] ${ico} [${cat}] ${msg}`;
  console.log(line);
  // Capturer les logs durant les 2 premières minutes pour diagnostic
  if (Date.now() - bootStartTs < 120000) {
    bootLogsCapture.push(`${niveau}|${cat}|${msg}`);
    if (bootLogsCapture.length > 500) bootLogsCapture.shift();
  }
}

// ─── Anti-crash global ────────────────────────────────────────────────────────
process.stdout.on('error', e => { if (e.code !== 'EPIPE') console.error(e); });
process.stderr.on('error', e => { if (e.code !== 'EPIPE') console.error(e); });
// ─── Self-reporting: capture TOUTES erreurs → GitHub pour debug ─────────────
async function reportCrashToGitHub(title, details) {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const now = new Date();
    const content = [
      `# 🚨 ${title}`,
      `_${now.toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}_`,
      ``,
      `## Erreur`,
      '```',
      String(details),
      '```',
      ``,
      `## Logs du boot (capture complète)`,
      '```',
      (bootLogsCapture || []).slice(-150).join('\n'),
      '```',
      ``,
      `## Environnement`,
      `- Node: ${process.version}`,
      `- Platform: ${process.platform}`,
      `- Memory: ${JSON.stringify(process.memoryUsage())}`,
      `- Env vars présents: ${Object.keys(process.env).filter(k => !k.startsWith('npm_')).length}`,
      ``,
      `**Claude Code peut lire ce fichier avec:**`,
      `\`read_github_file(repo='kira-bot', path='CRASH_REPORT.md')\``,
    ].join('\n');

    // Essayer GitHub API directement (fetch)
    const url = `https://api.github.com/repos/signaturesb/kira-bot/contents/CRASH_REPORT.md`;
    const getRes = await fetch(url, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
    const sha = getRes.ok ? (await getRes.json()).sha : undefined;
    await fetch(url, {
      method: 'PUT',
      headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `Crash report ${now.toISOString()}`, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) })
    });
    console.log('[CRASH REPORT] Écrit dans GitHub → kira-bot/CRASH_REPORT.md');
  } catch (e) { console.error('[CRASH REPORT FAIL]', e.message); }
}

process.on('uncaughtException', err => {
  if (err.code === 'EPIPE' || err.message?.includes('EPIPE')) return;
  console.error('[CRASH uncaughtException]', err.message, err.stack);
  reportCrashToGitHub('uncaughtException', `${err.message}\n${err.stack || ''}`).finally(() => {
    // Ne pas exit immédiatement — laisser Render faire son health check
  });
});
process.on('unhandledRejection', reason => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const stk = reason instanceof Error ? reason.stack : '';
  if (msg.includes('EPIPE')) return;
  console.error('[CRASH unhandledRejection]', msg, stk);
  reportCrashToGitHub('unhandledRejection', `${msg}\n${stk}`).catch(()=>{});
});

// ─── Persistance ──────────────────────────────────────────────────────────────
const DATA_DIR        = fs.existsSync('/data') ? '/data' : '/tmp';
const HIST_FILE       = path.join(DATA_DIR, 'history.json');
const MEM_FILE        = path.join(DATA_DIR, 'memory.json');
const GIST_ID_FILE    = path.join(DATA_DIR, 'gist_id.txt');
const VISITES_FILE    = path.join(DATA_DIR, 'visites.json');
const POLLER_FILE     = path.join(DATA_DIR, 'gmail_poller.json');
const AUTOENVOI_FILE  = path.join(DATA_DIR, 'autoenvoi_state.json');

// ─── Observabilité: Metrics + Circuit Breakers (fine pointe) ──────────────────
const metrics = {
  startedAt:  Date.now(),
  messages:   { text:0, voice:0, photo:0, pdf:0 },
  tools:      {}, // toolName → count
  api:        { claude:0, pipedrive:0, gmail:0, dropbox:0, centris:0, brevo:0, github:0 },
  errors:     { total:0, byStatus:{} },
  leads:      0,
  emailsSent: 0,
};
function mTick(cat, key) {
  if (cat === 'tools') { metrics.tools[key] = (metrics.tools[key]||0)+1; return; }
  if (metrics[cat] && typeof metrics[cat][key] === 'number') metrics[cat][key]++;
  else if (metrics[cat]) metrics[cat][key] = 1;
}

// Circuit breaker: après N échecs, coupe le service X minutes (protège cascade failures)
const circuits = {};
function circuitConfig(service, threshold = 5, cooldownMs = 5 * 60 * 1000) {
  if (!circuits[service]) circuits[service] = { fails:0, openUntil:0, threshold, cooldown:cooldownMs };
  return circuits[service];
}
function circuitCheck(service) {
  const c = circuitConfig(service);
  if (Date.now() < c.openUntil) {
    const remainS = Math.ceil((c.openUntil - Date.now()) / 1000);
    const err = new Error(`${service} en coupure — réessai dans ${remainS}s`);
    err.status = 503;
    throw err;
  }
}
function circuitSuccess(service) { const c = circuits[service]; if (c) c.fails = 0; }
function circuitFail(service) {
  const c = circuitConfig(service);
  c.fails++;
  if (c.fails >= c.threshold) {
    c.openUntil = Date.now() + c.cooldown;
    log('WARN', 'CIRCUIT', `${service} COUPÉ ${c.cooldown/1000}s (${c.fails} échecs)`);
  }
}
// Wrapper générique pour protéger un appel avec circuit breaker
async function withCircuit(service, fn) {
  circuitCheck(service);
  mTick('api', service);
  try {
    const r = await fn();
    circuitSuccess(service);
    return r;
  } catch (e) {
    if (e.status !== 400 && e.status !== 401 && e.status !== 404) circuitFail(service);
    throw e;
  }
}

function loadJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { log('WARN', 'IO', `Impossible de lire ${file} — réinitialisation`); }
  return fallback;
}
function saveJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data), 'utf8'); }
  catch (e) { log('ERR', 'IO', `Sauvegarde ${file}: ${e.message}`); }
}

// ─── Clients ──────────────────────────────────────────────────────────────────
const claude = new Anthropic({ apiKey: API_KEY });
const bot    = new TelegramBot(BOT_TOKEN, { polling: false });

// ─── Brouillons email en attente d'approbation ────────────────────────────────
const pendingEmails = new Map(); // chatId → { to, toName, sujet, texte }
let pendingDocSends = new Map(); // email → { email, nom, centris, dealId, deal, match }

// RÈGLE ABSOLUE — aucun email/sms/action externe sans consent Shawn explicite
// Désactive tous les auto-envois. Toute action "sortante" doit passer par
// pendingEmails/pendingDocSends + Shawn dit "envoie" OU être un cron approuvé.
const CONSENT_REQUIRED = true;
const POLLER_ENABLED = process.env.POLLER_ENABLED !== 'false'; // kill switch via env
let autoSendPaused = false; // toggle via /pauseauto command

// ─── Mode réflexion (Opus 4.7 thinking) ──────────────────────────────────────
let thinkingMode = false; // toggle via /penser

// ─── Mémoire persistante ──────────────────────────────────────────────────────
const kiramem = loadJSON(MEM_FILE, { facts: [], updatedAt: null });
if (!Array.isArray(kiramem.facts)) kiramem.facts = [];

function buildMemoryBlock() {
  if (!kiramem.facts.length) return '';
  return `\n\n📝 Mémoire persistante:\n${kiramem.facts.map(f => `- ${f}`).join('\n')}`;
}

// ─── System prompt (dynamique — fondation SaaS) ───────────────────────────────
function buildSystemBase() {
return `Tu es l'assistant IA personnel de ${AGENT.nom}, courtier immobilier ${AGENT.compagnie}.
Tu es son bras droit stratégique ET opérateur business — pas juste un assistant.

════ IDENTITÉ COURTIER ════
• ${AGENT.nom} | ${AGENT.telephone} | ${AGENT.email} | ${AGENT.site}
• Assistante: ${AGENT.assistante} (${AGENT.ass_email}) | Bureau: ${AGENT.compagnie}
• Spécialités: terrains (Rawdon/Saint-Julienne/Chertsey/Saint-Didace/Saint-Jean-de-Matha), maisons usagées, plexs, construction neuve
• Partenaire construction: ${AGENT.partenaire} — programme unique, aucun autre courtier offre ça
• Vend 2-3 terrains/semaine dans Lanaudière | Prix: 180-240$/pi² clé en main (nivelé, services, accès)

════ PIPEDRIVE — CONNAISSANCE COMPLÈTE ════

PIPELINE ID: ${AGENT.pipeline_id}
49 Nouveau lead → 50 Contacté → 51 En discussion → 52 Visite prévue → 53 Visite faite → 54 Offre déposée → 55 Gagné

CHAMPS PERSONNALISÉS:
• Type propriété: terrain(37) construction_neuve(38) maison_neuve(39) maison_usagee(40) plex(41)
• Séquence active: 42=Oui 43=Non
• Numéro Centris: texte libre
• Suivi J+1/J+3/J+7: champs disponibles (système sur pause — ne pas utiliser)

RÈGLES D'AVANCEMENT D'ÉTAPE:
• Lead créé → TOUJOURS activer séquence (42=Oui)
• Premier contact fait → passer à "Contacté" (50)
• Conversation entamée → "En discussion" (51)
• Visite confirmée → planifier_visite → "Visite prévue" (52) auto
• Après visite → "Visite faite" (53) + note + relance J+1
• Offre signée → "Offre déposée" (54)
• Transaction conclue → "Gagné" (55)
• Pas de réponse × 3 → marquer_perdu + ajouter_brevo (nurture)

COMPORTEMENT PROACTIF OBLIGATOIRE:
→ Quand tu vois le pipeline: signaler IMMÉDIATEMENT les deals stagnants (>3j sans action)
→ Après chaque action sur un prospect: proposer la prochaine étape logique
→ Deal en discussion >7j sans visite: "Jean est là depuis 8j — je propose une visite?"
→ Visite faite hier sans suivi: "Suite à la visite avec Marie hier — je rédige le follow-up?"

SOUS-ENTENDUS DE SHAWN → ACTIONS:
• "ça marche pas avec lui/elle" → marquer_perdu
• "c'est quoi mes hot leads" → voir_pipeline focus 51-53
• "nouveau prospect: [info]" → creer_deal auto
• "relance [nom]" → voir_prospect_complet + voir_conversation + brouillon email
• "c'est quoi le deal avec [nom]" → voir_prospect_complet
• "bouge [nom] à [étape]" → changer_etape
• "ajoute un call pour [nom]" → creer_activite
• "c'est quoi qui stagne" → prospects_stagnants
• "envoie les docs à [nom]" → envoyer_docs_prospect

POUR TOUT PROSPECT — WORKFLOW STANDARD:
1. voir_prospect_complet → état complet (notes + coordonnées + activités + séquence)
2. voir_conversation → historique Gmail 30j
3. Décider: relance email? changer étape? planifier visite? marquer perdu?
4. Exécuter + proposer prochaine action

STATS PIPELINE — INTERPRÉTER:
• Beaucoup en "Nouveau lead" → problème de conversion J+1
• Beaucoup en "En discussion" → problème de closing → proposer visites
• Peu en "Visite prévue/faite" → pousser les visites
• Taux conversion <30% → revoir le discours qualification

════ MOBILE — SHAWN EN DÉPLACEMENT ════

Shawn utilise Telegram sur mobile toute la journée. Optimiser chaque réponse pour ça.

FORMAT MOBILE OBLIGATOIRE:
• Réponses ≤ 5 lignes par défaut — plus long = Shawn scroll inutilement
• 1 action proposée max à la fois, pas 3 options
• Emojis comme marqueurs visuels: ✅ ❌ 📞 📧 🏡 🔴 🟢
• Chiffres en gras, noms en italique ou souligné
• Jamais de théorie — action directe

DÉTECTION AUTO DE CONTEXTE:
Si Shawn mentionne un prénom/nom → chercher_prospect silencieusement avant de répondre
Si Shawn mentionne "visite faite" → changer_etape + ajouter_note + brouillon relance J+1
Si Shawn mentionne "offre" ou "deal" → changer_etape + ajouter_note
Si Shawn mentionne "pas intéressé" / "cause perdue" → marquer_perdu + ajouter_brevo
Si Shawn mentionne "nouveau: [prénom] [tel/email]" → creer_deal immédiatement

QUICK ACTIONS (Shawn dicte, bot exécute):
• "visite faite avec Marie" → changer_etape Marie→visite faite + note + brouillon relance
• "Jean veut faire une offre" → changer_etape Jean→offre + note
• "deal closé avec Pierre" → changer_etape Pierre→gagné + mémo [MEMO: Gagné deal Pierre]
• "réponds à Marie que le terrain est disponible" → email rapide style Shawn
• "appelle-moi Jean" → voir_prospect_complet Jean → donne le numéro direct
• "c'est qui qui avait appelé hier?" → voir_emails_recents + voir pipeline récent
• "envoie les docs à Jean" → envoyer_docs_prospect Jean

QUAND UN LEAD ARRIVE (webhook Centris/SMS/email):
→ Le bot affiche IMMÉDIATEMENT:
  1. Nom + téléphone + email du prospect
  2. Type de propriété demandée
  3. Deal créé dans Pipedrive: OUI / NON
  4. Message J+0 prêt à envoyer (pré-rédigé)
→ Shawn répond juste "envoie" → c'est parti

RÉPONSE RAPIDE MOBILE:
Si Shawn dit "réponds [quelques mots]" ou dicte un message court:
1. Identifier le prospect (contexte ou chercher_prospect)
2. Trouver son email dans Pipedrive
3. Mettre en forme en style Shawn (vouvoiement, court, "Au plaisir,")
4. Afficher le brouillon + attendre "envoie"
NE PAS demander "à qui?", "quel email?" si l'info est dans Pipedrive

CONTEXTE DISPONIBLE EN TOUT TEMPS:
Tous les prospects Pipedrive, toutes les notes, tous les emails Gmail 30j,
tous les contacts iPhone, tous les docs Dropbox, tous les terrains actifs

════ TES DEUX MODES ════

MODE OPÉRATIONNEL (tâches, commandes): exécute vite, confirme en 1-2 phrases. "C'est fait ✅" pas "L'opération a été effectuée".
MODE STRATÈGE (prospects, business): applique le framework ci-dessous.

════ FRAMEWORK COMMERCIAL SIGNATURE SB ════

Chaque interaction prospect suit ce schéma:
1. COMPRENDRE → Vrai besoin? Niveau de sérieux? Où dans le processus?
2. POSITIONNER → Clarifier, éliminer la confusion, installer l'expertise
3. ORIENTER → Guider vers la décision logique, simplifier les choix
4. FAIRE AVANCER → Toujours pousser vers UNE action: appel, visite, offre

RÈGLE ABSOLUE: Chaque message = avancement. Jamais passif. Jamais flou. Toujours une prochaine étape.

PSYCHOLOGIE CLIENT — Identifier rapidement:
• acheteur chaud / tiède / froid
• niveau de compréhension immobilier
• émotionnel vs rationnel
• capacité financière implicite
→ Adapter le ton instantanément. Créer: clarté + confiance + urgence contrôlée.

SI LE CLIENT HÉSITE: clarifier → recadrer → avancer
CLOSING: Enlever objections AVANT. Rendre la décision logique. Réduire la friction.
Questions clés: "Qu'est-ce qui vous bloque concrètement?" / "Si tout fait du sens, on avance comment?"

════ FLUX EMAIL — PROCÉDURE OBLIGATOIRE ════

Quand tu prépares un message pour un prospect:
1. chercher_prospect → notes Pipedrive (historique, étape, date création)
2. voir_conversation → historique Gmail des 30 derniers jours (reçus + envoyés)
3. chercher_contact → iPhone si email/tel manquant
4. Appeler envoyer_email avec le brouillon complet
5. ⚠️ ATTENDRE confirmation de Shawn AVANT d'envoyer pour vrai
   → L'outil envoyer_email stocke le brouillon et te le montre — il n'envoie PAS encore.
   → Shawn confirme avec: "envoie", "go", "parfait", "ok", "oui", "d'accord", "send"
   → Le système détecte ces mots et envoie automatiquement — PAS besoin d'appeler un autre outil.

════ STYLE EMAILS SHAWN ════

RÈGLES INVIOLABLES:
• Commencer: "Bonjour," jamais "Bonjour [Prénom],"
• Vouvoiement strict (sauf si Shawn dicte avec "tu")
• Max 3 paragraphes courts — 1 info concrète de valeur
• Fermer: "Au plaisir," ou "Merci, au plaisir"
• CTA: "Laissez-moi savoir" — jamais de pression

TEMPLATES ÉPROUVÉS:
• Envoi docs: "Bonjour, voici l'information concernant le terrain. N'hésitez pas si vous avez des questions. Au plaisir,"
• J+1: "Bonjour, avez-vous eu la chance de regarder? Laissez-moi savoir si vous avez des questions. Au plaisir,"
• J+3: "Bonjour, j'espère que vous allez bien. Je voulais prendre de vos nouvelles. Laissez-moi savoir. Au plaisir,"
• J+7: "Bonjour, j'espère que vous allez bien. Si jamais vous voulez qu'on regarde d'autres options, je suis là. Laissez-moi savoir. Au plaisir,"
• Après visite: "Bonjour, j'espère que vous allez bien. Suite à notre visite, avez-vous eu le temps de réfléchir? Laissez-moi savoir. Au plaisir,"

ARGUMENTS TERRAIN:
• "2-3 terrains/semaine dans Lanaudière — marché le plus actif"
• "180-240$/pi² clé en main — tout inclus: nivelé, services, accès"
• "ProFab: 0$ comptant via Desjardins — programme unique, aucun autre courtier offre ça"
• Rawdon: 1h de Montréal, ski, randonnée, Lac Ouareau — qualité de vie exceptionnelle

OBJECTIONS:
• "Trop cher" → "Le marché a augmenté 40% en 3 ans. Attendre coûte plus cher."
• "Je réfléchis" → "Parfait, prenez le temps. Je vous réserve l'info si ça bouge."
• "Pas de budget" → "ProFab: 0$ comptant via Desjardins. On peut regarder?"
• "Moins cher ailleurs" → "Souvent pente + excavation 30k-50k$ de plus. On analyse?"

════ BRAS DROIT BUSINESS ════

Tu identifies les patterns, proposes des optimisations, pousses Shawn à avancer:
• Si tu vois des prospects sans suivi → "Tu as 3 prospects en J+3 sans relance. Je les prépare?"
• Si deal stagné → "Jean est en visite faite depuis 5 jours. Je rédige une relance?"
• Après chaque résultat → propose amélioration: "On pourrait automatiser ça pour tous les J+7"

════ CONTEXTE JURIDIQUE QUÉBEC ════

TOUJOURS règles québécoises: Code civil QC, OACIQ, LAU, TPS+TVQ (pas TVH), Q-2 r.22 fosse septique, MRC + municipalité pour permis.

════ MAILING MASSE — CAMPAGNES BREVO ════

Projet: ~/Documents/github/mailing-masse/ | Lancer: node launch.js
Menu interactif → brouillon Brevo → lien preview → confirmation "ENVOYER"
RÈGLE: toujours tester à shawn@signaturesb.com avant envoi masse

MASTER TEMPLATE:
• Fichier local: ~/Dropbox/Liste de contact/email_templates/master_template_signature_sb.html
• Dropbox API path: /Liste de contact/email_templates/master_template_signature_sb.html
• Brevo template ID 43 = version production (ce que le bot utilise pour les emails prospects)
• Design: fond #0a0a0a, rouge #aa0721, texte #f5f5f7, sections fond #111111 border #1e1e1e
• Logos: Signature SB base64 ~20KB (header) + RE/MAX base64 ~17KB (footer) — NE JAMAIS MODIFIER
• Placeholders: {{ params.KEY }} remplacés à l'envoi | {{ contact.FIRSTNAME }} = Brevo le remplace
• Params clés: TITRE_EMAIL, HERO_TITRE, INTRO_TEXTE, TABLEAU_STATS_HTML, CONTENU_STRATEGIE, CTA_TITRE, CTA_URL, CTA_BOUTON, DESINSCRIPTION_URL
• Helpers HTML injectés dans INTRO_TEXTE/CONTENU_STRATEGIE: statsGrid([{v,l}]), tableau(titre,[{l,v,h}]), etape(n,titre,desc), p(txt), note(txt)

LISTES BREVO:
• L3: anciens clients | L4: Prospects (~284 contacts) | L5: Acheteurs (~75) | L6: réseau perso | L7: Vendeurs (~10) | L8: Entrepreneurs (104 — terrains)

5 CAMPAGNES:

[1] VENDEURS — mensuelle
• Listes: 3,4,5,6,7 (TOUS ~1029 contacts) | Exclu: L8
• Stratégie: tout propriétaire peut vendre → maximiser listings
• Sujets: rotation 6 sujets (indice = (année×12+mois) % 6, déterministe)
• Contenu: statsGrid prix médians + délai 14j + évaluation gratuite, mise en valeur, suivi
• CTA: tel:5149271340

[2] ACHETEURS — mensuelle
• Listes: [5] | Exclu: [8]
• Contenu: taux BdC live (série V80691335 — affiché 5 ans), taux effectif = affiché-1.65%, versements 450k-600k @ 5%MdF 25 ans
• CTA: CALENDLY_APPEL

[3] PROSPECTS — mensuelle
• Listes: [4] | Exclu: [5,8]
• But: nurture leads Centris/Facebook/site qui n'ont pas agi
• CTA: tel:5149271340

[4] TERRAINS — aux 14 jours
• Listes: [8] — Entrepreneurs seulement
• Source terrains: API terrainspretsaconstruire.com → cache 6h → fallback Dropbox /Terrain en ligne/
• HTML terrains: fond #111, rouge #aa0721, lien vers terrainspretsaconstruire.com/carte
• Avant envoi: email automatique à Julie pour confirmer liste (si terrain vendu → mettre à jour)
• Highlight: 0$ comptant ProFab, exonération TPS premier acheteur, GCR garantie résidentielle

[5] RÉFÉRENCEMENT — mensuelle
• Listes: [3,6,7] | Exclu: [4,5,8] (~105 contacts)
• But: activer réseau existant → bonus référence 500$-1000$ (transaction conclue)
• CTA: tel:5149271340

STATS LIVE (stats_fetcher.js):
• BdC Valet API: bankofcanada.ca/valet/observations/V80691335/json?recent=1
• Prix médians APCIQ: marche_data.json — Lanaudière 515 000 $, Rive-Nord 570 000 $
• Versement: formule M = P×[r(1+r)^n]/[(1+r)^n-1], 5% MdF, 25 ans

DROPBOX — STRUCTURE CLÉS:
• /Terrain en ligne/ — dossiers terrains {adresse}_NoCentris_{num}
• /Liste de contact/email_templates/ — master_template_signature_sb.html
• /Contacts/contacts.vcf — contacts iPhone (ou /Contacts/contacts.csv, /contacts.vcf)
• Dropbox Refresh: DROPBOX_APP_KEY + DROPBOX_APP_SECRET + DROPBOX_REFRESH_TOKEN dans Render

════ VISION — PHOTOS ET DOCUMENTS ════

Tu peux recevoir et analyser des images et PDFs directement dans Telegram:

PHOTOS → analyser activement:
• Propriété ou terrain → état général, points forts pour mise en marché, défauts à cacher ou corriger
• Screenshot Centris/DuProprio → extraire prix, superficie, délai vente, calculer $/pi², identifier si bon comparable
• Extérieur maison → évaluer attrait visuel, recommander home staging, identifier rénovations ROI
• Terrain brut → estimer potentiel constructible, identifier contraintes visuelles (pente, drainage, accès)
• Photo client/prospect → jamais commenter l'apparence — focus sur le projet immobilier discuté

PDFs → extraire et analyser:
• Offre d'achat → identifier prix, conditions, délais, clauses inhabituelles, signaler risques pour Shawn
• Certificat de localisation → dimensions, servitudes, empiètements, non-conformités
• Évaluation foncière → comparer valeur marchande vs valeur foncière, implications fiscales
• Rapport inspection → prioriser défauts majeurs, estimer coûts correction, impact sur prix
• Contrat de courtage → identifier clauses importantes pour Shawn

Dès qu'une image/PDF arrive → analyser immédiatement avec le contexte immobilier Québec.
Toujours conclure avec une recommandation actionnable pour Shawn.

Mode réflexion (/penser): activé = Opus 4.7 raisonne en profondeur avant de répondre.
Idéal pour: stratégie de prix complexe, analyse marché multi-facteurs, négociation délicate.

════ PLAYBOOK VENTES (Signature SB doctrine) ════

Objectif stratégique: devenir #1 courtier Lanaudière. Applique ces principes:

1. VITESSE: lead → contact < 5 min (bot auto-notifie via Gmail Poller)
2. VALEUR AVANT PRIX: jamais discuter commission/prix avant démontrer expertise
3. QUALIFICATION: motivation? capacité? timeline? décideur?
4. CYCLE IDÉAL: J+0 contact → J+1-3 info → J+5-7 visite → J+10-15 offre → J+30-42 close
5. CHAQUE INTERACTION = avancement (jamais "suivi vide")

DIFFÉRENCIATEURS À MARTELER (factuels):
• 2-3 terrains vendus/semaine en Lanaudière (volume = preuve)
• 180-240$/pi² clé en main (précision pricing par secteur)
• ProFab 0$ comptant via Desjardins (UNIQUE au marché)
• Exonération TPS première maison neuve (fédéral)
• Accès Centris agent 110509 (comparables réels instantanés)

OBJECTIONS → RÉPONSES:
• "Trop cher" → "Voici les 3 derniers comparables vendus à [secteur]" (envoyer_rapport_comparables)
• "Je réfléchis" → "Qu'est-ce qui bloque concrètement: prix, financement, timing, emplacement?"
• "Je compare" → "Les autres ont-ils les $/pi² par secteur? Je vous envoie dans 10 min"
• "Pas de budget" → "ProFab 0$ comptant via Desjardins. On regarde?"

QUESTION DE CLOSE:
"Si je vous trouve exactement ça [secteur+budget+superficie] dans 30 jours, vous signez une offre?"

SI PROSPECT MENTIONNE:
• Un secteur → vérifier si on a des listings (chercher_listing_dropbox)
• Un budget → croiser avec $/pi² du secteur (rechercher_web ou chercher_comparables)
• Construction → parler ProFab direct
• Délai → adapter urgence sans pression

PAR TYPE PROPRIÉTÉ — POINTS DE QUALIFICATION:
• Terrain: services (hydro/fibre/fosse), pente, orientation, lot
• Maison: année, fondation, toiture, fenêtres, thermopompe
• Plex: MRB, TGA, cash-flow, vacance historique
• Construction: ProFab + GCR + exonération TPS

RÉFÉRENCE COMPLÈTE: PLAYBOOK_VENTES.md dans le repo GitHub kira-bot.

════ MÉMOIRE ════
Si Shawn dit quelque chose d'important à retenir: [MEMO: le fait à retenir]

════ CENTRIS — COMPARABLES + PROPRIÉTÉS EN VIGUEUR ════

Connexion DIRECTE à Centris.ca avec le compte agent de Shawn.
Credentials: CENTRIS_USER=110509 / CENTRIS_PASS (dans Render)

DEUX TYPES DE RAPPORTS:

[1] VENDUS (comparables): propriétés récemment vendues
→ chercher_comparables(type, ville, jours)
→ envoyer_rapport_comparables(type, ville, jours, email, statut="vendu")

[2] EN VIGUEUR (actifs): listings actuellement à vendre
→ proprietes_en_vigueur(type, ville)
→ envoyer_rapport_comparables(type, ville, email, statut="actif")

SOUS-ENTENDUS → ACTIONS:
• "comparables terrains Sainte-Julienne 14 jours" → chercher_comparables(terrain, Sainte-Julienne, 14)
• "envoie-moi les terrains vendus depuis 2 semaines à Rawdon à [email]" → envoyer_rapport_comparables(terrain, Rawdon, 14, email)
• "terrains actifs à vendre à Chertsey" → proprietes_en_vigueur(terrain, Chertsey)
• "envoie rapport en vigueur Rawdon à shawn@signaturesb.com" → envoyer_rapport_comparables(terrain, Rawdon, email, statut=actif)

RAPPORT EMAIL:
• Template Signature SB officiel (logos base64 depuis Dropbox)
• Fond #0a0a0a · Rouge #aa0721 · Typographie officielle
• Tableau: adresse · Centris# · prix · superficie · $/pi² · date
• Stats: nb propriétés · prix moyen · fourchette · superficie moy.
• Envoyé via Gmail avec BCC à shawn@signaturesb.com

VILLES: Rawdon, Sainte-Julienne, Chertsey, Saint-Didace, Sainte-Marcelline, Saint-Jean-de-Matha, Saint-Calixte, Joliette, Repentigny, Montréal, Laval...
TYPES: terrain, maison, plex, duplex, triplex, condo, bungalow

════ CAPACITÉS ════
Tu es Kira, assistante de Shawn. Utilise toutes tes capacités:
• Vision native: analyse photos et PDFs directement — pas besoin d'outil intermédiaire
• Raisonnement: /penser pour réflexion profonde (stratégie, prix, négociation)
• Contexte long: tu retiens toute la conversation — référence les échanges précédents
• Outils parallèles: quand plusieurs outils peuvent tourner en même temps, ils tournent en même temps
• Décision directe: déduis l'action la plus probable et exécute — demande confirmation seulement pour actions irréversibles (envoi email, marquer perdu)

FORMAT DE RÉPONSE OPTIMAL:
• Confirmation action: 1 ligne max — "✅ Deal créé: Jean Tremblay — Terrain | ID: 12345"
• Résultats (pipeline, prospect): données complètes sans introduction inutile
• Analyse (marché, stratégie): structure claire, chiffres en gras, conclusion actionnable
• Erreur: cause précise + action corrective en 1 ligne
• Jamais: "Bien sûr!", "Je vais maintenant", "Voici les résultats de ma recherche"`; }

// SYSTEM_BASE est buildé au démarrage (valeurs AGENT résolues)
const SYSTEM_BASE = buildSystemBase();

let dropboxStructure = '';
let dropboxTerrains  = []; // cache des dossiers terrain — pour lookup rapide
let sessionLiveContext = ''; // SESSION_LIVE.md depuis GitHub (sync Claude Code ↔ bot)

// Log d'activité du bot — écrit dans BOT_ACTIVITY.md toutes les 10 min
const botActivityLog = [];
function logActivity(event) {
  botActivityLog.push({ ts: Date.now(), event: event.substring(0, 200) });
  if (botActivityLog.length > 100) botActivityLog.shift();
}

// Partie dynamique (Dropbox + mémoire + session live) — change fréquemment, jamais cachée
function getSystemDynamic() {
  const parts = [];
  if (dropboxStructure) parts.push(`━━ DROPBOX — Structure actuelle:\n${dropboxStructure}`);
  if (sessionLiveContext) {
    // Tronquer à 3000 chars pour rester raisonnable en tokens
    const trunc = sessionLiveContext.length > 3000 ? sessionLiveContext.substring(0, 3000) + '\n...[tronqué]' : sessionLiveContext;
    parts.push(`━━ SESSION CLAUDE CODE ↔ BOT (sync temps réel):\n${trunc}`);
  }
  const mem = buildMemoryBlock().trim();
  if (mem) parts.push(mem);
  return parts.join('\n\n');
}

// Retro-compat (utilisé par callClaudeVision qui n'a pas été refactorisé)
function getSystem() {
  const dyn = getSystemDynamic();
  return dyn ? SYSTEM_BASE + '\n\n' + dyn : SYSTEM_BASE;
}

// ─── Historique (40 messages max, persistant) ─────────────────────────────────
const MAX_HIST = 40;
const rawChats = loadJSON(HIST_FILE, {});
const chats    = new Map(Object.entries(rawChats));
for (const [id, hist] of chats.entries()) {
  if (!Array.isArray(hist) || hist.length === 0) chats.delete(id);
}
let saveTimer = null;
function scheduleHistSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJSON(HIST_FILE, Object.fromEntries(chats)), 1000);
}
function getHistory(id) { if (!chats.has(id)) chats.set(id, []); return chats.get(id); }
function addMsg(id, role, content) {
  const h = getHistory(id);
  h.push({ role, content });
  if (h.length > MAX_HIST) h.splice(0, h.length - MAX_HIST);
  scheduleHistSave();
}

// ─── Validation messages pour API Claude (prévient erreurs 400) ──────────────
// Garantit: premier msg = user, alternance user/assistant correcte, dernier = user
function validateMessagesForAPI(messages) {
  if (!messages || !messages.length) return [];
  const clean = [];
  for (const m of messages) {
    if (!m?.role || !m?.content) continue;
    if (Array.isArray(m.content) && m.content.length === 0) continue;
    if (typeof m.content === 'string' && !m.content.trim()) continue;
    // Empêcher deux messages de même rôle consécutifs (fusionner ou skipper)
    if (clean.length && clean[clean.length - 1].role === m.role) {
      // Même rôle consécutif — garder seulement le plus récent
      clean[clean.length - 1] = m;
    } else {
      clean.push(m);
    }
  }
  // Supprimer les assistant en tête (le premier doit être user)
  while (clean.length && clean[0].role !== 'user') clean.shift();
  // Supprimer les assistant en queue (le dernier doit être user pour éviter prefilling)
  while (clean.length && clean[clean.length - 1].role !== 'user') clean.pop();
  return clean;
}

// Rate limiter pour éviter 429 — max N requêtes par fenêtre
const rateLimiter = { recent: [], max: 15, windowMs: 60000 };
function checkRateLimit() {
  const now = Date.now();
  rateLimiter.recent = rateLimiter.recent.filter(t => now - t < rateLimiter.windowMs);
  if (rateLimiter.recent.length >= rateLimiter.max) return false;
  rateLimiter.recent.push(now);
  return true;
}

// Transforme les erreurs API en messages lisibles pour l'utilisateur
// + déclenche alerte proactive Telegram à Shawn pour les erreurs admin-actionables
const apiErrorState = { lastCreditAlert: 0, lastAuthAlert: 0 };
function notifyShawnOnce(key, text, cooldownMs = 30 * 60 * 1000) {
  const now = Date.now();
  if (now - (apiErrorState[key] || 0) < cooldownMs) return;
  apiErrorState[key] = now;
  if (!ALLOWED_ID || typeof bot?.sendMessage !== 'function') return;
  bot.sendMessage(ALLOWED_ID, text, { parse_mode: 'Markdown', disable_web_page_preview: false }).catch(() => {
    bot.sendMessage(ALLOWED_ID, text.replace(/[*_`]/g, '')).catch(() => {});
  });
}
function formatAPIError(err) {
  const status = err?.status || err?.response?.status;
  const msg    = err?.message || String(err);
  const lower  = msg.toLowerCase();

  // Erreurs Anthropic critiques admin-actionables — alerte proactive Shawn
  if (/credit\s*balance|billing|insufficient\s*credit|out\s*of\s*credit/i.test(msg)) {
    notifyShawnOnce('lastCreditAlert',
      `🚨 *Anthropic — crédit épuisé ou mauvais workspace*\n\n` +
      `Le bot ne peut pas appeler Claude. 2 causes possibles:\n\n` +
      `*1. Crédit vraiment épuisé*\n` +
      `→ https://console.anthropic.com/settings/billing\n` +
      `Buy credits + active Auto-reload à 10$\n\n` +
      `*2. Clé API dans un AUTRE workspace que le crédit* (fréquent)\n` +
      `→ https://console.anthropic.com/settings/keys\n` +
      `Vérifie le workspace de la clé active. Puis sur billing,\n` +
      `vérifie que le crédit est sur LE MÊME workspace (sélecteur\n` +
      `en haut de la page).\n\n` +
      `*Fix rapide workspace:* crée une nouvelle clé dans le workspace\n` +
      `qui a du crédit → mets-la dans .env → \`npm run sync-env\`.\n\n` +
      `Le bot reprend dans la seconde après fix (aucun redeploy).`
    );
    return '💳 Crédit Anthropic indisponible. Shawn notifié — vérifier workspace à console.anthropic.com/settings/billing.';
  }
  if (/invalid[\s_-]?api[\s_-]?key|authentication[\s_-]?error|invalid[\s_-]?authentication/i.test(msg) || status === 401) {
    notifyShawnOnce('lastAuthAlert',
      `🚨 *Anthropic — clé API invalide*\n\n` +
      `ANTHROPIC_API_KEY rejetée (révoquée ou erronée). Action:\n` +
      `1. Nouvelle clé: https://console.anthropic.com/settings/keys\n` +
      `2. Mettre dans .env local\n` +
      `3. \`npm run sync-env\` → Render redéploie auto`
    );
    return '🔑 Clé Claude invalide/révoquée. Shawn notifié.';
  }
  if (status === 400) {
    const toolMatch = msg.match(/tools\.(\d+)\.custom\.name.*?pattern/);
    if (toolMatch) {
      const idx = parseInt(toolMatch[1]);
      return `🚨 Config bot cassée — tool #${idx} nom invalide (regex [a-zA-Z0-9_-] violée).`;
    }
    if (msg.includes('prefill') || msg.includes('prepend')) return '⚠️ Conversation corrompue — tape /reset puis réessaie.';
    if (msg.includes('max_tokens')) return '⚠️ Requête trop longue — simplifie ou /reset.';
    if (lower.includes('temperature') || lower.includes('top_p') || lower.includes('top_k')) {
      return '🚨 Config bot — temperature/top_p/top_k rejetés par Opus 4.7.';
    }
    return `⚠️ Requête invalide — /reset pour repartir. (${msg.substring(0, 80)})`;
  }
  if (status === 403) return '🚫 Accès refusé.';
  if (status === 429) {
    notifyShawnOnce('lastRateLimit',
      `⏳ *Anthropic — rate limit fréquent*\nVérifier plan: https://console.anthropic.com/settings/limits`,
      60 * 60 * 1000
    );
    return '⏳ Rate limit — patiente 30 sec.';
  }
  if (status === 529 || status >= 500) return '⚠️ Claude temporairement indisponible — réessaie dans une minute.';
  return `⚠️ ${msg.substring(0, 120)}`;
}

// ─── Déduplication (FIFO, pas de fuite mémoire) ──────────────────────────────
const processed = new Map(); // msgId → timestamp
function isDuplicate(msgId) {
  if (processed.has(msgId)) return true;
  processed.set(msgId, Date.now());
  if (processed.size > 2000) {
    // Supprimer les 500 plus anciens
    const keys = Array.from(processed.keys());
    keys.slice(0, 500).forEach(k => processed.delete(k));
  }
  return false;
}

// ─── Extraction mémos (Gist throttlé 5min pour éviter spam API) ──────────────
let lastGistSync = 0;
function extractMemos(text) {
  const memos = [];
  const cleaned = text.replace(/\[MEMO:\s*([^\]]+)\]/gi, (_, fact) => { memos.push(fact.trim()); return ''; }).trim();
  if (memos.length) {
    kiramem.facts.push(...memos);
    if (kiramem.facts.length > 50) kiramem.facts.splice(0, kiramem.facts.length - 50);
    kiramem.updatedAt = new Date().toISOString();
    saveJSON(MEM_FILE, kiramem);
    // Throttle: sync Gist max 1x toutes les 5 minutes
    const now = Date.now();
    if (now - lastGistSync > 5 * 60 * 1000) {
      lastGistSync = now;
      saveMemoryToGist().catch(() => {});
    }
    log('OK', 'MEMO', `${memos.length} fait(s) mémorisé(s) | Gist sync: ${now - lastGistSync < 1000 ? 'immédiat' : 'différé'}`);
  }
  return { cleaned, memos };
}

// ─── GitHub ───────────────────────────────────────────────────────────────────
function githubHeaders() {
  const h = { 'User-Agent': 'Kira-Bot', 'Accept': 'application/vnd.github.v3+json' };
  if (process.env.GITHUB_TOKEN) h['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
  return h;
}
async function listGitHubRepos() {
  const url = process.env.GITHUB_TOKEN
    ? `https://api.github.com/user/repos?per_page=50&sort=updated`
    : `https://api.github.com/users/${GITHUB_USER}/repos?per_page=50&sort=updated`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) return `Erreur GitHub: ${res.status}`;
  const data = await res.json();
  return data.map(r => `${r.private ? '🔒' : '🌐'} ${r.name}${r.description ? ' — ' + r.description : ''}`).join('\n');
}
async function listGitHubFiles(repo, filePath) {
  const p = (filePath || '').replace(/^\//, '');
  const url = `https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${p}`;
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) return `Erreur GitHub: ${res.status} — repo "${repo}", path "${filePath}"`;
  const data = await res.json();
  if (Array.isArray(data)) return data.map(f => `${f.type === 'dir' ? '📁' : '📄'} ${f.name}`).join('\n');
  return JSON.stringify(data).substring(0, 2000);
}
async function readGitHubFile(repo, filePath) {
  const p = filePath.replace(/^\//, '');
  const res = await fetch(`https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${p}`, { headers: githubHeaders() });
  if (!res.ok) return `Erreur GitHub: ${res.status}`;
  const data = await res.json();
  if (data.encoding === 'base64' && data.content) {
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return content.length > 8000 ? content.substring(0, 8000) + '\n...[tronqué]' : content;
  }
  return 'Fichier non textuel ou trop volumineux';
}
async function writeGitHubFile(repo, filePath, content, commitMsg) {
  if (!process.env.GITHUB_TOKEN) return 'Erreur: GITHUB_TOKEN manquant';
  const p = filePath.replace(/^\//, '');
  const url = `https://api.github.com/repos/${GITHUB_USER}/${repo}/contents/${p}`;
  let sha;
  const getRes = await fetch(url, { headers: githubHeaders() });
  if (getRes.ok) sha = (await getRes.json()).sha;
  else if (getRes.status !== 404) return `Erreur GitHub lecture: ${getRes.status}`;
  const putRes = await fetch(url, {
    method: 'PUT',
    headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: commitMsg || `Kira: mise à jour ${p}`, content: Buffer.from(content, 'utf8').toString('base64'), ...(sha ? { sha } : {}) })
  });
  if (!putRes.ok) { const err = await putRes.json().catch(() => ({})); return `Erreur GitHub écriture: ${putRes.status} — ${err.message || ''}`; }
  return `✅ "${p}" ${sha ? 'modifié' : 'créé'} dans ${repo}.`;
}

// ─── Sync Claude Code ↔ Bot (bidirectionnelle via GitHub) ────────────────────
async function loadSessionLiveContext() {
  if (!process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_USER}/kira-bot/contents/SESSION_LIVE.md`, {
      headers: githubHeaders()
    });
    if (!res.ok) { log('WARN', 'SYNC', `SESSION_LIVE.md HTTP ${res.status}`); return; }
    const data = await res.json();
    if (data.content) {
      sessionLiveContext = Buffer.from(data.content, 'base64').toString('utf8');
      log('OK', 'SYNC', `SESSION_LIVE.md chargé (${Math.round(sessionLiveContext.length / 1024)}KB)`);
    }
  } catch (e) { log('WARN', 'SYNC', `Load session: ${e.message}`); }
}

async function writeBotActivity() {
  // PRIVACY: BOT_ACTIVITY.md n'est PLUS publié sur GitHub.
  // Les logs d'activité (contiennent noms clients, Centris#) restent in-memory
  // + accessibles via Telegram. Jamais dans un repo public.
  // Si besoin de consulter: `/activity` command ou logs Render.
  return;
}

// ─── Dropbox (avec refresh auto) ─────────────────────────────────────────────
let dropboxToken = process.env.DROPBOX_ACCESS_TOKEN || '';
async function refreshDropboxToken() {
  const { DROPBOX_APP_KEY: key, DROPBOX_APP_SECRET: secret, DROPBOX_REFRESH_TOKEN: refresh } = process.env;
  if (!key || !secret || !refresh) {
    log('WARN', 'DROPBOX', `Refresh impossible — vars manquantes: ${!key?'APP_KEY ':''} ${!secret?'APP_SECRET ':''} ${!refresh?'REFRESH_TOKEN':''}`);
    return false;
  }
  try {
    const res = await fetch('https://api.dropbox.com/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: key, client_secret: secret })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.status);
      log('ERR', 'DROPBOX', `Refresh HTTP ${res.status}: ${String(err).substring(0, 100)}`);
      return false;
    }
    const data = await res.json();
    if (!data.access_token) { log('ERR', 'DROPBOX', `Refresh: pas de access_token — ${JSON.stringify(data).substring(0,100)}`); return false; }
    dropboxToken = data.access_token;
    log('OK', 'DROPBOX', 'Token rafraîchi ✓');
    return true;
  } catch (e) { log('ERR', 'DROPBOX', `Refresh exception: ${e.message}`); return false; }
}
async function dropboxAPI(apiUrl, body, isDownload = false) {
  if (!dropboxToken) {
    log('WARN', 'DROPBOX', 'Token absent — tentative refresh...');
    const ok = await refreshDropboxToken();
    if (!ok) { log('ERR', 'DROPBOX', 'Refresh échoué — Dropbox inaccessible'); return null; }
  }
  const makeReq = (token) => isDownload
    ? fetch(apiUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Dropbox-API-Arg': JSON.stringify(body) } })
    : fetch(apiUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let res = await makeReq(dropboxToken);
  if (res.status === 401) {
    log('WARN', 'DROPBOX', 'Token expiré — refresh...');
    const ok = await refreshDropboxToken();
    if (!ok) { log('ERR', 'DROPBOX', 'Re-refresh échoué'); return null; }
    res = await makeReq(dropboxToken);
  }
  return res;
}
async function listDropboxFolder(folderPath) {
  const p = folderPath === '' ? '' : ('/' + folderPath.replace(/^\//, ''));
  const res = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: p, recursive: false });
  if (!res || !res.ok) return `Erreur Dropbox: ${res ? res.status : 'connexion échouée'}`;
  const data = await res.json();
  if (!data.entries?.length) return 'Dossier vide';
  return data.entries.map(e => `${e['.tag'] === 'folder' ? '📁' : '📄'} ${e.name}`).join('\n');
}
async function readDropboxFile(filePath) {
  const p = '/' + filePath.replace(/^\//, '');
  const res = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: p }, true);
  if (!res || !res.ok) return `Erreur Dropbox: ${res ? res.status : 'connexion échouée'}`;
  const text = await res.text();
  return text.length > 8000 ? text.substring(0, 8000) + '\n...[tronqué]' : text;
}
async function downloadDropboxFile(filePath) {
  const p = '/' + filePath.replace(/^\//, '');
  const res = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: p }, true);
  if (!res || !res.ok) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  const filename = p.split('/').pop();
  return { buffer, filename };
}
async function loadDropboxStructure() {
  const sections = [
    { path: '',                     label: 'Racine' },
    { path: AGENT.dbx_terrains,    label: 'Terrain en ligne' },
    { path: AGENT.dbx_templates,   label: 'Templates email' },
    { path: AGENT.dbx_contacts,    label: 'Contacts' },
  ];
  const parts = [];
  try {
    for (const sec of sections) {
      const p   = sec.path === '' ? '' : ('/' + sec.path.replace(/^\//, ''));
      const res = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: p, recursive: false });
      if (!res?.ok) { parts.push(`❌ ${sec.label}: inaccessible`); continue; }
      const data    = await res.json();
      const entries = data.entries || [];

      // Mettre à jour le cache terrain
      if (sec.label === 'Terrain en ligne') {
        dropboxTerrains = entries.filter(e => e['.tag'] === 'folder').map(e => ({
          name: e.name, path: e.path_lower,
          centris: (e.name.match(/_NoCentris_(\d+)/) || [])[1] || '',
          adresse: e.name.replace(/_NoCentris_\d+.*$/, '').replace(/_/g, ' ').trim(),
        }));
      }

      const lines = entries.map(e => `  ${e['.tag'] === 'folder' ? '📁' : '📄'} ${e.name}`).join('\n');
      parts.push(`📂 ${sec.label} (${p || '/'}):\n${lines || '  (vide)'}`);
    }
    dropboxStructure = parts.join('\n\n');
    log('OK', 'DROPBOX', `Structure: ${dropboxTerrains.length} terrains, ${sections.length} sections chargées`);
  } catch (e) { log('WARN', 'DROPBOX', `loadStructure: ${e.message}`); }
}

// ─── GitHub Gist (persistance mémoire cross-restart) ─────────────────────────
let gistId = process.env.GIST_ID || null;
async function initGistId() {
  if (gistId) { log('OK', 'GIST', `Configuré: ${gistId}`); return; }
  if (fs.existsSync(GIST_ID_FILE)) { gistId = fs.readFileSync(GIST_ID_FILE, 'utf8').trim(); return; }
  if (!process.env.GITHUB_TOKEN) { log('WARN', 'GIST', 'GITHUB_TOKEN absent — persistance /tmp seulement'); return; }
  try {
    const res = await fetch('https://api.github.com/gists', {
      method: 'POST',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'Kira — mémoire persistante Shawn Barrette', public: false, files: { 'memory.json': { content: JSON.stringify(kiramem, null, 2) } } })
    });
    if (!res.ok) { log('WARN', 'GIST', `Create HTTP ${res.status}`); return; }
    const data = await res.json();
    gistId = data.id;
    try { fs.writeFileSync(GIST_ID_FILE, gistId, 'utf8'); } catch {}
    log('OK', 'GIST', `Créé: ${gistId}`);
    if (ALLOWED_ID) bot.sendMessage(ALLOWED_ID, `🔑 *Gist créé!* Ajoute dans Render: \`GIST_ID=${gistId}\``, { parse_mode: 'Markdown' }).catch(() => {});
  } catch (e) { log('WARN', 'GIST', `Create: ${e.message}`); }
}
// Persistance gmail_poller.json + leads_dedup.json via Gist (cross-redeploy)
async function loadPollerStateFromGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers: githubHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    const pollerStr = data.files?.['gmail_poller.json']?.content;
    const dedupStr = data.files?.['leads_dedup.json']?.content;
    if (pollerStr) {
      const parsed = JSON.parse(pollerStr);
      if (parsed.processed) gmailPollerState.processed = parsed.processed;
      if (parsed.totalLeads) gmailPollerState.totalLeads = parsed.totalLeads;
      if (parsed.lastRun) gmailPollerState.lastRun = parsed.lastRun;
      saveJSON(POLLER_FILE, gmailPollerState); schedulePollerSave();
      log('OK', 'GIST', `Poller state restauré: ${gmailPollerState.processed.length} processed, ${gmailPollerState.totalLeads} leads`);
    }
    if (dedupStr) {
      const parsed = JSON.parse(dedupStr);
      for (const [k, v] of Object.entries(parsed)) recentLeadsByKey.set(k, v);
      saveLeadsDedup();
      log('OK', 'GIST', `Dedup restauré: ${recentLeadsByKey.size} entries`);
    }
  } catch (e) { log('WARN', 'GIST', `Load poller: ${e.message}`); }
}
async function savePollerStateToGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: {
        'gmail_poller.json': { content: JSON.stringify(gmailPollerState, null, 2) },
        'leads_dedup.json':  { content: JSON.stringify(Object.fromEntries(recentLeadsByKey), null, 2) },
      }})
    });
  } catch (e) { log('WARN', 'GIST', `Save poller: ${e.message}`); }
}
// Debounce save to avoid hammering GitHub API
let _savePollerTimer = null;
function schedulePollerSave() {
  clearTimeout(_savePollerTimer);
  _savePollerTimer = setTimeout(() => savePollerStateToGist().catch(() => {}), 5000);
}

async function loadMemoryFromGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, { headers: githubHeaders() });
    if (!res.ok) { log('WARN', 'GIST', `Load HTTP ${res.status}`); return; }
    const data = await res.json();
    const content = data.files?.['memory.json']?.content;
    if (!content) return;
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed.facts) && parsed.facts.length > 0) {
      kiramem.facts = parsed.facts;
      kiramem.updatedAt = parsed.updatedAt;
      saveJSON(MEM_FILE, kiramem);
      log('OK', 'GIST', `${kiramem.facts.length} faits chargés`);
    }
  } catch (e) { log('WARN', 'GIST', `Load: ${e.message}`); }
}
async function saveMemoryToGist() {
  if (!gistId || !process.env.GITHUB_TOKEN) return;
  try {
    const res = await fetch(`https://api.github.com/gists/${gistId}`, {
      method: 'PATCH',
      headers: { ...githubHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { 'memory.json': { content: JSON.stringify(kiramem, null, 2) } } })
    });
    if (!res.ok) log('WARN', 'GIST', `Save HTTP ${res.status}`);
  } catch (e) { log('WARN', 'GIST', `Save: ${e.message}`); }
}

// ─── Pipedrive ────────────────────────────────────────────────────────────────
const PD_BASE   = 'https://api.pipedrive.com/v1';
const PD_STAGES = { 49:'🆕 Nouveau lead', 50:'📞 Contacté', 51:'💬 En discussion', 52:'🗓 Visite prévue', 53:'🏡 Visite faite', 54:'📝 Offre déposée', 55:'✅ Gagné' };

async function pdGet(endpoint) {
  if (!PD_KEY) return null;
  const sep = endpoint.includes('?') ? '&' : '?';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${PD_BASE}${endpoint}${sep}api_token=${PD_KEY}`, { signal: controller.signal });
    if (!res.ok) return null;
    return res.json();
  } finally { clearTimeout(t); }
}
async function pdPost(endpoint, body) {
  if (!PD_KEY) return null;
  const sep = endpoint.includes('?') ? '&' : '?';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${PD_BASE}${endpoint}${sep}api_token=${PD_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) return null;
    return res.json();
  } finally { clearTimeout(t); }
}
async function pdPut(endpoint, body) {
  if (!PD_KEY) return null;
  const sep = endpoint.includes('?') ? '&' : '?';
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${PD_BASE}${endpoint}${sep}api_token=${PD_KEY}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    if (!res.ok) return null;
    return res.json();
  } finally { clearTimeout(t); }
}

async function getPipeline() {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const data = await pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`);
  if (!data?.data) return 'Erreur Pipedrive ou pipeline vide.';
  const deals = data.data;
  if (!deals.length) return '📋 Pipeline vide.';
  const parEtape = {};
  for (const d of deals) {
    const s = PD_STAGES[d.stage_id] || `Étape ${d.stage_id}`;
    if (!parEtape[s]) parEtape[s] = [];
    const centris = d[PD_FIELD_CENTRIS] ? ` #${d[PD_FIELD_CENTRIS]}` : '';
    parEtape[s].push(`${d.title || 'Sans nom'}${centris}`);
  }
  let txt = `📊 *Pipeline ${AGENT.compagnie} — ${deals.length} deals actifs*\n\n`;
  for (const [etape, noms] of Object.entries(parEtape)) {
    txt += `*${etape}* (${noms.length})\n`;
    txt += noms.map(n => `  • ${n}`).join('\n') + '\n\n';
  }
  return txt.trim();
}

async function chercherProspect(terme) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const searchRes = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=5`);
  const deals = searchRes?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé pour "${terme}" dans Pipedrive.`;

  // Si plusieurs résultats, les montrer brièvement d'abord
  let multiInfo = '';
  if (deals.length > 1) {
    multiInfo = `_(${deals.length} résultats — affichage du premier)_\n`;
    deals.slice(1).forEach(d => {
      multiInfo += `  • ${d.item.title || '?'} — ${PD_STAGES[d.item.stage_id] || d.item.stage_id}\n`;
    });
    multiInfo += '\n';
  }

  const deal = deals[0].item;
  const stageLabel = PD_STAGES[deal.stage_id] || `Étape ${deal.stage_id}`;
  let info = `${multiInfo}═══ PROSPECT: ${deal.title || terme} ═══\nDeal ID: ${deal.id}\nStade: ${stageLabel}\n`;
  if (deal.person_name) info += `Contact: ${deal.person_name}\n`;

  // Coordonnées complètes via API personne
  if (deal.person_id) {
    const person = await pdGet(`/persons/${deal.person_id}`);
    if (person?.data) {
      const phones = (person.data.phone || []).filter(p => p.value).map(p => p.value);
      const emails = (person.data.email || []).filter(e => e.value).map(e => e.value);
      if (phones.length) info += `Tel: ${phones.join(' · ')}\n`;
      if (emails.length) info += `Email: ${emails.join(' · ')}\n`;
    }
  }

  const centris = deal[PD_FIELD_CENTRIS];
  if (centris) info += `Centris: #${centris}\n`;
  const created = deal.add_time ? new Date(deal.add_time).toLocaleDateString('fr-CA') : '?';
  info += `Créé: ${created}\n`;
  const notes = await pdGet(`/notes?deal_id=${deal.id}&limit=5`);
  const notesList = (notes?.data || []).filter(n => n.content?.trim()).map(n => `• ${n.content.trim().substring(0, 300)}`);
  if (notesList.length) info += `\nNotes:\n${notesList.join('\n')}\n`;
  return info;
}

async function marquerPerdu(terme) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const searchRes = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = searchRes?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé pour "${terme}".`;
  const deal = deals[0].item;
  await pdPut(`/deals/${deal.id}`, { status: 'lost' });
  logActivity(`Deal marqué perdu: ${deal.title || terme}`);
  return `✅ "${deal.title || terme}" marqué perdu dans Pipedrive.`;
}

async function ajouterNote(terme, note) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const searchRes = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = searchRes?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé pour "${terme}".`;
  const deal = deals[0].item;
  await pdPost('/notes', { deal_id: deal.id, content: note });
  return `✅ Note ajoutée sur "${deal.title || terme}".`;
}

async function voirProspectComplet(terme) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=5`);
  const items = sr?.data?.items || [];
  if (!items.length) return `Aucun prospect "${terme}" dans Pipedrive.`;

  // Afficher brièvement les autres résultats si plusieurs
  let autre = '';
  if (items.length > 1) {
    autre = `_Autres résultats: ${items.slice(1).map(i => i.item.title).join(', ')}_\n\n`;
  }

  const deal = items[0].item;
  const [fullDeal, notes, activities, personData] = await Promise.all([
    pdGet(`/deals/${deal.id}`),
    pdGet(`/notes?deal_id=${deal.id}&limit=10`),
    pdGet(`/activities?deal_id=${deal.id}&limit=10&done=0`),
    deal.person_id ? pdGet(`/persons/${deal.person_id}`) : Promise.resolve(null),
  ]);

  // Chercher les derniers emails Gmail (optionnel — ne bloque pas si Gmail non dispo)
  let gmailContext = '';
  try {
    const personEmail = personData?.data?.email?.[0]?.value;
    if (personEmail && process.env.GMAIL_CLIENT_ID) {
      const q = encodeURIComponent(`${personEmail} newer_than:30d`);
      const gmailList = await gmailAPI(`/messages?maxResults=2&q=${q}`).catch(() => null);
      if (gmailList?.messages?.length) {
        const lastMsg = await gmailAPI(`/messages/${gmailList.messages[0].id}?format=full`).catch(() => null);
        if (lastMsg) {
          const hdrs = lastMsg.payload?.headers || [];
          const get  = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
          const sens = get('from').includes(AGENT.email) ? '📤' : '📥';
          gmailContext = `\n📧 *Dernier email (Gmail):* ${sens} ${get('subject')} — ${get('date').substring(0,16)}\n_${lastMsg.snippet?.substring(0,120)}_`;
        }
      }
    }
  } catch {} // Gmail optionnel — pas critique

  const emails = personData; // rename pour clarté

  const d          = fullDeal?.data || deal;
  const stageLabel = PD_STAGES[d.stage_id] || `Étape ${d.stage_id}`;
  const typeMap    = { 37:'Terrain', 38:'Construction neuve', 39:'Maison neuve', 40:'Maison usagée', 41:'Plex' };
  const typeLabel  = typeMap[d[PD_FIELD_TYPE]] || 'Propriété';
  const centris    = d[PD_FIELD_CENTRIS] || '';
  const seqActive  = d[PD_FIELD_SEQ] === 42 ? '✅ Oui' : '❌ Non';
  const j1 = d[PD_FIELD_SUIVI_J1] ? '✅' : '⏳';
  const j3 = d[PD_FIELD_SUIVI_J3] ? '✅' : '⏳';
  const j7 = d[PD_FIELD_SUIVI_J7] ? '✅' : '⏳';
  const created    = d.add_time ? new Date(d.add_time).toLocaleDateString('fr-CA') : '?';
  const ageJours   = d.add_time ? Math.floor((Date.now() - new Date(d.add_time).getTime()) / 86400000) : '?';
  const valeur     = d.value ? `${Number(d.value).toLocaleString('fr-CA')} $` : '';

  let txt = `${autre}━━━━━━━━━━━━━━━━━━━━━━━\n`;
  txt += `👤 *${d.title}* (ID: ${d.id})\n`;
  txt += `📊 ${stageLabel} | ${typeLabel}${centris ? ` | #${centris}` : ''}\n`;
  txt += `📅 Créé: ${created} (${ageJours}j)${valeur ? ` | ${valeur}` : ''}\n`;
  txt += `🔄 Séquence: ${seqActive}\n`; // J+1/J+3/J+7 sur glace

  // Coordonnées complètes
  const p = emails?.data;
  if (p) {
    const phones = (p.phone || []).filter(x => x.value).map(x => x.value);
    const mails  = (p.email || []).filter(x => x.value).map(x => x.value);
    if (phones.length || mails.length) {
      txt += `\n📞 *Coordonnées:*\n`;
      if (phones.length) txt += `  Tel: ${phones.join(' · ')}\n`;
      if (mails.length)  txt += `  Email: ${mails.join(' · ')}\n`;
    }
  }

  // Notes récentes
  const notesList = (notes?.data || []).filter(n => n.content?.trim());
  if (notesList.length) {
    txt += `\n📝 *Notes (${notesList.length}):*\n`;
    notesList.slice(0, 5).forEach(n => {
      const dt = n.add_time ? new Date(n.add_time).toLocaleDateString('fr-CA') : '';
      txt += `  [${dt}] ${n.content.trim().substring(0, 250)}\n`;
    });
  }

  // Activités à faire
  const now   = Date.now();
  const acts  = (activities?.data || []).sort((a, b) =>
    new Date(`${a.due_date}T${a.due_time||'23:59'}`) - new Date(`${b.due_date}T${b.due_time||'23:59'}`)
  );
  if (acts.length) {
    txt += `\n📋 *Activités à venir (${acts.length}):*\n`;
    acts.slice(0, 4).forEach(a => {
      const late = new Date(`${a.due_date}T${a.due_time||'23:59'}`).getTime() < now ? '⚠️' : '🔲';
      txt += `  ${late} ${a.subject || a.type} — ${a.due_date}${a.due_time ? ' ' + a.due_time.substring(0,5) : ''}\n`;
    });
  }

  // Dernier email Gmail
  if (gmailContext) txt += gmailContext;

  // Alerte stagnation
  const lastAct = d.last_activity_date ? new Date(d.last_activity_date).getTime() : new Date(d.add_time).getTime();
  const j = Math.floor((now - lastAct) / 86400000);
  if (j >= 3 && d.stage_id <= 51) txt += `\n\n⚠️ *Aucune action depuis ${j} jours — relance recommandée*`;

  txt += `\n━━━━━━━━━━━━━━━━━━━━━━━`;
  return txt;
}

async function prospectStagnants(jours = 3) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const data  = await pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`);
  const deals = data?.data || [];
  const now   = Date.now();
  const seuil = jours * 86400000;
  const stag  = deals
    .filter(d => d.stage_id <= 51) // avant visite prévue
    .map(d => {
      const last = d.last_activity_date
        ? new Date(d.last_activity_date).getTime()
        : new Date(d.add_time).getTime();
      return { title: d.title, stage: PD_STAGES[d.stage_id] || d.stage_id, j: Math.floor((now - last) / 86400000) };
    })
    .filter(d => d.j >= jours)
    .sort((a, b) => b.j - a.j);

  if (!stag.length) return `✅ Tous les prospects ont été contactés dans les ${jours} derniers jours.`;
  let txt = `⚠️ *${stag.length} prospect(s) sans action depuis ${jours}j+:*\n\n`;
  stag.forEach(s => txt += `  🔴 *${s.title}* — ${s.stage} — ${s.j}j\n`);
  txt += `\nDis "relance [nom]" ou "voir [nom]" pour chacun.`;
  return txt;
}

async function modifierDeal(terme, { valeur, titre, dateClose, raison }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `Aucun deal: "${terme}"`;
  const deal = deals[0].item;
  const body = {};
  if (valeur !== undefined) body.value = parseFloat(String(valeur).replace(/[^0-9.]/g, ''));
  if (titre)     body.title      = titre;
  if (dateClose) body.close_time = dateClose;
  if (Object.keys(body).length === 0) return '❌ Rien à modifier — précise valeur, titre ou date.';
  await pdPut(`/deals/${deal.id}`, body);
  const changes = Object.entries(body).map(([k, v]) => `${k}: ${v}`).join(', ');
  return `✅ *${deal.title}* mis à jour\n${changes}`;
}

async function creerActivite({ terme, type, sujet, date, heure }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const TYPES = { appel:'call', call:'call', email:'email', réunion:'meeting', meeting:'meeting', tâche:'task', task:'task', visite:'meeting', texte:'task' };
  const actType = TYPES[type?.toLowerCase()?.trim()] || 'task';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `Aucun deal: "${terme}"`;
  const deal = deals[0].item;
  const body = {
    deal_id: deal.id,
    subject: sujet || `${actType.charAt(0).toUpperCase() + actType.slice(1)} — ${deal.title}`,
    type: actType,
    done: 0,
  };
  if (date) body.due_date = date;
  if (heure) body.due_time = heure;
  await pdPost('/activities', body);
  return `✅ Activité créée: *${body.subject}*\n${deal.title}${date ? ` — ${date}${heure ? ' ' + heure : ''}` : ''}`;
}

async function statsBusiness() {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const now = new Date();
  const [gagnes, perdus, actifs, visitesData] = await Promise.all([
    pdGet('/deals?status=won&limit=100'),
    pdGet('/deals?status=lost&limit=100'),
    pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`),
    Promise.resolve(loadJSON(VISITES_FILE, [])),
  ]);
  const filtrerMois = d => {
    const date = new Date(d.close_time || d.won_time || d.lost_time || 0);
    return date.getMonth() === now.getMonth() && date.getFullYear() === now.getFullYear();
  };
  const dealsActifs = actifs?.data || [];
  const gagnésMois  = (gagnes?.data || []).filter(filtrerMois);
  const perdusMois  = (perdus?.data || []).filter(filtrerMois);
  const parEtape = {};
  for (const d of dealsActifs) {
    const s = PD_STAGES[d.stage_id] || `Étape ${d.stage_id}`;
    parEtape[s] = (parEtape[s] || 0) + 1;
  }
  // Stagnants (J+1/J+3/J+7 sur glace)
  const relances = []; // désactivé — réactiver quand prêt
  const stagnants = [];
  const nowTs = Date.now();
  for (const d of dealsActifs) {
    if (d.stage_id > 51) continue;
    const created = new Date(d.add_time).getTime();
    const last = d.last_activity_date ? new Date(d.last_activity_date).getTime() : created;
    if ((nowTs - last) > 3 * 86400000) stagnants.push({ title: d.title, j: Math.floor((nowTs - last) / 86400000) });
  }

  // Visites aujourd'hui
  const today      = now.toDateString();
  const visitesToday = visitesData.filter(v => new Date(v.date).toDateString() === today);

  const dateStr = now.toLocaleDateString('fr-CA', { weekday:'long', day:'numeric', month:'long', timeZone:'America/Toronto' });
  let txt = `📊 *Tableau de bord ${AGENT.compagnie}*\n_${dateStr}_\n\n`;
  txt += `🔥 *Pipeline actif — ${dealsActifs.length} deals*\n`;
  for (const [etape, nb] of Object.entries(parEtape)) txt += `  ${etape}: *${nb}*\n`;
  txt += `\n📈 *${now.toLocaleString('fr-CA', { month:'long', year:'numeric' })}*\n`;
  txt += `  ✅ Gagnés: *${gagnésMois.length}*  ❌ Perdus: ${perdusMois.length}\n`;
  if (gagnésMois.length + perdusMois.length > 0) {
    txt += `  🎯 Taux: ${Math.round(gagnésMois.length / (gagnésMois.length + perdusMois.length) * 100)}%\n`;
  }
  if (visitesToday.length) {
    txt += `\n📅 *Visites aujourd'hui (${visitesToday.length}):*\n`;
    visitesToday.forEach(v => {
      const h = new Date(v.date).toLocaleTimeString('fr-CA', { hour:'2-digit', minute:'2-digit', timeZone:'America/Toronto' });
      txt += `  🏡 ${v.nom} — ${h}${v.adresse ? ' @ ' + v.adresse : ''}\n`;
    });
  }
  if (relances.length) {
    txt += `\n⏰ *Relances à faire (${relances.length}):*\n`;
    relances.forEach(r => txt += `  ${r}\n`);
  }
  if (stagnants.length) {
    txt += `\n⚠️ *Sans contact 3j+ (${stagnants.length}):*\n`;
    stagnants.sort((a,b) => b.j - a.j).slice(0,5).forEach(s => txt += `  🔴 ${s.title} — ${s.j}j\n`);
  }
  return txt.trim();
}

async function creerDeal({ prenom, nom, telephone, email, type, source, centris, note }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const fullName = [prenom, nom].filter(Boolean).join(' ');
  const titre = fullName || prenom || 'Nouveau prospect';
  const phoneNorm = telephone ? telephone.replace(/\D/g, '') : '';

  // 1. Chercher personne existante — priorité email > tel > nom (évite doublons)
  let personId = null;
  let personNote = '';
  let personAction = 'created';
  try {
    let existingPerson = null;
    // Priorité 1: email exact (le plus fiable)
    if (email) {
      const r = await pdGet(`/persons/search?term=${encodeURIComponent(email)}&fields=email&limit=1`);
      existingPerson = r?.data?.items?.[0]?.item;
    }
    // Priorité 2: tel si pas trouvé par email
    if (!existingPerson && phoneNorm) {
      const r = await pdGet(`/persons/search?term=${encodeURIComponent(phoneNorm)}&fields=phone&limit=1`);
      existingPerson = r?.data?.items?.[0]?.item;
    }
    // Priorité 3: nom (fallback, risque homonymes — à confirmer côté Shawn)
    if (!existingPerson && fullName) {
      const r = await pdGet(`/persons/search?term=${encodeURIComponent(fullName)}&fields=name&limit=1`);
      existingPerson = r?.data?.items?.[0]?.item;
    }

    if (existingPerson) {
      personId = existingPerson.id;
      personAction = 'found';
      // UPDATE si email ou tel manquants sur la personne existante
      const fullPerson = await pdGet(`/persons/${personId}`).then(r => r?.data).catch(() => null);
      const existingEmails = (fullPerson?.email || []).map(e => e.value).filter(Boolean);
      const existingPhones = (fullPerson?.phone || []).map(p => p.value).filter(Boolean);
      const updates = {};
      if (email && !existingEmails.includes(email)) {
        updates.email = [...existingEmails.map(v => ({ value: v })), { value: email, primary: existingEmails.length === 0 }];
      }
      if (phoneNorm && !existingPhones.some(p => p.replace(/\D/g,'') === phoneNorm)) {
        updates.phone = [...existingPhones.map(v => ({ value: v })), { value: phoneNorm, primary: existingPhones.length === 0 }];
      }
      if (Object.keys(updates).length) {
        await pdPut(`/persons/${personId}`, updates).catch(() => {});
        personAction = 'updated';
        log('OK', 'PD', `Personne #${personId} updated: ${Object.keys(updates).join('+')}`);
      }
    } else {
      // Créer la personne
      const personBody = { name: fullName || prenom };
      if (phoneNorm) personBody.phone = [{ value: phoneNorm, primary: true }];
      if (email)     personBody.email = [{ value: email, primary: true }];
      const personRes = await pdPost('/persons', personBody);
      personId = personRes?.data?.id || null;
      if (!personId) personNote = '\n⚠️ Contact non créé — ajoute email/tel manuellement dans Pipedrive.';
    }
  } catch (e) {
    log('WARN', 'PD', `Person creation: ${e.message}`);
    personNote = '\n⚠️ Contact non lié — ajoute manuellement.';
  }

  // 2. Créer le deal
  const typeOpt = PD_TYPE_MAP[type] || PD_TYPE_MAP.maison_usagee;
  const dealBody = {
    title:           titre,
    stage_id:        49,
    pipeline_id:     AGENT.pipeline_id,
    [PD_FIELD_TYPE]: typeOpt,
    [PD_FIELD_SEQ]:  42,
  };
  if (personId) dealBody.person_id       = personId;
  if (centris)  dealBody[PD_FIELD_CENTRIS] = centris;

  const dealRes = await pdPost('/deals', dealBody);
  const deal = dealRes?.data;
  if (!deal?.id) return `❌ Erreur création deal Pipedrive — vérifie PIPEDRIVE_API_KEY dans Render.`;

  // 3. Note initiale
  const noteContent = [
    note,
    telephone ? `Tel: ${telephone}` : '',
    email     ? `Email: ${email}` : '',
    source    ? `Source: ${source}` : '',
  ].filter(Boolean).join('\n');
  if (noteContent) await pdPost('/notes', { deal_id: deal.id, content: noteContent }).catch(() => {});

  const typeLabel = { terrain:'Terrain', maison_usagee:'Maison usagée', maison_neuve:'Maison neuve', construction_neuve:'Construction neuve', auto_construction:'Auto-construction', plex:'Plex' }[type] || 'Propriété';
  logActivity(`Deal créé: ${titre} (${typeLabel}${centris?', Centris #'+centris:''})`);
  return `✅ Deal créé: *${titre}*\nType: ${typeLabel} | ID: ${deal.id}${centris ? ' | Centris #' + centris : ''}${personNote}`;
}

async function planifierVisite({ prospect, date, adresse }) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const searchRes = await pdGet(`/deals/search?term=${encodeURIComponent(prospect)}&limit=3`);
  const deals = searchRes?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé pour "${prospect}". Crée d'abord le deal.`;
  const deal = deals[0].item;

  // Parser la date — utilise ISO si fournie, sinon now+1jour
  let rdvISO = date;
  if (!date.includes('T') && !date.includes('-')) {
    // Date naturelle — approximation simple
    rdvISO = new Date(Date.now() + 86400000).toISOString();
  }
  const dateStr = rdvISO.split('T')[0];
  const timeStr = rdvISO.includes('T') ? rdvISO.split('T')[1]?.substring(0, 5) : '14:00';

  await Promise.all([
    pdPut(`/deals/${deal.id}`, { stage_id: 52 }),
    pdPost('/activities', { deal_id: deal.id, subject: `Visite — ${deal.title}${adresse ? ' @ ' + adresse : ''}`, type: 'meeting', due_date: dateStr, due_time: timeStr, duration: '01:00', done: 0 })
  ]);

  // Sauvegarder dans visites.json pour rappel matin
  const visites = loadJSON(VISITES_FILE, []);
  visites.push({ dealId: deal.id, nom: deal.title, date: rdvISO, adresse: adresse || '' });
  saveJSON(VISITES_FILE, visites);

  logActivity(`Visite planifiée: ${deal.title} — ${dateStr} ${timeStr}${adresse?' @ '+adresse:''}`);
  return `✅ Visite planifiée: *${deal.title}*\n📅 ${dateStr} à ${timeStr}${adresse ? '\n📍 ' + adresse : ''}\nDeal → Visite prévue ✓`;
}

async function changerEtape(terme, etape) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const MAP = {
    'nouveau':49, 'contacté':50, 'contact':50, 'discussion':51, 'en discussion':51,
    'visite prévue':52, 'visite planifiée':52, 'visite faite':53, 'visite':53,
    'offre':54, 'offre déposée':54, 'gagné':55, 'won':55, 'closed':55
  };
  const stageId = MAP[etape.toLowerCase().trim()] || parseInt(etape);
  if (!stageId || !PD_STAGES[stageId]) {
    return `❌ Étape inconnue: "${etape}"\nOptions: nouveau · contacté · discussion · visite prévue · visite faite · offre · gagné`;
  }
  const s = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = s?.data?.items || [];
  if (!deals.length) return `Aucun deal trouvé: "${terme}"`;
  const deal = deals[0].item;
  const avant = PD_STAGES[deal.stage_id] || deal.stage_id;
  await pdPut(`/deals/${deal.id}`, { stage_id: stageId });
  return `✅ *${deal.title || terme}*\n${avant} → ${PD_STAGES[stageId]}`;
}

async function voirActivitesDeal(terme) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const s = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = s?.data?.items || [];
  if (!deals.length) return `Aucun deal: "${terme}"`;
  const deal = deals[0].item;
  const acts = await pdGet(`/activities?deal_id=${deal.id}&limit=20&done=0`);
  const list = acts?.data || [];
  if (!list.length) return `*${deal.title}* — aucune activité à venir.`;
  const now = Date.now();
  let txt = `📋 *Activités — ${deal.title}*\n\n`;
  const sorted = list.sort((a, b) => new Date(`${a.due_date}T${a.due_time||'23:59'}`) - new Date(`${b.due_date}T${b.due_time||'23:59'}`));
  for (const a of sorted) {
    const dt   = new Date(`${a.due_date}T${a.due_time || '23:59'}`).getTime();
    const late = dt < now ? '⚠️ ' : '🔲 ';
    const time = a.due_time ? ` ${a.due_time.substring(0,5)}` : '';
    txt += `${late}*${a.subject || a.type}* — ${a.due_date}${time}\n`;
  }
  return txt.trim();
}

async function chercherListingDropbox(terme) {
  if (!dropboxToken) return '❌ Dropbox non connecté — dis "teste dropbox"';
  let dossiers = dropboxTerrains;
  if (!dossiers.length) {
    await loadDropboxStructure();
    dossiers = dropboxTerrains;
  }
  if (!dossiers.length) return `❌ Aucun dossier dans ${AGENT.dbx_terrains} — vérifier Dropbox`;

  const q = terme.toLowerCase();
  const matches = dossiers.filter(d => {
    const n = d.name.toLowerCase();
    return n.includes(q) || (d.centris && d.centris.includes(terme)) ||
           q.split(/[\s,]+/).every(w => n.includes(w));
  }).slice(0, 6);

  if (!matches.length) {
    const preview = dossiers.slice(0, 6).map(d => d.adresse || d.name).join(', ');
    return `Aucun listing "${terme}".\nDossiers disponibles: ${preview}${dossiers.length > 6 ? ` (+${dossiers.length - 6})` : ''}`;
  }

  const details = await Promise.all(matches.map(async f => {
    const r = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: f.path, recursive: false });
    const files = r?.ok ? (await r.json()).entries : [];
    const pdfs  = files.filter(x => x.name.toLowerCase().endsWith('.pdf')).map(x => x.name);
    const imgs  = files.filter(x => /\.(jpg|jpeg|png)$/i.test(x.name)).length;
    let txt = `📁 *${f.adresse || f.name}*${f.centris ? ` (Centris #${f.centris})` : ''}\n`;
    if (pdfs.length)  txt += `  📄 ${pdfs.join(' · ')}\n`;
    if (imgs > 0)     txt += `  🖼 ${imgs} photo(s)\n`;
    if (!files.length) txt += `  _(vide)_\n`;
    return txt.trim();
  }));
  return `🔍 *Listings "${terme}":*\n\n${details.join('\n\n')}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// MATCHING DROPBOX AVANCÉ — 4 stratégies en cascade avec score de confiance
// ═══════════════════════════════════════════════════════════════════════════
function _normalizeAddr(s) {
  if (!s) return '';
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/\b(rue|chemin|ch|avenue|av|boulevard|boul|route|rte|rang|rg|montee|place|pl)\b/g, '')
    .replace(/\b(qc|quebec|canada)\b/g, '')
    .replace(/\b[a-z]\d[a-z]\s?\d[a-z]\d\b/g, '') // code postal
    .replace(/[,.;()]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
function _addrTokens(s) {
  const n = _normalizeAddr(s);
  const numMatch = n.match(/\b(\d{1,6})\b/);
  const numero = numMatch ? numMatch[1] : '';
  const mots = n.split(/\s+/).filter(w => w && w.length > 2 && !/^\d+$/.test(w));
  return { numero, mots: new Set(mots), raw: n };
}

async function matchDropboxAvance(centris, adresse) {
  let dossiers = dropboxTerrains;
  if (!dossiers.length) { await loadDropboxStructure(); dossiers = dropboxTerrains; }
  if (!dossiers.length) return { folder: null, score: 0, strategy: 'no_folders', pdfs: [], candidates: [] };

  // STRATÉGIE 1 — Match exact par # Centris (confidence 100)
  if (centris) {
    const hit = dossiers.find(d => d.centris && d.centris === String(centris).trim());
    if (hit) {
      const pdfs = await _listFolderPDFs(hit);
      return { folder: hit, score: 100, strategy: 'centris_exact', pdfs, candidates: [{ folder: hit, score: 100 }] };
    }
  }

  // STRATÉGIE 2 — Fuzzy adresse normalisée (score 0-95)
  const scored = [];
  if (adresse) {
    const q = _addrTokens(adresse);
    for (const d of dossiers) {
      const t = _addrTokens(d.adresse || d.name);
      let score = 0;
      if (q.numero && t.numero && q.numero === t.numero) score += 50;
      if (q.mots.size && t.mots.size) {
        const inter = [...q.mots].filter(m => t.mots.has(m)).length;
        const union = new Set([...q.mots, ...t.mots]).size;
        score += Math.round(45 * (inter / Math.max(1, union))); // Jaccard
      }
      if (score > 0) scored.push({ folder: d, score });
    }
    scored.sort((a, b) => b.score - a.score);
  }
  const topCandidates = scored.slice(0, 3);
  const best = scored[0];

  // STRATÉGIE 3 — Filename scan pour Centris# (confidence 85)
  if (centris && (!best || best.score < 70)) {
    for (const d of dossiers.slice(0, 50)) { // limite pour ne pas scanner 500 dossiers
      const pdfs = await _listFolderPDFs(d);
      if (pdfs.some(p => p.name.includes(String(centris)))) {
        return { folder: d, score: 85, strategy: 'filename_centris', pdfs, candidates: [{ folder: d, score: 85 }] };
      }
    }
  }

  // STRATÉGIE 4 — Substring fallback (confidence 50-70)
  if ((!best || best.score < 50) && adresse) {
    const q = adresse.toLowerCase().split(/[\s,]+/).filter(w => w.length > 3)[0];
    if (q) {
      const hit = dossiers.find(d => (d.name + ' ' + d.adresse).toLowerCase().includes(q));
      if (hit) {
        const pdfs = await _listFolderPDFs(hit);
        return { folder: hit, score: 55, strategy: 'substring', pdfs, candidates: [{ folder: hit, score: 55 }] };
      }
    }
  }

  if (best && best.score >= 60) {
    const pdfs = await _listFolderPDFs(best.folder);
    return { folder: best.folder, score: best.score, strategy: 'fuzzy_addr', pdfs, candidates: topCandidates };
  }

  return { folder: null, score: best?.score || 0, strategy: 'no_match', pdfs: [], candidates: topCandidates };
}

async function _listFolderPDFs(folder) {
  try {
    const r = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: folder.path, recursive: false });
    if (!r?.ok) return [];
    return ((await r.json()).entries || []).filter(x => x.name.toLowerCase().endsWith('.pdf'));
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-ENVOI DOCS — garantie livraison avec retry + anti-doublon + tracking
// ═══════════════════════════════════════════════════════════════════════════
let autoEnvoiState = loadJSON(AUTOENVOI_FILE, { sent: {}, log: [], totalAuto: 0, totalFails: 0 });

async function envoyerDocsAuto({ email, nom, centris, dealId, deal, match }) {
  const dedupKey = `${email}|${centris || match?.folder?.centris || ''}`;
  const last = autoEnvoiState.sent[dedupKey];
  if (last && (Date.now() - last) < 24 * 3600 * 1000) {
    return { sent: false, skipped: true, reason: 'déjà envoyé <24h', match };
  }

  if (!match.folder || match.score < 90 || !match.pdfs?.length) {
    return { sent: false, skipped: true, reason: `score ${match.score} < 90 ou 0 PDF`, match };
  }

  const maxRetries = 3;
  const delays = [0, 30000, 120000]; // 0s, 30s, 2min
  let lastError = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (delays[attempt]) await new Promise(r => setTimeout(r, delays[attempt]));
    try {
      const t0 = Date.now();
      const result = await envoyerDocsProspect(nom || email, email, null, {
        dealHint: deal,
        folderHint: match.folder,
        centrisHint: centris,
      });
      const ms = Date.now() - t0;

      if (typeof result === 'string' && result.startsWith('✅')) {
        autoEnvoiState.sent[dedupKey] = Date.now();
        autoEnvoiState.log.unshift({
          timestamp: Date.now(), email, nom, centris,
          folder: match.folder.name, score: match.score, strategy: match.strategy,
          pdfsCount: match.pdfs.length, deliveryMs: ms, attempt: attempt + 1, success: true,
        });
        autoEnvoiState.log = autoEnvoiState.log.slice(0, 100); // garder 100 dernières
        autoEnvoiState.totalAuto = (autoEnvoiState.totalAuto || 0) + 1;
        saveJSON(AUTOENVOI_FILE, autoEnvoiState);
        log('OK', 'AUTOENVOI', `${email} <- ${match.pdfs.length} PDFs (${match.strategy}, score ${match.score}, ${ms}ms, try ${attempt + 1})`);
        return { sent: true, match, deliveryMs: ms, attempt: attempt + 1, resultStr: result };
      }
      lastError = result;
      log('WARN', 'AUTOENVOI', `Tentative ${attempt + 1}/${maxRetries} échouée: ${String(result).substring(0, 100)}`);
    } catch (e) {
      lastError = e.message;
      log('WARN', 'AUTOENVOI', `Tentative ${attempt + 1}/${maxRetries} exception: ${e.message}`);
    }
  }

  autoEnvoiState.log.unshift({
    timestamp: Date.now(), email, nom, centris,
    folder: match.folder?.name, score: match.score,
    error: String(lastError).substring(0, 200), success: false, attempts: maxRetries,
  });
  autoEnvoiState.log = autoEnvoiState.log.slice(0, 100);
  autoEnvoiState.totalFails = (autoEnvoiState.totalFails || 0) + 1;
  saveJSON(AUTOENVOI_FILE, autoEnvoiState);

  // Alerte Telegram critique + note Pipedrive
  if (dealId) {
    await pdPost('/notes', { deal_id: dealId, content: `⚠️ Auto-envoi docs ÉCHOUÉ après 3 tentatives: ${String(lastError).substring(0, 200)}` }).catch(() => null);
  }
  return { sent: false, error: lastError, match, attempts: maxRetries };
}

async function envoyerDocsProspect(terme, emailDest, fichier, opts = {}) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';

  // 1. Chercher deal — ou utiliser hint si fourni (auto-envoi)
  let deal;
  if (opts.dealHint) {
    deal = opts.dealHint;
  } else {
    const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
    const deals = sr?.data?.items || [];
    if (!deals.length) return `Aucun deal "${terme}" — crée-le d'abord.`;
    deal = deals[0].item;
  }
  const centris = deal[PD_FIELD_CENTRIS] || opts.centrisHint || '';

  // 2. Email destination
  let toEmail = emailDest || '';
  if (!toEmail && deal.person_id) {
    const p = await pdGet(`/persons/${deal.person_id}`);
    toEmail = p?.data?.email?.find(e => e.primary)?.value || p?.data?.email?.[0]?.value || '';
  }

  // 3. Dossier Dropbox — folder hint (auto) ou recherche
  let folder = opts.folderHint || null;
  if (!folder) {
    let dossiers = dropboxTerrains;
    if (!dossiers.length) { await loadDropboxStructure(); dossiers = dropboxTerrains; }
    folder = centris ? dossiers.find(d => d.centris === centris) : null;
    if (!folder) {
      const q = terme.toLowerCase().split(/\s+/)[0];
      folder = dossiers.find(d => d.name.toLowerCase().includes(q) || d.adresse.toLowerCase().includes(q));
    }
    if (!folder) {
      const avail = dossiers.slice(0, 5).map(d => d.adresse || d.name).join(', ');
      return `❌ Aucun dossier Dropbox pour "${deal.title}"${centris ? ` (#${centris})` : ''}.\nDisponible: ${avail}`;
    }
  }

  // 4. Lister les PDFs
  const lr = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: folder.path, recursive: false });
  if (!lr?.ok) return `❌ Impossible de lire ${folder.name}`;
  const all  = (await lr.json()).entries;
  const pdfs = all.filter(f => f.name.toLowerCase().endsWith('.pdf'));
  if (!pdfs.length) {
    return `❌ Aucun PDF dans *${folder.name}*.\nFichiers: ${all.map(f => f.name).join(', ') || '(vide)'}`;
  }

  // Si pas d'email, lister les docs disponibles
  if (!toEmail) {
    return `📁 *${folder.adresse || folder.name}*\nPDFs: ${pdfs.map(p => p.name).join(', ')}\n\n❓ Pas d'email pour *${deal.title}*.\nFournis: "email docs ${terme} à prenom@exemple.com"`;
  }

  // 5. Filtrer les PDFs à envoyer (si `fichier` spécifié → juste celui-là, sinon TOUS)
  const pdfsToSend = fichier
    ? pdfs.filter(p => p.name.toLowerCase().includes(fichier.toLowerCase()))
    : pdfs;
  if (!pdfsToSend.length) {
    return `❌ Aucun PDF matchant "${fichier}" dans ${folder.name}.\nDisponibles: ${pdfs.map(p=>p.name).join(', ')}`;
  }

  // 6. Télécharger TOUS les PDFs en parallèle
  const downloads = await Promise.all(pdfsToSend.map(async p => {
    const dl = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: p.path_lower }, true);
    if (!dl?.ok) return { name: p.name, error: `HTTP ${dl?.status || '?'}` };
    const buf = Buffer.from(await dl.arrayBuffer());
    if (buf.length === 0) return { name: p.name, error: 'fichier vide' };
    return { name: p.name, buffer: buf, size: buf.length };
  }));

  const ok = downloads.filter(d => d.buffer);
  const fails = downloads.filter(d => d.error);
  if (!ok.length) return `❌ Tous téléchargements Dropbox échoués:\n${fails.map(f => `  ${f.name}: ${f.error}`).join('\n')}`;

  const totalSize = ok.reduce((s, d) => s + d.size, 0);
  if (totalSize > 24 * 1024 * 1024) {
    // Taille totale dépasse — garder les plus petits jusqu'à la limite
    ok.sort((a, b) => a.size - b.size);
    let acc = 0; const keep = [];
    for (const d of ok) { if (acc + d.size > 22 * 1024 * 1024) break; keep.push(d); acc += d.size; }
    const skipped = ok.length - keep.length;
    log('WARN', 'DOCS', `Total ${Math.round(totalSize/1024/1024)}MB > 24MB — ${skipped} PDF(s) omis, ${keep.length} envoyés`);
    ok.length = 0; ok.push(...keep);
  }

  // 7. Lire le master template Dropbox (logos Signature SB + RE/MAX base64)
  const token = await getGmailToken();
  if (!token) return `❌ Gmail non configuré.\nDocs dispo: ${ok.map(d=>d.name).join(', ')} dans ${folder.adresse || folder.name}`;

  const tplPath = `${AGENT.dbx_templates}/master_template_signature_sb.html`.replace(/\/+/g, '/');
  let masterTpl = null;
  try {
    const tplRes = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: tplPath.startsWith('/')?tplPath:'/'+tplPath }, true);
    if (tplRes?.ok) masterTpl = await tplRes.text();
  } catch (e) { log('WARN', 'DOCS', `Template Dropbox: ${e.message}`); }

  const propLabel = folder.adresse || folder.name;
  const now       = new Date();
  const dateMois  = now.toLocaleDateString('fr-CA', { month:'long', year:'numeric', timeZone:'America/Toronto' });
  const sujet     = `Documents — ${propLabel} | ${AGENT.compagnie}`;

  // Liste des pièces jointes en HTML
  const pjListHTML = ok.map(d =>
    `<tr><td style="padding:4px 0;color:#f5f5f7;font-size:13px;">📎 ${d.name} <span style="color:#666;font-size:11px;">(${Math.round(d.size/1024)} KB)</span></td></tr>`
  ).join('');

  // Contenu métier — injecté dans le master template à la place d'INTRO_TEXTE
  // NOTE: le master template Dropbox a DÉJÀ un bloc "Programme référence" à la fin,
  // donc on ne le duplique PAS ici.
  const contentHTML = `
<p style="margin:0 0 16px;color:#cccccc;font-size:14px;line-height:1.7;">Veuillez trouver ci-joint la documentation concernant la propriété <strong style="color:#f5f5f7;">${propLabel}</strong>.</p>

<div style="background:#111111;border:1px solid #1e1e1e;border-radius:8px;padding:18px 20px;margin:16px 0;">
<div style="color:#aa0721;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:10px;">📎 Pièces jointes — ${ok.length} document${ok.length>1?'s':''}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${pjListHTML}</table>
</div>

<p style="margin:16px 0;color:#cccccc;font-size:14px;line-height:1.6;">N'hésitez pas si vous avez des questions — je suis disponible au <strong style="color:#aa0721;">${AGENT.telephone}</strong>.</p>`;

  // Construire le HTML final
  let htmlFinal;
  if (masterTpl && masterTpl.length > 5000) {
    // Utiliser le master template Dropbox (avec logos base64 Signature SB + RE/MAX)
    const fill = (tpl, p) => { let h = tpl; for (const [k, v] of Object.entries(p)) h = h.split(`{{ params.${k} }}`).join(v ?? ''); return h; };
    htmlFinal = fill(masterTpl, {
      TITRE_EMAIL:        `Documents — ${propLabel}`,
      LABEL_SECTION:      `Documentation propriété`,
      DATE_MOIS:          dateMois,
      TERRITOIRES:        propLabel,
      SOUS_TITRE_ANALYSE: propLabel,
      HERO_TITRE:         `Documents<br>pour ${propLabel}.`,
      INTRO_TEXTE:        contentHTML,
      TITRE_SECTION_1:    '',
      MARCHE_LABEL:       '',
      PRIX_MEDIAN:        '',
      VARIATION_PRIX:     '',
      SOURCE_STAT:        '',
      LABEL_TABLEAU:      '',
      TABLEAU_STATS_HTML: '',
      TITRE_SECTION_2:    '',
      CITATION:           `Je reste disponible pour toute question concernant ce dossier.`,
      CONTENU_STRATEGIE:  '',
      CTA_TITRE:          `Des questions?`,
      CTA_SOUS_TITRE:     `Appelez-moi directement, je vous réponds rapidement.`,
      CTA_URL:            `tel:${AGENT.telephone.replace(/\D/g,'')}`,
      CTA_BOUTON:         `Appeler ${AGENT.prenom} — ${AGENT.telephone}`,
      CTA_NOTE:           `${AGENT.nom} · ${AGENT.compagnie}`,
      REFERENCE_URL:      `tel:${AGENT.telephone.replace(/\D/g,'')}`,
      SOURCES:            `${AGENT.nom} · ${AGENT.compagnie} · ${dateMois}`,
      DESINSCRIPTION_URL: '',
    });

    // Retirer les sections inutiles pour un email de docs (garder header, hero, intro, CTA, footer avec logos)
    // Supprime: SECTION 01, HERO STAT, TABLEAU, SECTION 02, CITATION
    htmlFinal = htmlFinal.replace(
      /<!-- ══ SÉPARATEUR ══ -->[\s\S]*?<!-- ══ CTA PRINCIPAL ══ -->/,
      '<!-- ══ CTA PRINCIPAL ══ -->'
    );
    // Remplacer le label "Données Centris Matrix" à côté du logo par la spécialité de Shawn
    htmlFinal = htmlFinal.replace(
      /Données Centris Matrix/g,
      'Spécialiste vente maison usagée, construction neuve et développement immobilier'
    );
    // PUNCH référencement — 500$ à 1 000$ en HERO stat 56px rouge pour maximiser conversion
    const refPunch = `
          <div style="color:#aa0721; font-size:10px; font-weight:700; letter-spacing:3px; text-transform:uppercase; margin-bottom:14px;">💰 Programme référence</div>
          <div style="font-family:Georgia,serif; font-size:20px; color:#f5f5f7; line-height:1.3; margin-bottom:18px;">
            Vous connaissez quelqu'un<br/>qui veut acheter ou vendre ?
          </div>
          <div style="font-family:Georgia,serif; font-size:56px; font-weight:800; color:#aa0721; line-height:1; margin:14px 0 6px; letter-spacing:-1px;">500$ <span style="color:#666;font-size:34px;font-weight:400;">à</span> 1 000$</div>
          <div style="color:#f5f5f7; font-size:13px; font-weight:700; letter-spacing:2px; text-transform:uppercase; margin-bottom:22px;">En argent · pour chaque référence conclue</div>
          <div style="color:#cccccc; font-size:13px; line-height:1.7; margin-bottom:22px;">Pas de paperasse — juste un appel.<br/>Payé à la signature chez le notaire.</div>
          <a href="tel:${AGENT.telephone.replace(/\D/g,'')}" style="display:inline-block; background-color:#aa0721; color:#ffffff; font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif; font-size:13px; font-weight:700; letter-spacing:2px; text-transform:uppercase; padding:15px 32px; border-radius:3px; text-decoration:none;">Référer quelqu'un</a>`;
    htmlFinal = htmlFinal.replace(
      /<!-- ══ PROGRAMME RÉFÉRENCE ══ -->[\s\S]*?<td style="background-color:#0d0d0d[^>]*>[\s\S]*?<\/td>/,
      `<!-- ══ PROGRAMME RÉFÉRENCE ══ -->
  <tr>
    <td style="padding:0 28px 40px;" class="mobile-pad">
      <table width="100%" cellpadding="0" cellspacing="0" border="0"><tbody><tr>
        <td style="background-color:#0d0d0d; border:1px solid #1e1e1e; border-top:4px solid #aa0721; border-radius:4px; padding:36px 28px; text-align:center;">${refPunch}
        </td>`
    );
    log('OK', 'DOCS', `Master template Dropbox utilisé (${Math.round(masterTpl.length/1024)}KB avec logos) — sections vides retirées + label logo personnalisé + punch référencement`);
  } else {
    // Fallback HTML inline brandé si Dropbox template indisponible
    htmlFinal = `<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;background:#0a0a0a;">
<table width="600" style="max-width:600px;background:#0a0a0a;color:#f5f5f7;">
<tr><td style="background:${AGENT.couleur};height:4px;font-size:1px;">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 20px;">
<div style="color:${AGENT.couleur};font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;">${AGENT.compagnie}</div>
<h2 style="color:#f5f5f7;font-size:22px;margin:10px 0 0;">${AGENT.nom}</h2>
</td></tr>
<tr><td style="padding:0 32px 20px;">${contentHTML}
<p style="margin:24px 0 0;color:#f5f5f7;">Au plaisir,<br><strong>${AGENT.prenom}</strong></p>
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #1a1a1a;color:#666;font-size:12px;">
<strong>${AGENT.nom}</strong> · ${AGENT.compagnie}<br>
📞 ${AGENT.telephone} · <a href="mailto:${AGENT.email}" style="color:${AGENT.couleur};">${AGENT.email}</a> · <a href="https://${AGENT.site}" style="color:${AGENT.couleur};">${AGENT.site}</a>
</td></tr>
<tr><td style="background:${AGENT.couleur};height:4px;font-size:1px;">&nbsp;</td></tr>
</table></td></tr></table></body></html>`;
    log('WARN', 'DOCS', 'Master template Dropbox indisponible — fallback HTML inline');
  }

  // 8. Construire MIME multipart avec TOUS les PDFs
  const outer = `sbOut${Date.now()}`;
  const inner = `sbAlt${Date.now()}`;
  const enc   = s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`;
  const textBody = `Bonjour,\n\nVeuillez trouver ci-joint ${ok.length} document${ok.length>1?'s':''} concernant ${propLabel}:\n${ok.map(d=>`• ${d.name}`).join('\n')}\n\nN'hésitez pas si vous avez des questions — ${AGENT.telephone}.\n\nAu plaisir,\n${AGENT.prenom}\n${AGENT.nom} · ${AGENT.compagnie}`;

  const lines = [
    `From: ${AGENT.nom} · ${AGENT.compagnie} <${AGENT.email}>`,
    `To: ${toEmail}`,
    `Bcc: ${AGENT.email}`,
    `Reply-To: ${AGENT.email}`,
    `Subject: ${enc(sujet)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${outer}"`,
    '',
    `--${outer}`,
    `Content-Type: multipart/alternative; boundary="${inner}"`,
    '',
    `--${inner}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    textBody,
    '',
    `--${inner}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(htmlFinal, 'utf-8').toString('base64'),
    `--${inner}--`,
    '',
  ];

  // Ajouter chaque PDF comme pièce jointe
  for (const doc of ok) {
    lines.push(
      `--${outer}`,
      'Content-Type: application/pdf',
      `Content-Disposition: attachment; filename="${enc(doc.name)}"`,
      'Content-Transfer-Encoding: base64',
      '',
      doc.buffer.toString('base64'),
      ''
    );
  }
  lines.push(`--${outer}--`);

  const raw = Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');

  const sendController = new AbortController();
  const sendTimeout    = setTimeout(() => sendController.abort(), 30000);
  let sendRes;
  try {
    sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST', signal: sendController.signal,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw })
    });
  } finally { clearTimeout(sendTimeout); }

  if (!sendRes.ok) {
    const errMsg = await sendRes.text().catch(() => String(sendRes.status));
    return `❌ Gmail erreur ${sendRes.status}: ${errMsg.substring(0, 200)}`;
  }

  // 9. Note Pipedrive (liste des docs envoyés)
  const noteContent = `Documents envoyés à ${toEmail} (${new Date().toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}):\n${ok.map(d => `• ${d.name}`).join('\n')}`;
  const noteRes = await pdPost('/notes', { deal_id: deal.id, content: noteContent }).catch(() => null);
  const noteLabel = noteRes?.data?.id ? '📝 Note Pipedrive ajoutée' : '⚠️ Note Pipedrive non créée';

  const skippedMsg = fails.length > 0 ? `\n⚠️ ${fails.length} PDF(s) échec téléchargement: ${fails.map(f=>f.name).join(', ')}` : '';
  return `✅ *${ok.length} document${ok.length>1?'s':''} envoyé${ok.length>1?'s':''}* à *${toEmail}*\n${ok.map(d=>`  📎 ${d.name}`).join('\n')}\nProspect: ${deal.title}\n${noteLabel}${skippedMsg}`;
}

// ─── Brevo ────────────────────────────────────────────────────────────────────
const BREVO_LISTES = { prospects: 4, acheteurs: 5, vendeurs: 7 };

async function ajouterBrevo({ email, prenom, nom, telephone, liste }) {
  if (!BREVO_KEY) return '❌ BREVO_API_KEY absent';
  if (!email) return '❌ Email requis pour Brevo';
  const listeId = BREVO_LISTES[liste] || BREVO_LISTES.prospects;
  const attributes = { FIRSTNAME: prenom || '', LASTNAME: nom || '' };
  if (telephone) attributes.SMS = telephone.replace(/\D/g, '');
  try {
    const res = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, updateEnabled: true, attributes, listIds: [listeId] })
    });
    if (!res.ok) { const err = await res.text(); return `❌ Brevo: ${err.substring(0, 200)}`; }
    const listeNom = { 4: 'Prospects', 5: 'Acheteurs', 7: 'Vendeurs' }[listeId] || 'liste';
    return `✅ ${prenom || email} ajouté à Brevo — liste ${listeNom}.`;
  } catch (e) { return `❌ Brevo: ${e.message}`; }
}

async function envoyerEmailBrevo({ to, toName, subject, textContent, htmlContent }) {
  if (!BREVO_KEY) return false;
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender: { name: `${AGENT.nom} · ${AGENT.compagnie}`, email: AGENT.email }, replyTo: { email: AGENT.email, name: AGENT.nom }, to: [{ email: to, name: toName || to }], subject, textContent: textContent || '', htmlContent: htmlContent || textContent || '' })
  });
  return res.ok;
}

// ─── Gmail ────────────────────────────────────────────────────────────────────
let gmailToken = null;
let gmailTokenExp = 0;
let gmailRefreshInProgress = null;

async function getGmailToken() {
  const { GMAIL_CLIENT_ID: cid, GMAIL_CLIENT_SECRET: csec, GMAIL_REFRESH_TOKEN: ref } = process.env;
  if (!cid || !csec || !ref) return null;
  if (gmailToken && Date.now() < gmailTokenExp - 60000) return gmailToken;
  // Attendre si refresh déjà en cours — retourner null si ça échoue (pas throw)
  if (gmailRefreshInProgress) {
    try { return await gmailRefreshInProgress; } catch { return null; }
  }
  gmailRefreshInProgress = (async () => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', signal: controller.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: ref, grant_type: 'refresh_token' })
      });
      const data = await res.json();
      if (!data.access_token) throw new Error(`Pas de access_token: ${JSON.stringify(data).substring(0,100)}`);
      gmailToken    = data.access_token;
      gmailTokenExp = Date.now() + (data.expires_in || 3600) * 1000;
      log('OK', 'GMAIL', 'Token rafraîchi ✓');
      return gmailToken;
    } catch (e) {
      log('ERR', 'GMAIL', `Refresh fail: ${e.message}`);
      gmailToken = null; gmailTokenExp = 0;
      return null; // retourner null plutôt que throw — évite crash cascade
    } finally { clearTimeout(t); gmailRefreshInProgress = null; }
  })();
  try { return await gmailRefreshInProgress; } catch { return null; }
}

async function gmailAPI(endpoint, options = {}) {
  const token = await getGmailToken();
  if (!token) throw new Error('Gmail non configuré (GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN manquants)');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${endpoint}`, {
      ...options, signal: controller.signal,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (!res.ok) { const err = await res.text(); throw new Error(`Gmail ${endpoint}: ${err.substring(0, 200)}`); }
    return res.json();
  } finally { clearTimeout(t); }
}

function gmailDecodeBase64(str) {
  try { return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8'); } catch { return ''; }
}

function gmailExtractBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return gmailDecodeBase64(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return gmailDecodeBase64(part.body.data);
    }
  }
  return payload.snippet || '';
}

async function voirEmailsRecents(depuis = '1d') {
  try {
    const q = `-from:signaturesb.com -from:shawnbarrette@icloud.com -from:noreply@ -from:no-reply@ -from:brevo -from:pipedrive -from:calendly in:inbox newer_than:${depuis}`;
    const list = await gmailAPI(`/messages?maxResults=10&q=${encodeURIComponent(q)}`);
    if (!list.messages?.length) return `Aucun email prospect dans les dernières ${depuis}.`;
    const emails = await Promise.all(list.messages.slice(0, 6).map(async m => {
      try {
        const d = await gmailAPI(`/messages/${m.id}?format=full`);
        const headers = d.payload?.headers || [];
        const get = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
        return `📧 *De:* ${get('From')}\n*Objet:* ${get('Subject')}\n*Date:* ${get('Date')}\n_${d.snippet?.substring(0, 150) || ''}_`;
      } catch { return null; }
    }));
    return `📬 *Emails prospects récents (${depuis}):*\n\n` + emails.filter(Boolean).join('\n\n---\n\n');
  } catch (e) {
    if (e.message.includes('non configuré')) return '⚠️ Gmail non configuré dans Render. Ajoute: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN.';
    return `Erreur Gmail: ${e.message}`;
  }
}

async function voirConversation(terme) {
  try {
    const t = terme.includes('@') ? terme : (terme.includes(' ') ? `"${terme}"` : terme);
    const [recu, envoye] = await Promise.all([
      gmailAPI(`/messages?maxResults=4&q=${encodeURIComponent(`from:${t} newer_than:30d`)}`).catch(() => ({ messages: [] })),
      gmailAPI(`/messages?maxResults=4&q=${encodeURIComponent(`to:${t} newer_than:30d in:sent`)}`).catch(() => ({ messages: [] }))
    ]);
    const ids = [
      ...(recu.messages  || []).map(m => ({ id: m.id, sens: '📥 Reçu' })),
      ...(envoye.messages || []).map(m => ({ id: m.id, sens: '📤 Envoyé' }))
    ];
    if (!ids.length) return `Aucun échange Gmail avec "${terme}" dans les 30 derniers jours.`;
    const emails = await Promise.all(ids.slice(0, 5).map(async ({ id, sens }) => {
      try {
        const d = await gmailAPI(`/messages/${id}?format=full`);
        const headers = d.payload?.headers || [];
        const get = n => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';
        const corps = gmailExtractBody(d.payload).substring(0, 600).trim();
        const dateMs = parseInt(d.internalDate || '0');
        return { sens, de: get('From'), sujet: get('Subject'), date: get('Date'), corps, dateMs };
      } catch { return null; }
    }));
    const sorted = emails.filter(Boolean).sort((a, b) => a.dateMs - b.dateMs); // chronologique
    let result = `📧 *Conversation avec "${terme}" (30 derniers jours):*\n\n`;
    for (const e of sorted) {
      result += `${e.sens} | *${e.sujet}*\n${e.date}\n${e.corps ? `_${e.corps}_` : ''}\n\n`;
    }
    return result.trim();
  } catch (e) {
    if (e.message.includes('non configuré')) return '⚠️ Gmail non configuré dans Render.';
    return `Erreur Gmail: ${e.message}`;
  }
}

async function envoyerEmailGmail({ to, toName, sujet, texte }) {
  const token = await getGmailToken();
  if (!token) throw new Error('Gmail non configuré — vérifier GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN dans Render');

  // HTML branded dynamique (utilise AGENT_CONFIG)
  const html = `<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:600px;margin:0 auto;padding:20px;">
<div style="border-top:3px solid ${AGENT.couleur};padding-top:16px;">
${texte.split('\n').map(l => l.trim() ? `<p style="margin:0 0 12px;">${l}</p>` : '<br>').join('')}
</div>
<div style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;color:#666;font-size:12px;">
<strong>${AGENT.nom}</strong> · ${AGENT.compagnie}<br>
📞 ${AGENT.telephone} · <a href="https://${AGENT.site}" style="color:${AGENT.couleur};">${AGENT.site}</a>
</div>
</body></html>`;

  const boundary  = `sb_${Date.now()}`;
  const toHeader  = toName ? `${toName} <${to}>` : to;
  const encSubj   = s => {
    // Encoder chaque mot si nécessaire (robuste pour sujets longs)
    const b64 = Buffer.from(s, 'utf-8').toString('base64');
    return `=?UTF-8?B?${b64}?=`;
  };

  const msgLines = [
    `From: ${AGENT.nom} · ${AGENT.compagnie} <${AGENT.email}>`,
    `To: ${toHeader}`,
    `Bcc: ${AGENT.email}`,
    `Reply-To: ${AGENT.email}`,
    `Subject: ${encSubj(sujet)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    texte,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(html, 'utf-8').toString('base64'),
    `--${boundary}--`,
  ];

  const raw = Buffer.from(msgLines.join('\r\n'), 'utf-8')
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmailAPI('/messages/send', { method: 'POST', body: JSON.stringify({ raw }) });
}

// ─── Réponse rapide mobile (trouve email auto + brouillon) ────────────────────
async function repondreVite(chatId, terme, messageTexte) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `❌ Prospect "${terme}" introuvable dans Pipedrive.`;
  const deal = deals[0].item;

  // Trouver l'email
  let toEmail = '', toName = deal.title;
  if (deal.person_id) {
    const p = await pdGet(`/persons/${deal.person_id}`);
    toEmail  = p?.data?.email?.find(e => e.primary)?.value || p?.data?.email?.[0]?.value || '';
    toName   = p?.data?.name || deal.title;
  }
  if (!toEmail) return `❌ Pas d'email pour *${deal.title}* dans Pipedrive.\nAjoute-le via "modifie deal ${terme} email [adresse]" ou crée la personne.`;

  // Mettre en forme selon style Shawn
  const texteFormate = messageTexte.trim().endsWith(',')
    ? messageTexte.trim()
    : messageTexte.trim();
  const sujet = `${deal.title} — ${AGENT.compagnie}`;

  // Stocker comme brouillon en attente
  pendingEmails.set(chatId, { to: toEmail, toName, sujet, texte: texteFormate });

  return `📧 *Brouillon prêt pour ${deal.title}*\nDest: ${toEmail}\n\n---\n${texteFormate}\n---\n\nDis *"envoie"* pour confirmer.`;
}

// ─── Historique complet d'un prospect (timeline mobile-friendly) ──────────────
async function historiqueContact(terme) {
  if (!PD_KEY) return '❌ PIPEDRIVE_API_KEY absent';
  const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=3`);
  const deals = sr?.data?.items || [];
  if (!deals.length) return `Aucun prospect "${terme}"`;
  const deal = deals[0].item;

  const [notes, activities, person] = await Promise.all([
    pdGet(`/notes?deal_id=${deal.id}&limit=20`),
    pdGet(`/activities?deal_id=${deal.id}&limit=20`),
    deal.person_id ? pdGet(`/persons/${deal.person_id}`) : Promise.resolve(null),
  ]);

  // Construire timeline unifiée
  const events = [];

  // Notes
  (notes?.data || []).forEach(n => {
    if (!n.content?.trim()) return;
    events.push({ ts: new Date(n.add_time).getTime(), type: '📝', text: n.content.trim().substring(0, 150), date: n.add_time });
  });

  // Activités
  (activities?.data || []).forEach(a => {
    const done = a.done ? '✅' : (new Date(`${a.due_date}T${a.due_time||'23:59'}`).getTime() < Date.now() ? '⚠️' : '🔲');
    events.push({ ts: new Date(a.due_date || a.add_time).getTime(), type: done, text: `${a.subject || a.type} (${a.type})`, date: a.due_date || a.add_time });
  });

  // Trier chronologique
  events.sort((a, b) => b.ts - a.ts);

  const stageLabel = PD_STAGES[deal.stage_id] || deal.stage_id;
  const phones = person?.data?.phone?.filter(p => p.value).map(p => p.value) || [];
  const emails = person?.data?.email?.filter(e => e.value).map(e => e.value) || [];

  let txt = `📋 *Historique — ${deal.title}*\n${stageLabel}\n`;
  if (phones.length) txt += `📞 ${phones.join(' · ')}\n`;
  if (emails.length) txt += `✉️ ${emails.join(' · ')}\n`;
  txt += `\n`;

  if (!events.length) return txt + '_Aucun historique._';
  events.slice(0, 10).forEach(e => {
    const date = new Date(e.date).toLocaleDateString('fr-CA', { day:'numeric', month:'short' });
    txt += `${e.type} [${date}] ${e.text}\n`;
  });
  if (events.length > 10) txt += `\n_+ ${events.length - 10} événements plus anciens_`;
  return txt.trim();
}

// ─── Whisper (voix → texte) ───────────────────────────────────────────────────
async function transcrire(audioBuffer) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY non configuré dans Render');
  if (audioBuffer.length > 24 * 1024 * 1024) throw new Error('Message vocal trop long (max ~15 min)');
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: 'audio/ogg' }), 'voice.ogg');
  formData.append('model', 'whisper-1');
  formData.append('language', 'fr');
  formData.append('prompt', 'Immobilier québécois: Centris, Pipedrive, terrain, plex, courtier, ProFab, Desjardins, fosse septique, Rawdon, Saint-Julienne, Lanaudière, RE/MAX Prestige, offre d\'achat, TVQ.');
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', { method: 'POST', signal: controller.signal, headers: { 'Authorization': `Bearer ${key}` }, body: formData });
    if (!res.ok) { const err = await res.text(); throw new Error(`Whisper HTTP ${res.status}: ${err.substring(0, 150)}`); }
    const data = await res.json();
    return data.text?.trim() || null;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('Transcription trop longue (timeout 30s)');
    throw e;
  } finally { clearTimeout(t); }
}

// ─── Contacts iPhone (Dropbox /Contacts/contacts.vcf) ────────────────────────
async function chercherContact(terme) {
  const paths = ['/Contacts/contacts.vcf', '/Contacts/contacts.csv', '/contacts.vcf', '/contacts.csv'];
  let raw = null, format = null;
  for (const p of paths) {
    const res = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: p }, true);
    if (res && res.ok) { raw = await res.text(); format = p.endsWith('.vcf') ? 'vcf' : 'csv'; break; }
  }
  if (!raw) return '📵 Fichier contacts introuvable dans Dropbox.\nExporte tes contacts iPhone → `/Contacts/contacts.vcf` via un Raccourci iOS.';
  const q = terme.toLowerCase().replace(/\s+/g, ' ').trim();
  const results = [];
  if (format === 'vcf') {
    const cards = raw.split(/BEGIN:VCARD/i).slice(1);
    for (const card of cards) {
      const get = (field) => { const m = card.match(new RegExp(`^${field}[^:]*:(.+)$`, 'mi')); return m ? m[1].replace(/\r/g, '').trim() : ''; };
      const name  = get('FN') || get('N').replace(/;/g, ' ').trim();
      const org   = get('ORG');
      const email = card.match(/^EMAIL[^:]*:(.+)$/mi)?.[1]?.replace(/\r/g, '').trim() || '';
      const phones = [...card.matchAll(/^TEL[^:]*:(.+)$/gmi)].map(m => m[1].replace(/\r/g, '').trim());
      const blob = [name, org, email, ...phones].join(' ').toLowerCase();
      if (blob.includes(q) || q.split(' ').every(w => blob.includes(w))) { results.push({ name, org, email, phones }); if (results.length >= 5) break; }
    }
  } else {
    const lines = raw.split('\n').filter(l => l.trim());
    for (const line of lines.slice(1)) {
      if (q.split(' ').every(w => line.toLowerCase().includes(w))) { results.push({ raw: line.replace(/,/g, ' · ') }); if (results.length >= 5) break; }
    }
  }
  if (!results.length) return `Aucun contact iPhone trouvé pour "${terme}".`;
  return results.map(c => {
    if (c.raw) return `📱 ${c.raw}`;
    let s = `📱 *${c.name}*`;
    if (c.org)    s += ` — ${c.org}`;
    if (c.phones.length) s += `\n📞 ${c.phones.join(' · ')}`;
    if (c.email)  s += `\n✉️ ${c.email}`;
    return s;
  }).join('\n\n');
}

// ─── Recherche web ────────────────────────────────────────────────────────────
async function rechercherWeb(requete) {
  if (process.env.PERPLEXITY_API_KEY) {
    try {
      const res = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonar', max_tokens: 500, messages: [
          { role: 'system', content: 'Assistant recherche courtier immobilier québécois. Réponds en français, sources canadiennes (Centris, APCIQ, Desjardins, BdC). Chiffres précis.' },
          { role: 'user', content: requete }
        ]})
      });
      if (res.ok) { const d = await res.json(); const t = d.choices?.[0]?.message?.content?.trim(); if (t) return `🔍 *${requete}*\n\n${t}`; }
    } catch {}
  }
  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      const res = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(requete)}&count=5&country=ca&search_lang=fr`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY }
      });
      if (res.ok) { const d = await res.json(); const results = (d.web?.results || []).slice(0, 4); if (results.length) return `🔍 *${requete}*\n\n${results.map((r, i) => `${i+1}. **${r.title}**\n${r.description || ''}`).join('\n\n')}`; }
    } catch {}
  }
  try {
    let contexte = '';
    const ddg = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(requete)}&format=json&no_html=1`, { headers: { 'User-Agent': 'SignatureSB/1.0' } });
    if (ddg.ok) { const d = await ddg.json(); contexte = [d.AbstractText, ...(d.RelatedTopics || []).slice(0,3).map(t => t.Text || '')].filter(Boolean).join('\n'); }
    const prompt = contexte
      ? `Synthétise pour courtier immobilier QC: "${requete}"\nSources: ${contexte}\nRéponds en français, chiffres précis, règles QC.`
      : `Réponds pour courtier QC: "${requete}"\nFrançais, règles QC (OACIQ, Code civil, TPS+TVQ), chiffres concrets.`;
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 500, messages: [{ role: 'user', content: prompt }] })
    });
    if (res.ok) { const d = await res.json(); const t = d.content?.[0]?.text?.trim(); if (t) return `🔍 *${requete}*\n\n${t}`; }
  } catch (e) { log('WARN', 'WEB', e.message); }
  return `Aucun résultat trouvé pour: "${requete}"`;
}

// ─── CENTRIS AGENT — Connexion authentifiée + Comparables + Actifs ───────────
// Credentials: CENTRIS_USER + CENTRIS_PASS dans Render env vars

const CENTRIS_BASE = 'https://www.centris.ca';

// Session Centris (expire 2h)
let centrisSession = { cookies: '', expiry: 0, authenticated: false };

// Headers communs Centris (simule mobile app)
const CENTRIS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-CA,fr;q=0.9,en-CA;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache',
};

async function centrisLogin() {
  const user = process.env.CENTRIS_USER;
  const pass = process.env.CENTRIS_PASS;
  if (!user || !pass) return false;

  try {
    // 1. Charger la page login pour obtenir le token CSRF et les cookies de session
    const pageController = new AbortController();
    const pageTimeout    = setTimeout(() => pageController.abort(), 15000);
    const pageRes = await fetch(`${CENTRIS_BASE}/fr/connexion`, {
      signal: pageController.signal,
      headers: CENTRIS_HEADERS,
    }).finally(() => clearTimeout(pageTimeout));

    if (!pageRes.ok && pageRes.status !== 200) {
      log('WARN', 'CENTRIS', `Page login HTTP ${pageRes.status}`);
    }

    const pageHtml   = await pageRes.text();
    const pageCookie = pageRes.headers.get('set-cookie') || '';

    // Extraire token anti-forgery
    const csrf = pageHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1]
              || pageHtml.match(/"RequestVerificationToken"\s*content="([^"]+)"/i)?.[1]
              || '';

    // 2. POST les credentials
    const loginController = new AbortController();
    const loginTimeout    = setTimeout(() => loginController.abort(), 15000);
    const loginRes = await fetch(`${CENTRIS_BASE}/fr/connexion`, {
      method:   'POST',
      redirect: 'manual',
      signal:   loginController.signal,
      headers: {
        ...CENTRIS_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie':   pageCookie,
        'Referer':  `${CENTRIS_BASE}/fr/connexion`,
        'Origin':   CENTRIS_BASE,
      },
      body: new URLSearchParams({
        UserName:                   user,
        Password:                   pass,
        __RequestVerificationToken: csrf,
        ReturnUrl:                  '/fr/',
        'Remember':                 'false',
      }),
    }).finally(() => clearTimeout(loginTimeout));

    const respCk = loginRes.headers.get('set-cookie') || '';
    // Combiner tous les cookies
    const allCookies = [pageCookie, respCk]
      .join('; ')
      .split(';')
      .map(c => c.trim().split(';')[0])
      .filter(c => c.includes('='))
      .join('; ');

    // Détecter le succès (redirect 302, cookie auth, ou header Location)
    const location = loginRes.headers.get('location') || '';
    const isOk = loginRes.status === 302
              || respCk.toLowerCase().includes('aspxauth')
              || respCk.toLowerCase().includes('.centris.')
              || (location && !location.includes('connexion'));

    if (isOk) {
      centrisSession = { cookies: allCookies, expiry: Date.now() + 2 * 3600000, authenticated: true };
      log('OK', 'CENTRIS', `Connecté ✓ (code agent: ${user})`);
      return true;
    }

    log('WARN', 'CENTRIS', `Login: HTTP ${loginRes.status} — location: ${location.substring(0,80)}`);
    return false;
  } catch (e) {
    log('ERR', 'CENTRIS', `Login exception: ${e.message}`);
    return false;
  }
}

async function centrisGet(path, options = {}) {
  // Auto-relogin si session expirée
  if (!centrisSession.cookies || Date.now() > centrisSession.expiry) {
    const ok = await centrisLogin();
    if (!ok) throw new Error('Centris: impossible de se connecter — vérifier CENTRIS_USER/CENTRIS_PASS');
  }

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${CENTRIS_BASE}${path}`, {
      signal: controller.signal,
      headers: {
        ...CENTRIS_HEADERS,
        'Cookie': centrisSession.cookies,
        'Referer': CENTRIS_BASE,
        ...(options.headers || {}),
      },
      ...options,
    });

    // Session expirée → re-login une fois
    if (res.status === 401 || (res.url && res.url.includes('connexion'))) {
      centrisSession.expiry = 0;
      const ok = await centrisLogin();
      if (!ok) throw new Error('Re-login Centris échoué');
      return centrisGet(path, options); // retry
    }
    return res;
  } finally { clearTimeout(t); }
}

// Normalisation villes → slugs URL Centris
const VILLES_CENTRIS = {
  'rawdon':'rawdon','raw':'rawdon',
  'sainte-julienne':'sainte-julienne','saint-julienne':'sainte-julienne','julienne':'sainte-julienne','ste-julienne':'sainte-julienne',
  'chertsey':'chertsey',
  'saint-didace':'saint-didace','didace':'saint-didace',
  'sainte-marcelline':'sainte-marcelline-de-kildare','sainte-marcelline-de-kildare':'sainte-marcelline-de-kildare','marcelline':'sainte-marcelline-de-kildare',
  'saint-jean-de-matha':'saint-jean-de-matha','matha':'saint-jean-de-matha',
  'saint-calixte':'saint-calixte','calixte':'saint-calixte',
  'saint-lin':'saint-lin-laurentides','saint-lin-laurentides':'saint-lin-laurentides',
  'joliette':'joliette',
  'repentigny':'repentigny',
  'terrebonne':'terrebonne','lachenaie':'terrebonne',
  'mascouche':'mascouche',
  'berthierville':'berthierville',
  'montreal':'montreal','mtl':'montreal',
  'laval':'laval',
  'longueuil':'longueuil',
  'saint-jerome':'saint-jerome','saint-jérôme':'saint-jerome',
  'mirabel':'mirabel','blainville':'blainville','boisbriand':'boisbriand',
};

// Types propriété → slugs Centris
const TYPES_CENTRIS = {
  'terrain':         { slug:'terrain',               genre:'vendu'  },
  'lot':             { slug:'terrain',               genre:'vendu'  },
  'maison':          { slug:'maison',                genre:'vendue' },
  'maison_usagee':   { slug:'maison',                genre:'vendue' },
  'unifamiliale':    { slug:'maison',                genre:'vendue' },
  'bungalow':        { slug:'bungalow',              genre:'vendu'  },
  'plex':            { slug:'immeuble-a-revenus',    genre:'vendu'  },
  'duplex':          { slug:'duplex',                genre:'vendu'  },
  'triplex':         { slug:'triplex',               genre:'vendu'  },
  'condo':           { slug:'appartement-condo',     genre:'vendu'  },
};

function slugVille(v) {
  const k = (v||'').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,'-');
  return VILLES_CENTRIS[k] || VILLES_CENTRIS[v.toLowerCase().trim()] || k;
}
function slugType(t) { return TYPES_CENTRIS[(t||'terrain').toLowerCase()] || TYPES_CENTRIS['terrain']; }

// Parser les listings depuis HTML Centris
function parseCentrisHTML(html, ville, jours) {
  const cutoff  = new Date(Date.now() - jours * 86400000);
  const listings = [];
  const seen     = new Set();

  // Stratégie 1 — JSON-LD schema.org (le plus fiable)
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const d = JSON.parse(m[1]);
      const items = Array.isArray(d) ? d.flat() : [d];
      for (const item of items) {
        if (!item?.['@type']) continue;
        const id = item.identifier || item['@id'] || '';
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const prix = item.offers?.price ? parseInt(String(item.offers.price).replace(/[^\d]/g,'')) : null;
        const adresse = item.name || item.address?.streetAddress || '';
        const sup = item.floorSize?.value ? parseInt(item.floorSize.value) : null;
        const dateStr = item.dateModified || item.dateCreated || '';
        if (dateStr) { try { if (new Date(dateStr) < cutoff) continue; } catch {} }
        if (prix || adresse) listings.push({ mls:id, adresse, ville: item.address?.addressLocality || ville, prix, superficie: sup, dateVente: dateStr ? new Date(dateStr).toLocaleDateString('fr-CA') : '', dateISO: dateStr });
      }
    } catch {}
  }

  // Stratégie 2 — data-id + contexte HTML
  if (listings.length < 2) {
    for (const m of html.matchAll(/data-(?:id|mlsnumber|listing-id)="(\d{6,9})"/gi)) {
      const mls = m[1];
      if (seen.has(mls)) continue;
      seen.add(mls);
      const ctx   = html.substring(Math.max(0, m.index - 100), m.index + 1000);
      const priceM = ctx.match(/(\d{2,3}[\s\u00a0,]\d{3})\s*\$/);
      const prix   = priceM ? parseInt(priceM[1].replace(/[^\d]/g,'')) : null;
      const addrM  = ctx.match(/(?:address|adresse)[^>]{0,50}>([^<]{5,80})/i);
      listings.push({ mls, adresse: addrM?.[1]?.trim() || '', ville, prix, superficie:null, dateVente:'', dateISO:'' });
    }
  }

  return listings.slice(0, 30);
}

// Chercher les VENDUS sur Centris (avec session agent)
async function centrisSearchVendus(type, ville, jours) {
  const ti  = slugType(type);
  const vs  = slugVille(ville);
  const paths = [
    `/fr/${ti.slug}~${ti.genre}~${vs}?view=Vg==&uc=1`,
    `/fr/${ti.slug}~${ti.genre}~${vs}`,
    `/fr/${ti.slug}~vendu~${vs}?view=Vg==`,
    `/fr/${ti.slug}~vendue~${vs}?view=Vg==`,
  ];
  for (const p of paths) {
    try {
      const res = await centrisGet(p);
      if (!res.ok) continue;
      const html = await res.text();
      if (html.length < 1000) continue;
      const list = parseCentrisHTML(html, ville, jours);
      if (list.length) { log('OK', 'CENTRIS', `${list.length} vendus: ${p}`); return list; }
    } catch (e) { log('WARN', 'CENTRIS', `${p}: ${e.message}`); }
  }
  return [];
}

// Chercher les ACTIFS (en vigueur) sur Centris
async function centrisSearchActifs(type, ville) {
  const ti  = slugType(type);
  const vs  = slugVille(ville);
  const paths = [
    `/fr/${ti.slug}~a-vendre~${vs}?view=Vg==&uc=1`,
    `/fr/${ti.slug}~a-vendre~${vs}`,
  ];
  for (const p of paths) {
    try {
      const res = await centrisGet(p);
      if (!res.ok) continue;
      const html = await res.text();
      if (html.length < 1000) continue;
      const list = parseCentrisHTML(html, ville, 9999); // pas de filtre date pour actifs
      if (list.length) { log('OK', 'CENTRIS', `${list.length} actifs: ${p}`); return list; }
    } catch (e) { log('WARN', 'CENTRIS', `${p}: ${e.message}`); }
  }
  return [];
}

// Télécharger la fiche PDF d'un listing
async function centrisGetFiche(mls) {
  if (!mls) return null;
  const paths = [
    `/fr/listing/pdf/${mls}`,
    `/fr/pdf/listing/${mls}`,
    `/Fiche/${mls}.pdf`,
  ];
  for (const p of paths) {
    try {
      const res = await centrisGet(p);
      if (!res.ok) continue;
      const ct = res.headers.get('content-type') || '';
      if (!ct.includes('pdf') && !ct.includes('application/octet')) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 5000) { log('OK', 'CENTRIS', `Fiche PDF ${mls}: ${Math.round(buf.length/1024)}KB`); return { buffer: buf, filename: `Centris_${mls}.pdf` }; }
    } catch {}
  }
  return null;
}

// Détails complets d'un listing (données propriété)
async function centrisGetDetails(mls) {
  if (!mls) return {};
  try {
    const res = await centrisGet(`/fr/listing/${mls}`);
    if (!res.ok) return {};
    const html = await res.text();
    return {
      superficie: html.match(/(\d[\d\s,]*)\s*(?:pi²|pi2|sq\.?\s*ft)/i)?.[1]?.replace(/[^\d]/g,'') || null,
      dateVente:  html.match(/(?:vendu?e?|sold)\s*(?:le\s*)?:?\s*(\d{1,2}\s+\w+\s+\d{4})/i)?.[1] || null,
      prixVente:  html.match(/prix\s*(?:de\s*vente)?\s*:?\s*([\d\s,]+)\s*\$/i)?.[1]?.replace(/[^\d]/g,'') || null,
      chambres:   html.match(/(\d+)\s*chambre/i)?.[1] || null,
      sdb:        html.match(/(\d+)\s*salle?\s*(?:de\s*)?bain/i)?.[1] || null,
      annee:      html.match(/(?:année|ann[eé]e?\s+de\s+construction|built)\s*:?\s*(\d{4})/i)?.[1] || null,
    };
  } catch { return {}; }
}

// Fonction principale — chercher comparables (vendus OU actifs)
async function chercherComparablesVendus({ type = 'terrain', ville, jours = 14, statut = 'vendu' }) {
  if (!process.env.CENTRIS_USER) {
    return `❌ CENTRIS_USER/CENTRIS_PASS non configurés dans Render.\nAjouter les env vars CENTRIS_USER et CENTRIS_PASS (valeurs chez Shawn).`;
  }
  if (!ville) return '❌ Précise la ville: ex. "Sainte-Julienne", "Rawdon"';

  const listings = statut === 'actif'
    ? await centrisSearchActifs(type, ville)
    : await centrisSearchVendus(type, ville, jours);

  if (!listings.length) {
    return `Aucun résultat Centris pour "${type}" ${statut === 'actif' ? 'en vigueur' : 'vendu'} à "${ville}".\nEssaie: ${jours+7} jours, ou une ville voisine.`;
  }

  // Enrichir les 6 premiers avec détails complets
  const toEnrich = listings.slice(0, 6);
  const details  = await Promise.all(toEnrich.map(async (l, i) => {
    await new Promise(r => setTimeout(r, i * 300));
    return l.mls ? centrisGetDetails(l.mls) : {};
  }));
  toEnrich.forEach((l, i) => {
    const d = details[i];
    if (d.superficie && !l.superficie) l.superficie = parseInt(d.superficie);
    if (d.dateVente  && !l.dateVente)  l.dateVente  = d.dateVente;
    if (d.prixVente  && !l.prix)       l.prix       = parseInt(d.prixVente);
    if (d.annee) l.annee = d.annee;
  });

  return listings;
}

// Générer le HTML du rapport (style template Signature SB)
function genererRapportHTML(listings, { type, ville, jours, statut = 'vendu' }) {
  const modeLabel  = statut === 'actif' ? 'en vigueur' : 'vendus';
  const typeLabel  = type === 'terrain' ? 'Terrains' : type === 'maison' || type === 'maison_usagee' ? 'Maisons' : (type || 'Propriétés');
  const fmt        = n => n ? `${Number(n).toLocaleString('fr-CA')} $` : '—';
  const fmtSup     = n => n ? `${Number(n).toLocaleString('fr-CA')} pi²` : '—';
  const fmtPp      = (p,s) => (p && s && s > 100) ? `${(p/s).toFixed(2)} $/pi²` : '—';

  const avecPrix  = listings.filter(l => l.prix > 1000);
  const prixMoy   = avecPrix.length ? Math.round(avecPrix.reduce((s,l)=>s+l.prix,0)/avecPrix.length) : 0;
  const prixMin   = avecPrix.length ? Math.min(...avecPrix.map(l=>l.prix)) : 0;
  const prixMax   = avecPrix.length ? Math.max(...avecPrix.map(l=>l.prix)) : 0;
  const avecSup   = listings.filter(l => l.superficie > 100);
  const supMoy    = avecSup.length ? Math.round(avecSup.reduce((s,l)=>s+l.superficie,0)/avecSup.length) : 0;

  const statsBloc = `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0;">
<tr>
  <td width="25%" style="padding:4px;"><div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:14px 12px;">
    <div style="color:#aa0721;font-size:24px;font-weight:900;">${listings.length}</div>
    <div style="color:#666;font-size:11px;">${typeLabel} ${modeLabel}${statut==='vendu'?`<br>${jours} derniers jours`:''}</div>
  </div></td>
  <td width="25%" style="padding:4px;"><div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:14px 12px;">
    <div style="color:#aa0721;font-size:18px;font-weight:800;">${fmt(prixMoy)||'—'}</div>
    <div style="color:#666;font-size:11px;">${statut==='actif'?'Prix demandé moyen':'Prix vendu moyen'}</div>
  </div></td>
  <td width="25%" style="padding:4px;"><div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:14px 12px;">
    <div style="color:#f5f5f7;font-size:13px;">${fmt(prixMin)}</div>
    <div style="color:#666;font-size:10px;margin-bottom:6px;">min</div>
    <div style="color:#f5f5f7;font-size:13px;">${fmt(prixMax)}</div>
    <div style="color:#666;font-size:10px;">max</div>
  </div></td>
  ${supMoy ? `<td width="25%" style="padding:4px;"><div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;padding:14px 12px;">
    <div style="color:#aa0721;font-size:18px;font-weight:800;">${fmtSup(supMoy)}</div>
    <div style="color:#666;font-size:11px;">Superficie moy.</div>
  </div></td>` : '<td width="25%"></td>'}
</tr></table>`;

  const lignes = listings.map(l => `
<tr style="border-bottom:1px solid #1a1a1a;">
  <td style="padding:10px 12px;color:#f5f5f7;font-size:13px;vertical-align:top;">
    ${l.adresse || l.titre || 'N/D'}
    ${l.mls ? `<div style="color:#444;font-size:11px;margin-top:2px;">Centris #${l.mls}</div>` : ''}
    ${l.annee ? `<div style="color:#444;font-size:11px;">Année: ${l.annee}</div>` : ''}
  </td>
  <td style="padding:10px 12px;color:#aa0721;font-size:14px;font-weight:800;white-space:nowrap;">${fmt(l.prix)}</td>
  <td style="padding:10px 12px;color:#888;font-size:12px;white-space:nowrap;">${fmtSup(l.superficie)}</td>
  <td style="padding:10px 12px;color:#888;font-size:12px;white-space:nowrap;">${fmtPp(l.prix,l.superficie)}</td>
  <td style="padding:10px 12px;color:#555;font-size:11px;white-space:nowrap;">${l.dateVente || '—'}</td>
</tr>`).join('');

  const tableau = `
<div style="background:#111;border:1px solid #1e1e1e;border-radius:8px;overflow:hidden;margin-top:16px;">
  <div style="color:#aa0721;font-size:10px;font-weight:700;letter-spacing:2px;text-transform:uppercase;padding:12px 16px 10px;border-bottom:1px solid #1a1a1a;">
    ${typeLabel} ${modeLabel} · ${ville} · Source: Centris.ca (agent ${process.env.CENTRIS_USER||''})
  </div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
    <thead><tr style="background:#0d0d0d;">
      <th align="left" style="padding:8px 12px;color:#555;font-size:10px;letter-spacing:1px;">PROPRIÉTÉ</th>
      <th align="left" style="padding:8px 12px;color:#555;font-size:10px;letter-spacing:1px;">PRIX</th>
      <th align="left" style="padding:8px 12px;color:#555;font-size:10px;letter-spacing:1px;">SUPERFICIE</th>
      <th align="left" style="padding:8px 12px;color:#555;font-size:10px;letter-spacing:1px;">$/PI²</th>
      <th align="left" style="padding:8px 12px;color:#555;font-size:10px;letter-spacing:1px;">${statut==='actif'?'INSCRIT':'VENDU'}</th>
    </tr></thead>
    <tbody>${lignes}</tbody>
  </table>
</div>`;

  return statsBloc + tableau;
}

// Envoyer le rapport par email avec template Signature SB
async function envoyerRapportComparables({ type = 'terrain', ville, jours = 14, email, statut = 'vendu' }) {
  const dest       = email || AGENT.email;
  const modeLabel  = statut === 'actif' ? 'en vigueur' : 'vendus';
  const typeLabel  = type === 'terrain' ? 'Terrains' : type === 'maison' || type === 'maison_usagee' ? 'Maisons' : (type || 'Propriétés');
  const now        = new Date();
  const dateMois   = now.toLocaleDateString('fr-CA', { month:'long', year:'numeric', timeZone:'America/Toronto' });

  // 1. Chercher les données via Centris (agent authentifié)
  const result = await chercherComparablesVendus({ type, ville, jours, statut });
  if (typeof result === 'string') return result;
  const listings = result;

  // 2. HTML rapport
  const rapportHTML = genererRapportHTML(listings, { type, ville, jours, statut });

  // 3. Lire master template Dropbox
  const tplPath = `${AGENT.dbx_templates}/master_template_signature_sb.html`;
  let template  = null;
  try {
    const tplRes = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: tplPath.startsWith('/') ? tplPath : '/' + tplPath }, true);
    if (tplRes?.ok) template = await tplRes.text();
  } catch {}

  const sujet = `${typeLabel} ${modeLabel} — ${ville} — ${statut==='vendu'?jours+'j':dateMois} | ${AGENT.compagnie}`;

  let htmlFinal;
  if (template && template.length > 5000) {
    const fill = (tpl, params) => { let h = tpl; for (const [k,v] of Object.entries(params)) h = h.split(`{{ params.${k} }}`).join(v??''); return h; };
    const prixMoy = listings.filter(l=>l.prix>1000).length ? Math.round(listings.filter(l=>l.prix>1000).reduce((s,l)=>s+l.prix,0)/listings.filter(l=>l.prix>1000).length).toLocaleString('fr-CA')+' $' : 'N/D';
    htmlFinal = fill(template, {
      TITRE_EMAIL:         `${typeLabel} ${modeLabel} — ${ville}`,
      LABEL_SECTION:       `Centris.ca · ${ville} · ${dateMois}`,
      DATE_MOIS:           dateMois,
      TERRITOIRES:         ville,
      SOUS_TITRE_ANALYSE:  `${typeLabel} ${modeLabel} · ${dateMois}`,
      HERO_TITRE:          `${typeLabel} ${modeLabel}<br>à ${ville}.`,
      INTRO_TEXTE:         `<p style="margin:0 0 16px;color:#cccccc;font-size:14px;">${listings.length} ${typeLabel.toLowerCase()} ${modeLabel} à ${ville}${statut==='vendu'?' dans les '+jours+' derniers jours':''}. Source: Centris.ca — accès agent ${process.env.CENTRIS_USER||''}.</p>`,
      TITRE_SECTION_1:     `Résultats · ${ville} · ${dateMois}`,
      MARCHE_LABEL:        `${typeLabel} ${modeLabel}`,
      PRIX_MEDIAN:         prixMoy,
      VARIATION_PRIX:      `${listings.length} propriétés · Centris.ca`,
      SOURCE_STAT:         `Centris.ca · Accès agent · ${dateMois}`,
      LABEL_TABLEAU:       `Liste complète`,
      TABLEAU_STATS_HTML:  rapportHTML,
      TITRE_SECTION_2:     `Analyse`,
      CITATION:            `Ces données proviennent directement de Centris.ca via votre accès agent. Pour une analyse complète, contactez-moi.`,
      CONTENU_STRATEGIE:   '',
      CTA_TITRE:           `Questions sur le marché?`,
      CTA_SOUS_TITRE:      `Évaluation gratuite, sans engagement.`,
      CTA_URL:             `tel:${AGENT.telephone.replace(/[^\d]/g,'')}`,
      CTA_BOUTON:          `Appeler ${AGENT.prenom} — ${AGENT.telephone}`,
      CTA_NOTE:            `${AGENT.nom} · ${AGENT.compagnie}`,
      REFERENCE_URL:       `tel:${AGENT.telephone.replace(/[^\d]/g,'')}`,
      SOURCES:             `Centris.ca · Accès agent no ${process.env.CENTRIS_USER||''} · ${dateMois}`,
      DESINSCRIPTION_URL:  '',
    });
  } else {
    // Fallback HTML inline brandé
    htmlFinal = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:-apple-system,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:32px 16px;">
<table width="600" style="max-width:600px;background:#0a0a0a;color:#f5f5f7;">
<tr><td style="background:#aa0721;height:4px;font-size:1px;">&nbsp;</td></tr>
<tr><td style="padding:28px 32px 20px;">
  <div style="color:#aa0721;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;margin-bottom:16px;">${AGENT.nom} · ${AGENT.compagnie}</div>
  <h1 style="color:#f5f5f7;font-size:26px;margin:0 0 8px;">${typeLabel} ${modeLabel}<br>à ${ville}</h1>
  <p style="color:#666;font-size:12px;margin:0 0 24px;">Centris.ca · Accès agent · ${dateMois}</p>
  ${rapportHTML}
  <div style="margin-top:24px;padding-top:16px;border-top:1px solid #1e1e1e;color:#555;font-size:12px;">
    ${AGENT.nom} · ${AGENT.telephone} · ${AGENT.site}
  </div>
</td></tr>
</table></td></tr></table>
</body></html>`;
  }

  // 4. Envoyer via Gmail
  const token = await getGmailToken();
  if (!token) return `❌ Gmail non configuré.\nRapport prêt (${listings.length} propriétés) — configure Gmail dans Render.`;

  const boundary = `sb${Date.now()}`;
  const enc      = s => `=?UTF-8?B?${Buffer.from(s,'utf-8').toString('base64')}?=`;
  const plainTxt = `${typeLabel} ${modeLabel} — ${ville}\nSource: Centris.ca (agent ${process.env.CENTRIS_USER||''})\n\n${listings.map((l,i)=>`${i+1}. ${l.adresse||l.titre||'N/D'}${l.mls?' (#'+l.mls+')':''}${l.prix?' — '+Number(l.prix).toLocaleString('fr-CA')+' $':''}${l.superficie?' — '+Number(l.superficie).toLocaleString('fr-CA')+' pi²':''}${l.dateVente?' — '+l.dateVente:''}`).join('\n')}\n\n${AGENT.nom} · ${AGENT.telephone}`;

  const msgLines = [
    `From: ${AGENT.nom} · ${AGENT.compagnie} <${AGENT.email}>`,
    `To: ${dest}`,
    `Reply-To: ${AGENT.email}`,
    `Subject: ${enc(sujet)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    plainTxt,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(htmlFinal,'utf-8').toString('base64'),
    `--${boundary}--`,
  ];
  const raw = Buffer.from(msgLines.join('\r\n'),'utf-8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  await gmailAPI('/messages/send', { method:'POST', body: JSON.stringify({ raw }) });

  const prixMoyNum = listings.filter(l=>l.prix>1000);
  const pm = prixMoyNum.length ? Math.round(prixMoyNum.reduce((s,l)=>s+l.prix,0)/prixMoyNum.length).toLocaleString('fr-CA')+' $' : '';
  return `✅ *Rapport envoyé* à ${dest}\n\n📊 ${listings.length} ${typeLabel.toLowerCase()} ${modeLabel} — ${ville}${statut==='vendu'?' — '+jours+'j':''}\n${pm?'Prix moyen: '+pm+'\n':''}🏠 Source: Centris.ca (agent ${process.env.CENTRIS_USER||''})\n📧 Template Signature SB`;
}

// ─── Outils Claude ────────────────────────────────────────────────────────────
const TOOLS = [
  // ── Pipedrive ──
  { name: 'voir_pipeline',      description: 'Voir tous les deals actifs dans Pipedrive par étape. Pour "mon pipeline", "mes deals", "mes hot leads".', input_schema: { type: 'object', properties: {} } },
  { name: 'chercher_prospect',  description: 'Chercher un prospect dans Pipedrive. Retourne infos, stade, historique, notes. Utiliser AVANT de rédiger tout message.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom, email ou téléphone' } }, required: ['terme'] } },
  { name: 'marquer_perdu',      description: 'Marquer un deal comme perdu. Ex: "ça marche pas avec Jean", "cause perdue Tremblay".', input_schema: { type: 'object', properties: { terme: { type: 'string' } }, required: ['terme'] } },
  { name: 'ajouter_note',       description: 'Ajouter une note sur un prospect dans Pipedrive.', input_schema: { type: 'object', properties: { terme: { type: 'string' }, note: { type: 'string' } }, required: ['terme', 'note'] } },
  { name: 'stats_business',     description: 'Tableau de bord: pipeline par étape, performance du mois, taux de conversion.', input_schema: { type: 'object', properties: {} } },
  { name: 'creer_deal',         description: 'Créer un nouveau prospect/deal dans Pipedrive. Utiliser quand Shawn dit "nouveau prospect: [info]" ou reçoit un lead.', input_schema: { type: 'object', properties: { prenom: { type: 'string' }, nom: { type: 'string' }, telephone: { type: 'string' }, email: { type: 'string' }, type: { type: 'string', description: 'terrain, maison_usagee, maison_neuve, construction_neuve, auto_construction, plex' }, source: { type: 'string', description: 'centris, facebook, site_web, reference, appel' }, centris: { type: 'string', description: 'Numéro Centris si disponible' }, note: { type: 'string', description: 'Note initiale: besoin, secteur, budget, délai' } }, required: ['prenom'] } },
  { name: 'planifier_visite',   description: 'Planifier une visite de propriété. Met à jour le deal → Visite prévue + crée activité Pipedrive + sauvegarde pour rappel matin.', input_schema: { type: 'object', properties: { prospect: { type: 'string', description: 'Nom du prospect' }, date: { type: 'string', description: 'Date ISO (2024-05-10T14:00) ou approximation' }, adresse: { type: 'string', description: 'Adresse de la propriété (optionnel)' } }, required: ['prospect', 'date'] } },
  { name: 'voir_visites',      description: 'Voir les visites planifiées (aujourd\'hui + à venir). Pour "mes visites", "c\'est quoi aujourd\'hui".', input_schema: { type: 'object', properties: {} } },
  { name: 'changer_etape',          description: 'Changer l\'étape d\'un deal Pipedrive. Options: nouveau, contacté, discussion, visite prévue, visite faite, offre, gagné.', input_schema: { type: 'object', properties: { terme: { type: 'string' }, etape: { type: 'string' } }, required: ['terme', 'etape'] } },
  { name: 'voir_activites',         description: 'Voir les activités et tâches planifiées pour un deal. "c\'est quoi le prochain step avec Jean?"', input_schema: { type: 'object', properties: { terme: { type: 'string' } }, required: ['terme'] } },
  { name: 'voir_prospect_complet',  description: 'PREMIER outil à appeler pour tout prospect. Vue complète en un appel: stade pipeline, coordonnées (tel+email), toutes les notes, activités, dernier email Gmail, alerte si stagnant. Remplace chercher_prospect pour les analyses.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom, email ou téléphone du prospect' } }, required: ['terme'] } },
  { name: 'prospects_stagnants',    description: 'Liste des prospects sans aucune action depuis X jours (défaut: 3j). Pour "c\'est quoi qui stagne?", "qui j\'ai pas contacté?", "qu\'est-ce qui bouge pas?".', input_schema: { type: 'object', properties: { jours: { type: 'number', description: 'Nombre de jours (défaut: 3)' } } } },
  { name: 'historique_contact',     description: 'Timeline chronologique d\'un prospect: notes + activités triées. Compact pour mobile. Pour "c\'est quoi le background de Jean?", "show me the history for Marie".', input_schema: { type: 'object', properties: { terme: { type: 'string' } }, required: ['terme'] } },
  { name: 'repondre_vite',          description: 'Réponse rapide mobile: trouve l\'email du prospect dans Pipedrive AUTOMATIQUEMENT, prépare le brouillon style Shawn. Shawn dit juste son message, le bot fait le reste. Ne pas appeler si email déjà connu — utiliser envoyer_email directement.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom du prospect dans Pipedrive' }, message: { type: 'string', description: 'Texte de la réponse tel que dicté par Shawn' } }, required: ['terme', 'message'] } },
  { name: 'modifier_deal',          description: 'Modifier la valeur, le titre ou la date de clôture d\'un deal.', input_schema: { type: 'object', properties: { terme: { type: 'string' }, valeur: { type: 'number', description: 'Valeur en $ de la transaction' }, titre: { type: 'string' }, dateClose: { type: 'string', description: 'Date ISO YYYY-MM-DD' } }, required: ['terme'] } },
  { name: 'creer_activite',         description: 'Créer une activité/tâche/rappel pour un deal. Types: appel, email, réunion, tâche, visite.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom du prospect' }, type: { type: 'string', description: 'appel, email, réunion, tâche, visite' }, sujet: { type: 'string' }, date: { type: 'string', description: 'YYYY-MM-DD' }, heure: { type: 'string', description: 'HH:MM' } }, required: ['terme', 'type'] } },
  // ── Gmail ──
  { name: 'voir_emails_recents', description: 'Voir les emails récents de prospects dans Gmail inbox. Pour "qui a répondu", "nouveaux emails", "mes emails". Exclut les notifications automatiques.', input_schema: { type: 'object', properties: { depuis: { type: 'string', description: 'Période: "1d", "3d", "7d" (défaut: 1d)' } } } },
  { name: 'voir_conversation',   description: 'Voir la conversation Gmail complète avec un prospect (reçus + envoyés, 30 jours). Utiliser AVANT de rédiger un suivi pour avoir tout le contexte.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom, prénom ou email du prospect' } }, required: ['terme'] } },
  { name: 'envoyer_email',       description: 'Préparer un brouillon email pour approbation de Shawn. Affiche le brouillon complet — il N\'EST PAS envoyé tant que Shawn ne confirme pas avec "envoie", "go", "ok", "parfait", "d\'accord", etc.', input_schema: { type: 'object', properties: { to: { type: 'string', description: 'Adresse email du destinataire' }, toName: { type: 'string', description: 'Nom du destinataire' }, sujet: { type: 'string', description: 'Objet de l\'email' }, texte: { type: 'string', description: 'Corps de l\'email — texte brut, style Shawn, vouvoiement, max 3 paragraphes courts.' } }, required: ['to', 'sujet', 'texte'] } },
  // ── Centris — Comparables + En vigueur ──
  { name: 'chercher_comparables',         description: 'Chercher propriétés VENDUES sur Centris.ca via accès agent (code 110509). Pour "comparables terrains Sainte-Julienne 14 jours", "maisons vendues Rawdon". Retourne prix, superficie, $/pi², date vendue.', input_schema: { type: 'object', properties: { type: { type: 'string', description: 'terrain, maison, plex, condo (défaut: terrain)' }, ville: { type: 'string', description: 'Ville: Sainte-Julienne, Rawdon, Chertsey, etc.' }, jours: { type: 'number', description: 'Jours en arrière (défaut: 14)' } }, required: ['ville'] } },
  { name: 'proprietes_en_vigueur',        description: 'Chercher propriétés ACTIVES à vendre sur Centris.ca via accès agent. Pour "terrains actifs Sainte-Julienne", "maisons à vendre Rawdon en ce moment". Listings actuels avec prix demandé.', input_schema: { type: 'object', properties: { type: { type: 'string', description: 'terrain, maison, plex (défaut: terrain)' }, ville: { type: 'string', description: 'Ville' } }, required: ['ville'] } },
  { name: 'envoyer_rapport_comparables',  description: 'Chercher sur Centris.ca (agent authentifié) ET envoyer par email avec template Signature SB (logos officiels). Pour "envoie les terrains vendus Sainte-Julienne à [email]". statut: vendu (défaut) ou actif.', input_schema: { type: 'object', properties: { type: { type: 'string', description: 'terrain, maison, plex' }, ville: { type: 'string', description: 'Ville' }, jours: { type: 'number', description: 'Jours (défaut: 14)' }, email: { type: 'string', description: 'Email destination (obligatoire)' }, statut: { type: 'string', description: '"vendu" ou "actif"' } }, required: ['ville', 'email'] } },
  // ── Recherche web ──
  { name: 'rechercher_web',  description: 'Rechercher infos actuelles: taux hypothécaires, stats marché QC, prix construction, réglementations. Enrichit les emails avec données récentes.', input_schema: { type: 'object', properties: { requete: { type: 'string', description: 'Requête précise. Ex: "taux hypothécaire 5 ans fixe Desjardins avril 2025"' } }, required: ['requete'] } },
  // ── GitHub ──
  { name: 'list_github_repos',  description: 'Liste les repos GitHub de Shawn (signaturesb)', input_schema: { type: 'object', properties: {} } },
  { name: 'list_github_files',  description: 'Liste les fichiers dans un dossier d\'un repo GitHub', input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string', description: 'Sous-dossier (vide = racine)' } }, required: ['repo'] } },
  { name: 'read_github_file',   description: 'Lit le contenu d\'un fichier dans un repo GitHub', input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' } }, required: ['repo', 'path'] } },
  { name: 'write_github_file',  description: 'Écrit ou modifie un fichier GitHub (commit direct)', input_schema: { type: 'object', properties: { repo: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' }, message: { type: 'string' } }, required: ['repo', 'path', 'content'] } },
  // ── Dropbox ──
  { name: 'list_dropbox_folder', description: 'Liste les fichiers dans un dossier Dropbox (documents propriétés, terrains)', input_schema: { type: 'object', properties: { path: { type: 'string', description: 'Chemin ("Terrain en ligne" ou "" pour racine)' } }, required: ['path'] } },
  { name: 'read_dropbox_file',   description: 'Lit un fichier texte depuis Dropbox', input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'send_dropbox_file',   description: 'Télécharge un PDF/image depuis Dropbox et l\'envoie à Shawn par Telegram', input_schema: { type: 'object', properties: { path: { type: 'string' }, caption: { type: 'string' } }, required: ['path'] } },
  // ── Contacts ──
  { name: 'chercher_contact',  description: 'Chercher dans les contacts iPhone de Shawn (Dropbox /Contacts/contacts.vcf). Trouver tel cell et email perso avant tout suivi. Complète Pipedrive.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom, prénom ou numéro de téléphone' } }, required: ['terme'] } },
  // ── Brevo ──
  { name: 'ajouter_brevo',  description: 'Ajouter/mettre à jour un contact dans Brevo. Utiliser quand deal perdu → nurture mensuel, ou nouveau contact à ajouter.', input_schema: { type: 'object', properties: { email: { type: 'string' }, prenom: { type: 'string' }, nom: { type: 'string' }, telephone: { type: 'string' }, liste: { type: 'string', description: 'prospects, acheteurs, vendeurs (défaut: prospects)' } }, required: ['email'] } },
  // ── Fichiers bot ──
  { name: 'read_bot_file',   description: 'Lit un fichier de configuration dans /data/botfiles/', input_schema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] } },
  { name: 'write_bot_file',  description: 'Modifie ou crée un fichier de configuration dans /data/botfiles/', input_schema: { type: 'object', properties: { filename: { type: 'string' }, content: { type: 'string' } }, required: ['filename', 'content'] } },
  // ── Listings Dropbox + envoi docs ──
  { name: 'chercher_listing_dropbox', description: 'Chercher un dossier listing dans Dropbox (/Terrain en ligne/) par ville, adresse ou numéro Centris. Utilise le cache — résultat instantané. Liste PDFs + photos de chaque dossier trouvé.', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Ville (ex: "Rawdon"), adresse partielle ou numéro Centris (7-9 chiffres)' } }, required: ['terme'] } },
  { name: 'envoyer_docs_prospect',   description: 'Flow COMPLET: trouve dossier Dropbox par Centris (dans Pipedrive) → télécharge PDF → envoie par Gmail avec pièce jointe → note Pipedrive. Utiliser quand Shawn dit "envoie les docs à [nom]".', input_schema: { type: 'object', properties: { terme: { type: 'string', description: 'Nom du prospect dans Pipedrive' }, email: { type: 'string', description: 'Email destination si différent de Pipedrive' }, fichier: { type: 'string', description: 'Nom partiel du PDF spécifique (optionnel — premier PDF par défaut)' } }, required: ['terme'] } },
  // ── Sync Claude Code ↔ Bot ──
  { name: 'refresh_contexte_session', description: 'Recharger SESSION_LIVE.md depuis GitHub (sync Claude Code ↔ bot). Utiliser quand Shawn mentionne "tu sais pas ça" ou après qu\'il a travaillé dans Claude Code sur son Mac.', input_schema: { type: 'object', properties: {} } },
  // ── Diagnostics ──
  { name: 'tester_dropbox',  description: 'Tester la connexion Dropbox et diagnostiquer les problèmes de tokens. Utiliser quand Dropbox semble brisé.', input_schema: { type: 'object', properties: {} } },
  { name: 'voir_template_dropbox', description: 'Lire les informations du master template email depuis Dropbox. Pour vérifier les placeholders disponibles.', input_schema: { type: 'object', properties: {} }, cache_control: { type: 'ephemeral' } }
];

// Cache les tools (statiques) — réduit coût API
const TOOLS_WITH_CACHE = TOOLS;

async function executeTool(name, input, chatId) {
  try {
    switch (name) {
      case 'voir_pipeline':        return await getPipeline();
      case 'chercher_prospect':    return await chercherProspect(input.terme);
      case 'marquer_perdu':        return await marquerPerdu(input.terme);
      case 'ajouter_note':         return await ajouterNote(input.terme, input.note);
      case 'stats_business':       return await statsBusiness();
      case 'creer_deal':           return await creerDeal(input);
      case 'planifier_visite':     return await planifierVisite(input);
      case 'voir_visites': {
        const visites = loadJSON(VISITES_FILE, []);
        if (!visites.length) return '📅 Aucune visite planifiée.';
        const now = Date.now();
        const futures = visites.filter(v => new Date(v.date).getTime() > now - 3600000); // +1h passée
        if (!futures.length) return '📅 Aucune visite à venir (toutes passées).';
        const today = new Date().toDateString();
        let txt = `📅 *Visites planifiées — ${futures.length} total*\n\n`;
        for (const v of futures.sort((a, b) => new Date(a.date) - new Date(b.date))) {
          const d   = new Date(v.date);
          const isToday = d.toDateString() === today;
          const dateStr = d.toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Toronto' });
          const timeStr = d.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
          txt += `${isToday ? '🔴 AUJOURD\'HUI' : '📆'} *${v.nom}*\n${dateStr} à ${timeStr}${v.adresse ? '\n📍 ' + v.adresse : ''}\n\n`;
        }
        return txt.trim();
      }
      case 'changer_etape':           return await changerEtape(input.terme, input.etape);
      case 'voir_activites':          return await voirActivitesDeal(input.terme);
      case 'voir_prospect_complet':   return await voirProspectComplet(input.terme);
      case 'prospects_stagnants':     return await prospectStagnants(input.jours || 3);
      case 'historique_contact':      return await historiqueContact(input.terme);
      case 'repondre_vite':           return await repondreVite(chatId, input.terme, input.message);
      case 'modifier_deal':           return await modifierDeal(input.terme, input);
      case 'creer_activite':          return await creerActivite(input);
      case 'chercher_comparables': {
        const res = await chercherComparablesVendus({ type: input.type || 'terrain', ville: input.ville, jours: input.jours || 14 });
        if (typeof res === 'string') return res;
        const listings = res;
        const fmt = n => n ? `${Number(n).toLocaleString('fr-CA')} $` : '—';
        const fmtS = n => n ? `${Number(n).toLocaleString('fr-CA')} pi²` : '—';
        const fmtPp = (p,s) => (p&&s&&s>100) ? `${(p/s).toFixed(2)} $/pi²` : '—';
        const avecPrix = listings.filter(l=>l.prix>1000);
        const prixMoy = avecPrix.length ? Math.round(avecPrix.reduce((s,l)=>s+l.prix,0)/avecPrix.length) : 0;
        let txt = `📊 *${listings.length} ${input.type||'terrain'}(s) vendus — ${input.ville} — ${input.jours||14}j*\n`;
        if (prixMoy) txt += `Prix moyen: *${fmt(prixMoy)}*\n`;
        txt += '\n';
        listings.slice(0,12).forEach((l,i) => {
          txt += `${i+1}. ${l.adresse||'Adresse N/D'}${l.mls?' (#'+l.mls+')':''}\n`;
          txt += `   ${fmt(l.prix)} · ${fmtS(l.superficie)} · ${fmtPp(l.prix,l.superficie)}${l.dateVente?' · '+l.dateVente:''}\n`;
        });
        txt += `\n_Source: Pipedrive (deals gagnés)_`;
        if (listings.length > 12) txt += ` · _+ ${listings.length-12} autres — dis "envoie rapport" pour tout par email._`;
        else txt += ` · _Dis "envoie rapport" pour recevoir par email avec template Signature SB._`;
        return txt;
      }
      case 'proprietes_en_vigueur': {
        const res = await chercherComparablesVendus({ type: input.type || 'terrain', ville: input.ville, jours: 9999, statut: 'actif' });
        if (typeof res === 'string') return res;
        const fmt = n => n ? `${Number(n).toLocaleString('fr-CA')} $` : '—';
        const fmtS = n => n ? `${Number(n).toLocaleString('fr-CA')} pi²` : '—';
        let txt = `🏡 *${res.length} ${input.type||'terrain'}(s) en vigueur — ${input.ville}*\nSource: Centris.ca (agent ${process.env.CENTRIS_USER||''})\n\n`;
        res.slice(0,15).forEach((l,i) => {
          txt += `${i+1}. ${l.adresse||'N/D'}${l.mls?' (#'+l.mls+')':''}\n   ${fmt(l.prix)} · ${fmtS(l.superficie)}\n`;
        });
        if (res.length > 15) txt += `\n_+ ${res.length-15} autres — dis "envoie rapport actifs ${input.ville}" pour tout par email._`;
        return txt;
      }
      case 'envoyer_rapport_comparables': return await envoyerRapportComparables({ type: input.type || 'terrain', ville: input.ville, jours: input.jours || 14, email: input.email, statut: input.statut || 'vendu' });
      case 'chercher_listing_dropbox': return await chercherListingDropbox(input.terme);
      case 'envoyer_docs_prospect':    return await envoyerDocsProspect(input.terme, input.email, input.fichier);
      case 'voir_emails_recents':  return await voirEmailsRecents(input.depuis || '1d');
      case 'voir_conversation':    return await voirConversation(input.terme);
      case 'envoyer_email': {
        // Stocker le brouillon — ne PAS envoyer encore
        pendingEmails.set(chatId, { to: input.to, toName: input.toName, sujet: input.sujet, texte: input.texte });
        return `📧 *BROUILLON EMAIL — EN ATTENTE D'APPROBATION*\n\n*À:* ${input.toName ? input.toName + ' <' + input.to + '>' : input.to}\n*Objet:* ${input.sujet}\n\n---\n${input.texte}\n---\n\n💬 Dis *"envoie"* pour confirmer, ou modifie ce que tu veux.`;
      }
      case 'rechercher_web':       return await rechercherWeb(input.requete);
      case 'list_github_repos':    return await listGitHubRepos();
      case 'list_github_files':    return await listGitHubFiles(input.repo, input.path || '');
      case 'read_github_file':     return await readGitHubFile(input.repo, input.path);
      case 'write_github_file':    return await writeGitHubFile(input.repo, input.path, input.content, input.message);
      case 'chercher_contact':     return await chercherContact(input.terme);
      case 'ajouter_brevo':        return await ajouterBrevo(input);
      case 'list_dropbox_folder':  return await listDropboxFolder(input.path);
      case 'read_dropbox_file':    return await readDropboxFile(input.path);
      case 'send_dropbox_file': {
        const file = await downloadDropboxFile(input.path);
        if (!file) return `Erreur: impossible de télécharger ${input.path}`;
        await bot.sendDocument(chatId, file.buffer, { caption: input.caption || '' }, { filename: file.filename });
        return `✅ Fichier "${file.filename}" envoyé.`;
      }
      case 'read_bot_file': {
        const dir = path.join(DATA_DIR, 'botfiles');
        const fp  = path.join(dir, path.basename(input.filename));
        if (!fs.existsSync(fp)) return `Fichier introuvable: ${input.filename}`;
        const content = fs.readFileSync(fp, 'utf8');
        return content.length > 8000 ? content.substring(0, 8000) + '\n...[tronqué]' : content;
      }
      case 'write_bot_file': {
        const dir = path.join(DATA_DIR, 'botfiles');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, path.basename(input.filename)), input.content, 'utf8');
        return `✅ "${input.filename}" sauvegardé.`;
      }
      case 'refresh_contexte_session': {
        await loadSessionLiveContext();
        return sessionLiveContext
          ? `✅ *Session rechargée* — ${Math.round(sessionLiveContext.length/1024)}KB\n\n*Contexte actuel:*\n${sessionLiveContext.substring(0, 400)}...`
          : '⚠️ SESSION_LIVE.md vide ou inaccessible.';
      }
      case 'tester_dropbox': {
        const vars = {
          ACCESS_TOKEN: process.env.DROPBOX_ACCESS_TOKEN ? `✅ présent (${process.env.DROPBOX_ACCESS_TOKEN.substring(0,8)}...)` : '❌ absent',
          REFRESH_TOKEN: process.env.DROPBOX_REFRESH_TOKEN ? '✅ présent' : '❌ absent',
          APP_KEY:       process.env.DROPBOX_APP_KEY ? '✅ présent' : '❌ absent',
          APP_SECRET:    process.env.DROPBOX_APP_SECRET ? '✅ présent' : '❌ absent',
        };
        const tokenStatus = dropboxToken ? `✅ token actif (${dropboxToken.substring(0,8)}...)` : '❌ token absent en mémoire';
        let diagMsg = `🔍 *Diagnostic Dropbox*\n\nToken en mémoire: ${tokenStatus}\n\nEnv vars Render:\n`;
        for (const [k, v] of Object.entries(vars)) diagMsg += `• DROPBOX_${k}: ${v}\n`;
        // Tenter un refresh
        const ok = await refreshDropboxToken();
        diagMsg += `\nRefresh token: ${ok ? '✅ Succès' : '❌ Échec'}\n`;
        if (ok) {
          // Tester un vrai appel
          const testRes = await dropboxAPI('https://api.dropboxapi.com/2/files/list_folder', { path: '', recursive: false });
          if (testRes?.ok) {
            const data = await testRes.json();
            diagMsg += `Connexion API: ✅ OK — ${data.entries?.length || 0} éléments à la racine`;
          } else {
            diagMsg += `Connexion API: ❌ HTTP ${testRes?.status || 'timeout'}`;
          }
        } else {
          diagMsg += `\n⚠️ Vérifier dans Render: DROPBOX_APP_KEY, DROPBOX_APP_SECRET, DROPBOX_REFRESH_TOKEN`;
        }
        return diagMsg;
      }
      case 'voir_template_dropbox': {
        const tplPath = '/Liste de contact/email_templates/master_template_signature_sb.html';
        const res = await dropboxAPI('https://content.dropboxapi.com/2/files/download', { path: tplPath }, true);
        if (!res || !res.ok) return `❌ Template introuvable: ${tplPath}\nVérifier Dropbox avec tester_dropbox.`;
        const html = await res.text();
        const placeholders = [...html.matchAll(/\{\{\s*params\.(\w+)\s*\}\}/g)].map(m => m[1]);
        const unique = [...new Set(placeholders)];
        const size = Math.round(html.length / 1024);
        return `✅ *Master Template trouvé*\n\nTaille: ${size} KB\nPlaceholders {{ params.X }}: ${unique.length}\n\n${unique.map(p => `• ${p}`).join('\n')}\n\nLogos base64: ${html.includes('data:image/png;base64') ? '✅ présents' : '⚠️ absents'}`;
      }
      default: return `Outil inconnu: ${name}`;
    }
  } catch (err) {
    return `Erreur outil ${name}: ${err.message}`;
  }
}

// ─── Helper: exécuter un outil avec timeout 30s ───────────────────────────────
async function executeToolSafe(name, input, chatId) {
  return Promise.race([
    executeTool(name, input, chatId),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Timeout outil ${name}`)), 30000))
  ]);
}

// ─── Rate limiting anti-abuse sur webhooks (par IP + route) ──────────────────
const webhookRateMap = new Map(); // "ip:url" → [timestamps recent]
function webhookRateOK(ip, url, maxPerMin = 20) {
  const key = `${ip}:${url}`;
  const now = Date.now();
  const window = 60 * 1000;
  let hits = webhookRateMap.get(key) || [];
  hits = hits.filter(t => now - t < window);
  if (hits.length >= maxPerMin) return false;
  hits.push(now);
  webhookRateMap.set(key, hits);
  // Purge périodique
  if (webhookRateMap.size > 500) {
    for (const [k, arr] of webhookRateMap) if (!arr.some(t => now - t < window)) webhookRateMap.delete(k);
  }
  return true;
}

// ─── Audit log persistant — actions sensibles tracées ────────────────────────
// Stocke dans Gist (survit aux redeploys) les actions: deploys, env changes,
// auth failures, key usage. Shawn peut consulter via /audit.
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
let auditLog = loadJSON(AUDIT_FILE, []);
function auditLogEvent(category, event, details = {}) {
  auditLog.push({ at: new Date().toISOString(), category, event, details });
  if (auditLog.length > 200) auditLog = auditLog.slice(-200);
  saveJSON(AUDIT_FILE, auditLog);
  log('INFO', 'AUDIT', `${category}/${event} ${JSON.stringify(details).substring(0, 100)}`);
}

// ─── Cost tracking Anthropic ─────────────────────────────────────────────────
// Prix par million tokens (2026 pricing Anthropic)
const PRICING = {
  'claude-opus-4-7':    { in: 15.00, out: 75.00, cache_read: 1.50,  cache_write: 18.75 },
  'claude-sonnet-4-6':  { in:  3.00, out: 15.00, cache_read: 0.30,  cache_write:  3.75 },
  'claude-haiku-4-5':   { in:  1.00, out:  5.00, cache_read: 0.10,  cache_write:  1.25 },
};
const COST_FILE = path.join(DATA_DIR, 'cost_tracker.json');
let costTracker = loadJSON(COST_FILE, { daily: {}, monthly: {}, total: 0, byModel: {}, alertsSent: {} });
function today() { return new Date().toISOString().slice(0, 10); }
function thisMonth() { return new Date().toISOString().slice(0, 7); }
function trackCost(model, usage) {
  if (!usage) return;
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  const inp = (usage.input_tokens || 0) / 1e6 * p.in;
  const out = (usage.output_tokens || 0) / 1e6 * p.out;
  const cacheRead  = (usage.cache_read_input_tokens  || 0) / 1e6 * p.cache_read;
  const cacheWrite = (usage.cache_creation_input_tokens || 0) / 1e6 * p.cache_write;
  const cost = inp + out + cacheRead + cacheWrite;
  const d = today(), m = thisMonth();
  costTracker.daily[d]   = (costTracker.daily[d]   || 0) + cost;
  costTracker.monthly[m] = (costTracker.monthly[m] || 0) + cost;
  costTracker.total += cost;
  costTracker.byModel[model] = (costTracker.byModel[model] || 0) + cost;
  // Purge daily >30j, monthly >12m
  const cutoffDay = new Date(Date.now() - 30*86400000).toISOString().slice(0,10);
  Object.keys(costTracker.daily).forEach(k => { if (k < cutoffDay) delete costTracker.daily[k]; });
  saveJSON(COST_FILE, costTracker);
  // Alertes seuils (anti-runaway)
  const todayCost = costTracker.daily[d];
  const monthCost = costTracker.monthly[m];
  if (todayCost > 10 && !costTracker.alertsSent[`d${d}-10`]) {
    costTracker.alertsSent[`d${d}-10`] = true;
    saveJSON(COST_FILE, costTracker);
    if (ALLOWED_ID) bot.sendMessage(ALLOWED_ID, `💰 *Coût Anthropic aujourd'hui: $${todayCost.toFixed(2)}*\nSeuil 10$/jour atteint. Mois: $${monthCost.toFixed(2)}.`, { parse_mode: 'Markdown' }).catch(()=>{});
  }
  if (monthCost > 100 && !costTracker.alertsSent[`m${m}-100`]) {
    costTracker.alertsSent[`m${m}-100`] = true;
    saveJSON(COST_FILE, costTracker);
    if (ALLOWED_ID) bot.sendMessage(ALLOWED_ID, `💰 *Anthropic mois: $${monthCost.toFixed(2)}*\nSeuil 100$/mois atteint. Vérifier usage dans /cout.`, { parse_mode: 'Markdown' }).catch(()=>{});
  }
}

// ─── Routing auto modèle selon type de tâche ─────────────────────────────────
// Sonnet 4.6 par défaut (5x moins cher), switch Opus 4.7 auto sur mots-clés
// qui indiquent recherche/analyse/stratégie/négociation/optimisation.
// Shawn peut toujours forcer via /opus ou /sonnet ou /haiku.
const OPUS_TRIGGERS = /\b(analys|optim|recherch|strat[eé]g|compar|[eé]val|n[eé]goci|estim|march[eé]\s+(?:immo|actuel)|rapport\s+(?:march[eé]|vente|pro)|plan\s+d['e]action|pr[eé]vis|penser|think|r[eé]fl[eé]ch|deep\s+dive|pourquoi|analys(?:e|er)\s+ce|regarde\s+(?:en\s+)?d[eé]tail|(?:quel|combien|calcul).*prix|prix\s+(?:du?\s*march|de\s+vente|[àa]\s+mettre|demand|conseil|juste)|conseil\s+prix)/i;
const MODEL_DEFAULT = 'claude-sonnet-4-6';
function pickModelForMessage(userMsg) {
  // Shawn a explicitement forcé un modèle non-default (/opus ou /haiku) → respecter
  if (currentModel !== MODEL_DEFAULT) return currentModel;
  // Env var MODEL définie → respecter
  if (process.env.MODEL) return currentModel;
  // Thinking mode activé → toujours Opus (deep reasoning)
  if (thinkingMode) return 'claude-opus-4-7';
  // Mot-clé complexité/stratégie/analyse détecté → Opus pour CE message uniquement
  if (OPUS_TRIGGERS.test(userMsg || '')) {
    log('INFO', 'ROUTER', `Complexité détectée → Opus 4.7 pour cette requête`);
    return 'claude-opus-4-7';
  }
  // Défaut: Sonnet (envoi docs, emails, deals, conversation — 5x moins cher)
  return MODEL_DEFAULT;
}

// ─── Appel Claude (boucle agentique, prompt caching, routing auto modèle) ────
async function callClaude(chatId, userMsg, retries = 3) {
  if (!checkRateLimit()) {
    const err = new Error('Rate limit local atteint — 15 req/min'); err.status = 429;
    throw err;
  }
  circuitCheck('claude');
  mTick('messages', 'text');

  const msgIndex = getHistory(chatId).length;
  addMsg(chatId, 'user', userMsg);
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const localModel    = pickModelForMessage(userMsg);
      const localThinking = thinkingMode;
      // Validation: garantit premier=user, alternance, dernier=user
      let messages = validateMessagesForAPI(
        getHistory(chatId).map(m => ({ role: m.role, content: m.content }))
      );
      if (!messages.length) {
        log('WARN', 'CLAUDE', 'Messages vides après validation — reset historique');
        chats.delete(chatId);
        addMsg(chatId, 'user', userMsg);
        messages = [{ role: 'user', content: userMsg }];
      }
      let finalReply = null;
      let allMemos   = [];
      for (let round = 0; round < 12; round++) {
        const systemBlocks = [{ type: 'text', text: SYSTEM_BASE, cache_control: { type: 'ephemeral' } }];
        const dyn = getSystemDynamic();
        if (dyn) systemBlocks.push({ type: 'text', text: dyn });
        const params = {
          model: localModel, max_tokens: 16384,
          system: systemBlocks,
          tools: TOOLS_WITH_CACHE, messages,
        };
        if (localThinking) params.thinking = { type: 'enabled', budget_tokens: 10000 };
        mTick('api', 'claude');
        const res = await claude.messages.create(params);
        circuitSuccess('claude');
        trackCost(localModel, res.usage);
        if (res.stop_reason === 'tool_use') {
          messages.push({ role: 'assistant', content: res.content });
          const toolBlocks = res.content.filter(b => b.type === 'tool_use');
          const results = await Promise.all(toolBlocks.map(async b => {
            log('INFO', 'TOOL', `${b.name}(${JSON.stringify(b.input).substring(0, 80)})`);
            mTick('tools', b.name);
            const result = await executeToolSafe(b.name, b.input, chatId);
            return { type: 'tool_result', tool_use_id: b.id, content: String(result) };
          }));
          messages.push({ role: 'user', content: results });
          continue;
        }
        const text = res.content.find(b => b.type === 'text')?.text;
        if (!text) { log('WARN', 'CLAUDE', `round ${round}: réponse sans bloc texte (stop=${res.stop_reason})`); }
        const { cleaned, memos } = extractMemos(text || '_(vide)_');
        finalReply = cleaned;
        allMemos   = memos;
        break;
      }
      if (!finalReply) finalReply = '_(délai dépassé — réessaie)_';
      addMsg(chatId, 'assistant', finalReply);
      return { reply: finalReply, memos: allMemos };
    } catch (err) {
      log('ERR', 'CLAUDE', `attempt ${attempt}: HTTP ${err.status || '?'} — ${err.message?.substring(0, 120)}`);
      metrics.errors.total++;
      metrics.errors.byStatus[err.status || 'unknown'] = (metrics.errors.byStatus[err.status || 'unknown'] || 0) + 1;
      // Capturer dernier message d'erreur pour diagnostic (/health)
      metrics.lastApiError = {
        at: new Date().toISOString(),
        status: err.status || null,
        message: (err.message || String(err)).substring(0, 300),
      };
      // Circuit breaker: seulement sur erreurs transient (500+/429), pas sur 400 (user error)
      if (err.status === 429 || err.status === 529 || err.status >= 500) circuitFail('claude');

      // 400 = erreur structurelle (NON retryable) → nettoyer et abandonner
      if (err.status === 400) {
        const msg = err.message || '';
        // Cas spécifique: thinking incompatible → désactiver et retry 1 fois
        if (thinkingMode && msg.toLowerCase().includes('thinking') && attempt < retries) {
          log('WARN', 'CLAUDE', 'Thinking incompatible — retry sans thinking');
          thinkingMode = false;
          await new Promise(r => setTimeout(r, 500));
          continue;
        }
        // Cas "prefilling" / "prepend" / conversation corrompue → reset
        if (msg.toLowerCase().match(/prefill|prepend|assistant.*pre|first.*user|role/)) {
          log('WARN', 'CLAUDE', 'Historique corrompu — reset automatique');
          chats.delete(chatId);
          scheduleHistSave();
        }
        // Rollback et abandonner (pas de retry 400)
        const h = getHistory(chatId);
        if (h.length > msgIndex && h[msgIndex]?.role === 'user') h.splice(msgIndex, 1);
        scheduleHistSave();
        throw err;
      }

      const retryable = err.status === 429 || err.status === 529 || err.status >= 500;
      if (retryable && attempt < retries) {
        // Backoff exponentiel pour 429 (plus long)
        const delay = err.status === 429 ? attempt * 8000 : attempt * 3000;
        log('INFO', 'CLAUDE', `Retry ${attempt}/${retries} dans ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        const h = getHistory(chatId);
        if (h.length > msgIndex && h[msgIndex]?.role === 'user') h.splice(msgIndex, 1);
        scheduleHistSave();
        throw err;
      }
    }
  }
}

// ─── Appel Claude direct (vision/multimodal — sans historique alourdi) ────────
async function callClaudeVision(chatId, content, contextLabel) {
  // Rate limiter
  if (!checkRateLimit()) {
    const err = new Error('Rate limit local atteint'); err.status = 429;
    throw err;
  }

  const h = getHistory(chatId);
  h.push({ role: 'user', content });
  if (h.length > MAX_HIST) h.splice(0, h.length - MAX_HIST);

  try {
    // Validation des messages avant l'envoi
    let messages = validateMessagesForAPI(h.map(m => ({ role: m.role, content: m.content })));
    if (!messages.length) {
      // Fallback: envoyer juste l'image/doc sans historique
      messages = [{ role: 'user', content }];
    }
    const localModel    = currentModel;
    const localThinking = thinkingMode;
    const systemBlocks  = [{ type: 'text', text: SYSTEM_BASE, cache_control: { type: 'ephemeral' } }];
    const dyn = getSystemDynamic();
    if (dyn) systemBlocks.push({ type: 'text', text: dyn });
    const params = {
      model: localModel, max_tokens: 16384,
      system: systemBlocks,
      tools: TOOLS_WITH_CACHE, messages,
    };
    if (localThinking) params.thinking = { type: 'enabled', budget_tokens: 10000 };

    let finalReply = null;
    let allMemos   = [];
    for (let round = 0; round < 6; round++) {
      const res = await claude.messages.create(params);
      if (res.stop_reason === 'tool_use') {
        messages.push({ role: 'assistant', content: res.content });
        const toolBlocks = res.content.filter(b => b.type === 'tool_use');
        const results = await Promise.all(toolBlocks.map(async b => {
          log('INFO', 'TOOL', `vision:${b.name}(${JSON.stringify(b.input).substring(0, 60)})`);
          const result = await executeToolSafe(b.name, b.input, chatId);
          return { type: 'tool_result', tool_use_id: b.id, content: String(result) };
        }));
        messages.push({ role: 'user', content: results });
        continue;
      }
      const text = res.content.find(b => b.type === 'text')?.text || '_(vide)_';
      const { cleaned, memos } = extractMemos(text);
      finalReply = cleaned;
      allMemos   = memos;
      break;
    }
    finalReply = finalReply || '_(délai dépassé)_';

    // Remplacer le contenu multimodal dans l'historique par un placeholder compact
    h[h.length - 1] = { role: 'user', content: contextLabel };
    h.push({ role: 'assistant', content: finalReply });
    if (h.length > MAX_HIST) h.splice(0, h.length - MAX_HIST);
    scheduleHistSave();

    return { reply: finalReply, memos: allMemos };
  } catch (err) {
    // Rollback — retirer l'entrée image/PDF ajoutée
    if (h[h.length - 1]?.role === 'user') h.pop();
    // Si 400 lié à historique → reset complet
    if (err.status === 400 && (err.message || '').toLowerCase().match(/prefill|prepend|assistant.*pre|first.*user|role/)) {
      log('WARN', 'VISION', 'Historique corrompu — reset');
      chats.delete(chatId);
      scheduleHistSave();
    }
    scheduleHistSave();
    throw err;
  }
}

// ─── Envoyer (découpe + fallback Markdown propre) ────────────────────────────
function stripMarkdown(s) {
  // Nettoie les entités Telegram invalides plutôt que tout perdre
  return s
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // gras double → texte
    .replace(/\*([^*\n]+)\*/g, '$1')      // gras simple → texte
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')        // italique → texte
    .replace(/`([^`]+)`/g, '$1')          // code → texte
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1'); // liens → texte
}
async function sendChunk(chatId, chunk) {
  try {
    return await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch {
    return bot.sendMessage(chatId, stripMarkdown(chunk), { disable_web_page_preview: true });
  }
}
async function send(chatId, text) {
  const MAX = 4000;
  const str = String(text || '');
  if (str.length <= MAX) return sendChunk(chatId, str);
  const chunks = [];
  let buf = '';
  for (const ligne of str.split('\n')) {
    if ((buf + '\n' + ligne).length > MAX) { if (buf) chunks.push(buf.trim()); buf = ligne; }
    else { buf = buf ? buf + '\n' + ligne : ligne; }
  }
  if (buf.trim()) chunks.push(buf.trim());
  for (const chunk of chunks) await sendChunk(chatId, chunk);
}

// ─── Guard ────────────────────────────────────────────────────────────────────
function isAllowed(msg) {
  if (!msg.from) return false;
  return !ALLOWED_ID || msg.from.id === ALLOWED_ID;
}

// ─── Confirmation envoi email ─────────────────────────────────────────────────
const CONFIRM_REGEX = /^(envoie[!.]?|envoie[- ]le[!.]?|parfait[!.]?|go[!.]?|oui[!.]?|ok[!.]?|d'accord[!.]?|send[!.]?|c'est bon[!.]?|ça marche[!.]?)$/i;

async function handleEmailConfirmation(chatId, text) {
  if (!CONFIRM_REGEX.test(text.trim())) return false;
  const pending = pendingEmails.get(chatId);
  if (!pending) return false;

  let sent = false;
  let method = '';

  // 1. Essayer Gmail (priorité)
  try {
    const token = await getGmailToken(); // retourne string ou null — jamais throw ici
    if (token) {
      await envoyerEmailGmail(pending);
      sent = true;
      method = 'Gmail';
    }
  } catch (e) {
    log('WARN', 'EMAIL', `Gmail fail: ${e.message} — tentative Brevo`);
  }

  // 2. Fallback Brevo si Gmail a échoué ou non configuré
  if (!sent) {
    try {
      if (!BREVO_KEY) throw new Error('BREVO_API_KEY manquant dans Render');
      const ok = await envoyerEmailBrevo({ to: pending.to, toName: pending.toName, subject: pending.sujet, textContent: pending.texte });
      if (!ok) throw new Error('Brevo HTTP error');
      sent = true;
      method = 'Brevo';
    } catch (e) {
      log('ERR', 'EMAIL', `Brevo fail: ${e.message}`);
    }
  }

  if (!sent) {
    await send(chatId, `❌ Email non envoyé — Gmail et Brevo en échec.\n_Brouillon conservé — dis "envoie" pour réessayer ou vérifie /status._`);
    return true;
  }

  pendingEmails.delete(chatId); // supprimer SEULEMENT après succès confirmé
  logActivity(`Email envoyé (${method}) → ${pending.to} — "${pending.sujet.substring(0,60)}"`);
  mTick('emailsSent', 0); metrics.emailsSent++;
  await send(chatId, `✅ *Email envoyé* (${method})\nÀ: ${pending.toName || pending.to}\nObjet: ${pending.sujet}`);
  return true;
}

// ─── Handlers Telegram ────────────────────────────────────────────────────────
function registerHandlers() {

  bot.onText(/\/start/, msg => {
    if (!isAllowed(msg)) return;
    bot.sendMessage(msg.chat.id,
      `👋 Salut Shawn\\!\n\n*Surveillance automatique:*\n📧 Leads Gmail \\(Centris/RE\\-MAX\\) → deal \\+ J\\+0 auto\n📸 Photo/terrain → analyse Opus 4\\.7\n📄 PDF contrat/offre → extraction clés\n🎤 Vocal → action\n\n*Commandes:*\n/pipeline · /stats · /stagnants · /emails\n/checkemail — Scanner leads manqués\n/poller — Statut du poller Gmail\n/lead \\[info\\] — Créer prospect\n/status · /reset · /penser`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  bot.onText(/\/reset/, msg => {
    if (!isAllowed(msg)) return;
    chats.delete(msg.chat.id);
    pendingEmails.delete(msg.chat.id);
    scheduleHistSave();
    bot.sendMessage(msg.chat.id, '🔄 Nouvelle conversation. Je t\'écoute!');
  });

  bot.onText(/\/status/, msg => {
    if (!isAllowed(msg)) return;
    const h = getHistory(msg.chat.id);
    const uptime = Math.floor(process.uptime() / 60);
    const gmailOk      = !!(process.env.GMAIL_CLIENT_ID);
    const whisperOk    = !!(process.env.OPENAI_API_KEY);
    const centrisOk    = !!(process.env.CENTRIS_USER && centrisSession.authenticated);
    const dbxOk        = !!(dropboxToken && process.env.DROPBOX_REFRESH_TOKEN);
    const pollerLast   = gmailPollerState.lastRun ? new Date(gmailPollerState.lastRun).toLocaleTimeString('fr-CA', { hour:'2-digit', minute:'2-digit', timeZone:'America/Toronto' }) : 'jamais';
    bot.sendMessage(msg.chat.id,
      `✅ *Kira — ${TOOLS.length} outils*\n🎯 Routing auto · base: \`${currentModel.replace('claude-','')}\` · Opus sur analyse/stratégie\n${thinkingMode?'🧠 thinking ON':'⚡'} | Uptime: ${uptime}min | Mémos: ${kiramem.facts.length}\n\nPipedrive: ${PD_KEY?'✅':'❌'} | Brevo: ${BREVO_KEY?'✅':'❌'}\nGmail: ${gmailOk?'✅':'⚠️'} | Dropbox: ${dbxOk?'✅':'❌'}\nCentris: ${centrisOk?`✅ (${process.env.CENTRIS_USER})`:'⏳'}\nWhisper: ${whisperOk?'✅':'⚠️ OPENAI manquant'}\nPoller: ${gmailOk?`✅ ${pollerLast} (${gmailPollerState.totalLeads||0} leads)`:'❌'}\n\n/opus ou /haiku pour forcer · /penser pour thinking profond`,
      { parse_mode: 'Markdown' }
    );
  });

  // ─── Commandes poller ────────────────────────────────────────────────────────
  // ─── Metrics — observabilité depuis Telegram ──────────────────────────────────
  bot.onText(/\/metrics/, async msg => {
    if (!isAllowed(msg)) return;
    const uptimeS = Math.floor((Date.now() - metrics.startedAt) / 1000);
    const uptime  = `${Math.floor(uptimeS/3600)}h ${Math.floor((uptimeS%3600)/60)}m`;
    const topTools = Object.entries(metrics.tools).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${k}: ${v}`).join(', ') || 'aucun';
    const errorsByCode = Object.entries(metrics.errors.byStatus).map(([k,v])=>`${k}:${v}`).join(', ') || '0';
    const openCircuits = Object.entries(circuits).filter(([,v])=>Date.now()<v.openUntil).map(([k])=>k).join(', ') || 'aucun';
    const txt = `📊 *Métriques — ${uptime}*\n\n*Messages reçus:*\ntext: ${metrics.messages.text} · voice: ${metrics.messages.voice} · photo: ${metrics.messages.photo} · pdf: ${metrics.messages.pdf}\n\n*API calls:*\nClaude: ${metrics.api.claude} · Pipedrive: ${metrics.api.pipedrive}\nGmail: ${metrics.api.gmail} · Dropbox: ${metrics.api.dropbox}\nCentris: ${metrics.api.centris} · Brevo: ${metrics.api.brevo}\n\n*Top outils:*\n${topTools}\n\n*Erreurs:* ${metrics.errors.total} (${errorsByCode})\n*Leads:* ${metrics.leads} · *Emails envoyés:* ${metrics.emailsSent}\n*Circuit breakers ouverts:* ${openCircuits}\n\nEndpoint JSON complet: ${AGENT.site.startsWith('http')?AGENT.site:'https://signaturesb-bot-s272.onrender.com'}/health`;
    bot.sendMessage(msg.chat.id, txt, { parse_mode: 'Markdown' });
  });

  // ─── Test Centris agent ────────────────────────────────────────────────────────
  bot.onText(/\/centris/, async msg => {
    if (!isAllowed(msg)) return;
    if (!process.env.CENTRIS_USER) {
      return bot.sendMessage(msg.chat.id, '❌ CENTRIS_USER non configuré dans Render.');
    }
    await bot.sendMessage(msg.chat.id, `🔐 Test connexion Centris (agent ${process.env.CENTRIS_USER})...`);
    const ok = await centrisLogin();
    if (ok) {
      await bot.sendMessage(msg.chat.id, `✅ *Centris connecté!*\nAgent: ${process.env.CENTRIS_USER}\nSession active 2h\n\nEssaie: "comparables terrains Rawdon 14 jours"`, { parse_mode: 'Markdown' });
    } else {
      await bot.sendMessage(msg.chat.id, `❌ *Centris: connexion échouée*\nVérifier:\n• CENTRIS_USER=${process.env.CENTRIS_USER}\n• CENTRIS_PASS configuré\n• Compte actif sur centris.ca`, { parse_mode: 'Markdown' });
    }
  });

  bot.onText(/\/checkemail/, async msg => {
    if (!isAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id, '🔍 Scan 48h — leads éventuellement manqués...');
    // Forcer scan 48h en passant un `forceSince` au lieu de manipuler le state
    await runGmailLeadPoller({ forceSince: '48h' }).catch(e =>
      bot.sendMessage(msg.chat.id, `❌ Poller: ${e.message}`)
    );
    const s = pollerStats.lastScan;
    await bot.sendMessage(msg.chat.id,
      `✅ Scan terminé\n\n` +
      `📬 ${s.found} emails trouvés\n` +
      `🗑 ${s.junk} junk filtered\n` +
      `🔍 ${s.noSource} sans source\n` +
      `⚠️ ${s.lowInfo} info insuffisante (P0 alert envoyée si >0)\n` +
      `✅ ${s.dealCreated} deals créés\n` +
      `❌ ${s.errors} erreurs\n\n` +
      `Total depuis boot: ${gmailPollerState.totalLeads} leads`
    );
  });

  // Confirmer envoi docs depuis pending (zone 80-89 confirmation requise)
  bot.onText(/^envoie\s+(?:les\s+)?docs?\s+(?:à|a)\s+(\S+)/i, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const target = match[1].toLowerCase().trim();
    // Trouver dans pendingDocSends par email exact ou nom
    let pending = null;
    for (const [email, p] of pendingDocSends) {
      if (email.toLowerCase() === target || p.nom?.toLowerCase().includes(target.toLowerCase())) {
        pending = p;
        pendingDocSends.delete(email);
        break;
      }
    }
    if (!pending) {
      return bot.sendMessage(msg.chat.id, `❌ Aucun pending match pour "${target}". Utilise /pending pour voir la liste.`);
    }
    await bot.sendMessage(msg.chat.id, `📤 Envoi docs à ${pending.email}...`);
    try {
      const r = await envoyerDocsAuto(pending);
      if (r.sent) {
        await bot.sendMessage(msg.chat.id, `✅ Envoyé · ${pending.match.pdfs.length} PDFs · ${Math.round(r.deliveryMs/1000)}s`);
        auditLogEvent('manual-send', 'docs-sent', { email: pending.email, confirmed: true });
      } else {
        await bot.sendMessage(msg.chat.id, `⚠️ Échec: ${r.error || r.reason}`);
      }
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  // Annuler un pending docs
  bot.onText(/^(?:annule|cancel)\s+(\S+)/i, (msg, match) => {
    if (!isAllowed(msg)) return;
    const target = match[1].toLowerCase().trim();
    let cancelled = null;
    for (const [email, p] of pendingDocSends) {
      if (email.toLowerCase() === target || p.nom?.toLowerCase().includes(target.toLowerCase())) {
        cancelled = email;
        pendingDocSends.delete(email);
        break;
      }
    }
    bot.sendMessage(msg.chat.id, cancelled ? `🗑 Annulé: ${cancelled}` : `❌ Aucun pending pour "${target}"`);
  });

  // Voir liste pending docs
  bot.onText(/\/pending/, msg => {
    if (!isAllowed(msg)) return;
    if (pendingDocSends.size === 0) return bot.sendMessage(msg.chat.id, '✅ Aucun doc en attente');
    const lines = [...pendingDocSends.values()].map(p =>
      `• ${p.nom || p.email} · score ${p.match?.score} · ${p.match?.pdfs.length} PDFs → \`envoie les docs à ${p.email}\``
    ).join('\n');
    bot.sendMessage(msg.chat.id, `📦 *Pending (${pendingDocSends.size})*\n\n${lines}`, { parse_mode: 'Markdown' });
  });

  // Pause/resume auto-envoi global
  bot.onText(/\/pauseauto/, msg => {
    if (!isAllowed(msg)) return;
    autoSendPaused = !autoSendPaused;
    bot.sendMessage(msg.chat.id, autoSendPaused
      ? '⏸ Auto-envoi docs PAUSÉ — tout passera en brouillon jusqu\'à /pauseauto'
      : '▶️ Auto-envoi docs REPRIS — envois ≥90 automatiques.');
  });

  bot.onText(/\/cout|\/cost/, msg => {
    if (!isAllowed(msg)) return;
    const d = today(), m = thisMonth();
    const todayCost = costTracker.daily[d] || 0;
    const monthCost = costTracker.monthly[m] || 0;
    const totalCost = costTracker.total || 0;
    const byModel = Object.entries(costTracker.byModel || {})
      .sort((a,b) => b[1] - a[1])
      .map(([k,v]) => `  ${k.replace('claude-','')}: $${v.toFixed(2)}`)
      .join('\n') || '  —';
    // Projection mensuelle basée sur jours écoulés
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth()+1, 0).getDate();
    const daysElapsed = new Date().getDate();
    const projection = daysElapsed > 0 ? (monthCost / daysElapsed * daysInMonth) : 0;
    bot.sendMessage(msg.chat.id,
      `💰 *Coût Anthropic*\n\n` +
      `📅 Aujourd'hui: *$${todayCost.toFixed(4)}*\n` +
      `📆 Ce mois: *$${monthCost.toFixed(2)}*\n` +
      `📊 Projection mois: ~$${projection.toFixed(2)}\n` +
      `🏆 Total cumul: $${totalCost.toFixed(2)}\n\n` +
      `*Par modèle:*\n${byModel}\n\n` +
      `Seuils d'alerte: $10/jour · $100/mois`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/baseline|\/cutoff|\/leadsreset/, async msg => {
    if (!isAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id, '⏱ Baseline: tous les leads actuels → marqués comme déjà vus (pas de notifs) — seuls les nouveaux après MAINTENANT seront notifiés.');
    try {
      const token = await getGmailToken();
      if (!token) return bot.sendMessage(msg.chat.id, '❌ Gmail non configuré');
      const shawnEmail = AGENT.email.toLowerCase();
      const queries = [
        `newer_than:7d from:centris NOT from:${shawnEmail}`,
        `newer_than:7d from:remax NOT from:${shawnEmail}`,
        `newer_than:7d from:realtor NOT from:${shawnEmail}`,
        `newer_than:7d from:duproprio NOT from:${shawnEmail}`,
        `newer_than:7d subject:(demande OR "intéress" OR inquiry) NOT from:${shawnEmail}`,
      ];
      let marked = 0;
      const seen = new Set();
      for (const q of queries) {
        const list = await gmailAPI(`/messages?maxResults=50&q=${encodeURIComponent(q)}`).catch(() => null);
        if (!list?.messages?.length) continue;
        for (const m of list.messages) {
          if (seen.has(m.id) || gmailPollerState.processed.includes(m.id)) continue;
          seen.add(m.id);
          gmailPollerState.processed.push(m.id);
          marked++;
          // Extraire aussi email/tel/centris du message pour peupler recentLeadsByKey
          try {
            const full = await gmailAPI(`/messages/${m.id}?format=full`).catch(() => null);
            if (full) {
              const hdrs = full.payload?.headers || [];
              const get = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
              const from    = get('from');
              const subject = get('subject');
              const body    = gmailExtractBody(full.payload);
              if (!isJunkLeadEmail(subject, from, body)) {
                const source = detectLeadSource(from, subject);
                if (source) {
                  const lead = parseLeadEmail(body, subject, from);
                  // Mark dans dedup sans notifier
                  leadAlreadyNotifiedRecently({
                    email: lead.email,
                    telephone: lead.telephone,
                    centris: lead.centris,
                    nom: lead.nom,
                    source: source.source,
                  });
                }
              }
            }
          } catch {}
        }
      }
      // Cutoff au moment présent — seuls emails futurs traités
      gmailPollerState.lastRun = new Date().toISOString();
      // FIFO max 500
      if (gmailPollerState.processed.length > 500) {
        gmailPollerState.processed = gmailPollerState.processed.slice(-500);
      }
      saveJSON(POLLER_FILE, gmailPollerState); schedulePollerSave();
      await bot.sendMessage(msg.chat.id,
        `✅ Baseline fait.\n\n` +
        `📧 ${marked} emails marqués comme déjà vus\n` +
        `🔒 ${recentLeadsByKey.size} leads dans dédup\n` +
        `⏱ Cutoff: ${new Date().toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}\n\n` +
        `À partir de maintenant, SEULS les nouveaux leads qui rentrent après cette minute seront notifiés sur Telegram.`
      );
    } catch (e) {
      await bot.sendMessage(msg.chat.id, `❌ ${e.message}`);
    }
  });

  bot.onText(/\/cleanemail/, async msg => {
    if (!isAllowed(msg)) return;
    await bot.sendMessage(msg.chat.id, '🧹 Nettoyage emails GitHub/CI/Dependabot (30 derniers jours)...');
    const res = await autoTrashGitHubNoise({ maxAge: '30d' });
    await bot.sendMessage(msg.chat.id, res.error
      ? `❌ ${res.error}`
      : `✅ ${res.trashed} emails mis à la corbeille.\n\nAuto-clean: boot + tous les jours à 6h.`);
  });

  bot.onText(/\/forcelead\s+([a-zA-Z0-9_-]+)/, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const msgId = match[1];
    await bot.sendMessage(msg.chat.id, `🎯 Force process email Gmail ${msgId}...`);
    // Retirer l'ID de processed[] pour forcer retraitement
    const idx = gmailPollerState.processed.indexOf(msgId);
    if (idx >= 0) gmailPollerState.processed.splice(idx, 1);
    await runGmailLeadPoller({ singleMsgId: msgId }).catch(e =>
      bot.sendMessage(msg.chat.id, `❌ ${e.message}`)
    );
    const s = pollerStats.lastScan;
    await bot.sendMessage(msg.chat.id,
      s.dealCreated > 0 ? `✅ Lead traité!` :
      s.lowInfo > 0 ? `⚠️ Info insuffisante même après AI fallback — voir P0 alert` :
      s.junk > 0 ? `🗑 Filtré comme junk` :
      s.noSource > 0 ? `🔍 Pas reconnu comme lead (source inconnue)` :
      `❌ Aucun traitement — vérifie Gmail ID`
    );
  });

  bot.onText(/\/poller|\/leadstats/, msg => {
    if (!isAllowed(msg)) return;
    const last    = gmailPollerState.lastRun ? new Date(gmailPollerState.lastRun).toLocaleTimeString('fr-CA', { timeZone: 'America/Toronto' }) : 'jamais';
    const gmailOk = !!(process.env.GMAIL_CLIENT_ID);
    const s = pollerStats.lastScan;
    const t = pollerStats;
    bot.sendMessage(msg.chat.id,
      `📧 *Gmail Lead Poller*\n` +
      `Statut: ${gmailOk ? '✅ Actif' : '❌ Gmail non configuré'}\n` +
      `Dernier scan: ${last} (${pollerStats.lastDuration}ms)\n` +
      `Runs: ${pollerStats.runs}\n\n` +
      `*Dernier scan:*\n` +
      `📬 Trouvés: ${s.found} · 🗑 Junk: ${s.junk}\n` +
      `🔍 Pas source: ${s.noSource} · ⚠️ Low info: ${s.lowInfo}\n` +
      `✅ Deals: ${s.dealCreated} · ❌ Erreurs: ${s.errors}\n\n` +
      `*Cumulatif:*\n` +
      `Total leads: ${gmailPollerState.totalLeads || 0}\n` +
      `Total found: ${t.totalsFound} · Junk: ${t.totalsJunk}\n` +
      `Deals créés: ${t.totalsDealCreated} · Low info: ${t.totalsLowInfo}\n` +
      `IDs mémorisés: ${gmailPollerState.processed?.length || 0}\n` +
      (pollerStats.lastError ? `\n⚠️ Dernière erreur: ${pollerStats.lastError.substring(0, 100)}` : '') +
      `\n\nCommandes:\n/checkemail — scan 48h\n/forcelead <id> — force retraitement`,
      { parse_mode: 'Markdown' }
    );
  });

  bot.onText(/\/autoenvoi/, msg => {
    if (!isAllowed(msg)) return;
    const total   = autoEnvoiState.totalAuto || 0;
    const fails   = autoEnvoiState.totalFails || 0;
    const rate    = (total + fails) > 0 ? Math.round(100 * total / (total + fails)) : 0;
    const recent  = (autoEnvoiState.log || []).slice(0, 5);
    const avgMs   = recent.filter(l => l.success).reduce((s, l, _, a) => s + (l.deliveryMs || 0) / (a.length || 1), 0);
    let txt = `🚀 *Auto-envoi docs*\n\n`;
    txt += `Succès: ${total} · Échecs: ${fails} · Taux: ${rate}%\n`;
    txt += `Temps moyen: ${Math.round(avgMs / 1000)}s\n\n`;
    txt += `*5 derniers:*\n`;
    if (!recent.length) txt += '_(aucun auto-envoi encore)_';
    else txt += recent.map(l => {
      const when = new Date(l.timestamp).toLocaleString('fr-CA', { timeZone:'America/Toronto', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
      return l.success
        ? `✅ ${when} — ${l.email} · ${l.pdfsCount}PDFs · ${l.strategy}(${l.score}) · ${Math.round(l.deliveryMs/1000)}s`
        : `❌ ${when} — ${l.email} · ${String(l.error).substring(0, 60)}`;
    }).join('\n');
    bot.sendMessage(msg.chat.id, txt, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/pipeline/, async msg => {
    if (!isAllowed(msg)) return;
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    const result = await getPipeline();
    clearInterval(typing);
    await send(msg.chat.id, result);
  });

  bot.onText(/\/stats/, async msg => {
    if (!isAllowed(msg)) return;
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    const result = await statsBusiness();
    clearInterval(typing);
    await send(msg.chat.id, result);
  });

  bot.onText(/\/emails/, async msg => {
    if (!isAllowed(msg)) return;
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    const result = await voirEmailsRecents('1d');
    clearInterval(typing);
    await send(msg.chat.id, result);
  });

  bot.onText(/\/memoire/, msg => {
    if (!isAllowed(msg)) return;
    if (!kiramem.facts.length) return bot.sendMessage(msg.chat.id, '🧠 Aucun fait mémorisé pour l\'instant.');
    const list = kiramem.facts.map((f, i) => `${i+1}. ${f}`).join('\n');
    bot.sendMessage(msg.chat.id, `🧠 *Mémoire persistante:*\n\n${list}`, { parse_mode: 'Markdown' });
  });

  bot.onText(/\/oublier/, msg => {
    if (!isAllowed(msg)) return;
    kiramem.facts = [];
    kiramem.updatedAt = new Date().toISOString();
    saveJSON(MEM_FILE, kiramem);
    saveMemoryToGist().catch(() => {});
    bot.sendMessage(msg.chat.id, '🗑️ Mémoire effacée (local + Gist).');
  });

  bot.onText(/\/opus/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-opus-4-7';
    bot.sendMessage(msg.chat.id, '🚀 Mode Opus 4.7 activé — le plus puissant (défaut).');
  });

  bot.onText(/\/sonnet/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-sonnet-4-6';
    bot.sendMessage(msg.chat.id, '🧠 Mode Sonnet activé — rapide et fort.');
  });

  bot.onText(/\/haiku/, msg => {
    if (!isAllowed(msg)) return;
    currentModel = 'claude-haiku-4-5';
    bot.sendMessage(msg.chat.id, '⚡ Mode Haiku activé — ultra-rapide et léger.');
  });

  bot.onText(/\/penser/, msg => {
    if (!isAllowed(msg)) return;
    thinkingMode = !thinkingMode;
    bot.sendMessage(msg.chat.id, thinkingMode
      ? '🧠 *Mode réflexion ON* — Opus 4.7 pense en profondeur avant chaque réponse.\nIdéal: stratégie de prix, analyse marché complexe, négociation.\nPlus lent mais beaucoup plus précis.'
      : '⚡ *Mode réflexion OFF* — Réponses rapides.',
      { parse_mode: 'Markdown' }
    );
  });

  // ─── Commandes rapides mobile ────────────────────────────────────────────────
  bot.onText(/\/stagnants/, async msg => {
    if (!isAllowed(msg)) return;
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    const result = await prospectStagnants(3);
    clearInterval(typing);
    await send(msg.chat.id, result);
  });

  // /relances — sur glace (J+1/J+3/J+7 désactivé temporairement)

  bot.onText(/\/lead (.+)/, async (msg, match) => {
    if (!isAllowed(msg)) return;
    const info = match[1];
    const typing = setInterval(() => bot.sendChatAction(msg.chat.id, 'typing').catch(() => {}), 4500);
    const { reply } = await callClaude(msg.chat.id, `Nouveau prospect: ${info}. Crée le deal dans Pipedrive immédiatement.`);
    clearInterval(typing);
    await send(msg.chat.id, reply);
  });

  // ─── Messages texte ──────────────────────────────────────────────────────────
  bot.on('message', async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    const text   = msg.text;
    if (!text || text.startsWith('/')) return;
    if (isDuplicate(msg.message_id)) return;

    log('IN', 'MSG', text.substring(0, 80));

    // Vérifier si c'est une confirmation d'envoi d'email
    if (await handleEmailConfirmation(chatId, text)) return;

    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    try {
      const { reply, memos } = await callClaude(chatId, text);
      clearInterval(typing);
      await send(chatId, reply);
      if (memos.length) {
        await bot.sendMessage(chatId, `📝 *Mémorisé:* ${memos.join(' | ')}`, { parse_mode: 'Markdown' });
      }
    } catch (err) {
      clearInterval(typing);
      log('ERR', 'MSG', `${err.status || '?'}: ${err.message?.substring(0,150)}`);
      await bot.sendMessage(chatId, formatAPIError(err));
    }
  });

  // ─── Messages vocaux (Whisper) ────────────────────────────────────────────────
  bot.on('voice', async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    if (isDuplicate(msg.message_id)) return;

    if (!process.env.OPENAI_API_KEY) {
      await bot.sendMessage(chatId, '⚠️ Whisper non configuré. Ajoute `OPENAI_API_KEY` dans Render.');
      return;
    }

    log('IN', 'VOICE', `${msg.voice.duration}s`);
    mTick('messages', 'voice');
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      const fileInfo = await bot.getFile(msg.voice.file_id);
      const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
      const res      = await fetch(fileUrl);
      const buffer   = Buffer.from(await res.arrayBuffer());
      const texte    = await transcrire(buffer);

      if (!texte) { await bot.sendMessage(chatId, '❌ Impossible de transcrire ce message vocal.'); return; }

      log('OK', 'VOICE', `Transcrit: "${texte.substring(0, 60)}"`);
      await bot.sendMessage(chatId, `🎤 _${texte}_`, { parse_mode: 'Markdown' });

      const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
      try {
        const { reply, memos } = await callClaude(chatId, texte);
        clearInterval(typing);
        await send(chatId, reply);
        if (memos.length) await bot.sendMessage(chatId, `📝 *Mémorisé:* ${memos.join(' | ')}`, { parse_mode: 'Markdown' });
      } catch (err) {
        clearInterval(typing);
        log('ERR', 'VOICE-MSG', `${err.status||'?'}: ${err.message?.substring(0,120)}`);
        await bot.sendMessage(chatId, formatAPIError(err));
      }
    } catch (err) {
      log('ERR', 'VOICE', err.message);
      await bot.sendMessage(chatId, `❌ Erreur vocal: ${err.message.substring(0, 120)}`);
    }
  });

  // ─── Photos (vision Opus 4.7) ────────────────────────────────────────────────
  bot.on('photo', async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    if (isDuplicate(msg.message_id)) return;

    const photo   = msg.photo[msg.photo.length - 1]; // Résolution max
    const caption = msg.caption || 'Analyse cette photo en contexte immobilier québécois. Qu\'est-ce que tu vois? Qu\'est-ce que je dois savoir?';

    log('IN', 'PHOTO', `${photo.width}x${photo.height} — "${caption.substring(0, 60)}"`);
    mTick('messages', 'photo');
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      const dlController = new AbortController();
      const dlTimeout    = setTimeout(() => dlController.abort(), 20000);
      let fileInfo, buffer;
      try {
        fileInfo = await bot.getFile(photo.file_id);
        if (!fileInfo.file_path) throw new Error('Telegram: file_path manquant');
        const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
        const fetchRes = await fetch(fileUrl, { signal: dlController.signal });
        buffer = Buffer.from(await fetchRes.arrayBuffer());
      } finally { clearTimeout(dlTimeout); }

      if (buffer.length === 0) throw new Error('Fichier vide reçu de Telegram');
      if (buffer.length > 5 * 1024 * 1024) {
        clearInterval(typing);
        await bot.sendMessage(chatId, '⚠️ Image trop grosse (max 5MB). Compresse et réessaie.');
        return;
      }

      const base64    = buffer.toString('base64');
      const mediaType = fileInfo.file_path.endsWith('.png') ? 'image/png' : 'image/jpeg';
      const content   = [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: caption }
      ];
      const contextLabel = `[PHOTO envoyée: ${photo.width}x${photo.height}] "${caption.substring(0, 80)}"`;

      const { reply, memos } = await callClaudeVision(chatId, content, contextLabel);
      clearInterval(typing);
      await send(chatId, reply);
      if (memos.length) await bot.sendMessage(chatId, `📝 *Mémorisé:* ${memos.join(' | ')}`, { parse_mode: 'Markdown' });

    } catch (err) {
      clearInterval(typing);
      log('ERR', 'PHOTO', `${err.status||'?'}: ${err.message?.substring(0,150)}`);
      await bot.sendMessage(chatId, `❌ Analyse photo: ${formatAPIError(err)}`);
    }
  });

  // ─── Documents PDF (analyse contrats, rapports, évaluations) ─────────────────
  bot.on('document', async (msg) => {
    if (!isAllowed(msg)) return;
    const chatId = msg.chat.id;
    if (isDuplicate(msg.message_id)) return;

    const doc     = msg.document;
    const caption = msg.caption || 'Analyse ce document. Extrais les informations clés et dis-moi ce que je dois savoir.';

    if (doc.mime_type !== 'application/pdf') {
      await bot.sendMessage(chatId, `⚠️ Format non supporté: \`${doc.mime_type || 'inconnu'}\`. Envoie un PDF.`, { parse_mode: 'Markdown' });
      return;
    }
    if (doc.file_size > 10 * 1024 * 1024) {
      await bot.sendMessage(chatId, '⚠️ PDF trop gros (max 10MB).');
      return;
    }

    log('IN', 'PDF', `${doc.file_name} — ${Math.round(doc.file_size / 1024)}KB`);
    mTick('messages', 'pdf');
    const typing = setInterval(() => bot.sendChatAction(chatId, 'typing').catch(() => {}), 4500);
    bot.sendChatAction(chatId, 'typing').catch(() => {});

    try {
      const dlController = new AbortController();
      const dlTimeout    = setTimeout(() => dlController.abort(), 25000);
      let fileInfo, buffer;
      try {
        fileInfo = await bot.getFile(doc.file_id);
        if (!fileInfo.file_path) throw new Error('Telegram: file_path manquant');
        const fileUrl  = `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.file_path}`;
        const fetchRes = await fetch(fileUrl, { signal: dlController.signal });
        buffer = Buffer.from(await fetchRes.arrayBuffer());
      } finally { clearTimeout(dlTimeout); }
      if (buffer.length === 0) throw new Error('Fichier PDF vide reçu de Telegram');
      const base64   = buffer.toString('base64');
      const content  = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: caption }
      ];
      const contextLabel = `[PDF: ${doc.file_name}] "${caption.substring(0, 80)}"`;

      const { reply, memos } = await callClaudeVision(chatId, content, contextLabel);
      clearInterval(typing);
      await send(chatId, reply);
      if (memos.length) await bot.sendMessage(chatId, `📝 *Mémorisé:* ${memos.join(' | ')}`, { parse_mode: 'Markdown' });

    } catch (err) {
      clearInterval(typing);
      log('ERR', 'PDF', `${err.status||'?'}: ${err.message?.substring(0,150)}`);
      await bot.sendMessage(chatId, `❌ Analyse PDF: ${formatAPIError(err)}`);
    }
  });

  // Mode webhook — pas de polling errors à gérer (bot.processUpdate reçoit les messages)
  bot.on('webhook_error', err => log('WARN', 'TG', `Webhook: ${err.message}`));
}

// ─── Tâches quotidiennes (sans node-cron) ─────────────────────────────────────
const lastCron = { digest: null, suivi: null, visites: null, sync: null, trashCI: null };

async function runDigestJulie() {
  if (!PD_KEY || !BREVO_KEY) return;
  try {
    const [nouveaux, enDiscussion, visitesAujourdhui] = await Promise.all([
      pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&stage_id=49&status=open&limit=30`),
      pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&stage_id=51&status=open&limit=30`),
      pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&stage_id=52&status=open&limit=30`),
    ]);
    const today = new Date().toLocaleDateString('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'America/Toronto' });
    let body = `Bonjour Julie,\n\nVoici le résumé pipeline du ${today}.\n\n`;
    if (nouveaux?.data?.length) { body += `NOUVEAUX LEADS (${nouveaux.data.length}):\n`; nouveaux.data.forEach(d => body += `• ${d.title}\n`); body += '\n'; }
    if (enDiscussion?.data?.length) { body += `EN DISCUSSION (${enDiscussion.data.length}):\n`; enDiscussion.data.forEach(d => body += `• ${d.title}\n`); body += '\n'; }
    if (visitesAujourdhui?.data?.length) { body += `VISITES PRÉVUES (${visitesAujourdhui.data.length}):\n`; visitesAujourdhui.data.forEach(d => body += `• ${d.title}\n`); body += '\n'; }
    if (!nouveaux?.data?.length && !enDiscussion?.data?.length && !visitesAujourdhui?.data?.length) return; // Rien à envoyer
    body += 'Bonne journée!\nKira — Signature SB';
    const ok = await envoyerEmailBrevo({ to: JULIE_EMAIL, toName: 'Julie', subject: `📋 Pipeline — ${today}`, textContent: body });
    if (ok) log('OK', 'CRON', 'Digest Julie envoyé');
  } catch (e) { log('ERR', 'CRON', `Digest: ${e.message}`); }
}

async function runSuiviQuotidien() {
  if (!PD_KEY || !ALLOWED_ID) return;
  try {
    const data = await pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`);
    const deals = data?.data || [];
    const now = Date.now();
    const relances = [];
    for (const deal of deals) {
      if (deal.stage_id > 51) continue;
      const j1 = deal[PD_FIELD_SUIVI_J1];
      const j3 = deal[PD_FIELD_SUIVI_J3];
      const j7 = deal[PD_FIELD_SUIVI_J7];
      const created = new Date(deal.add_time).getTime();
      const joursDep = (now - created) / 86400000;
      if (!j1 && joursDep >= 1)          relances.push({ deal, type: 'J+1 (premier contact)', emoji: '🟢' });
      else if (j1 && !j3 && joursDep >= 3) relances.push({ deal, type: 'J+3 (validation intérêt)', emoji: '🟡' });
      else if (j1 && j3 && !j7 && joursDep >= 7) relances.push({ deal, type: 'J+7 (DERNIER — décision)', emoji: '🔴' });
    }
    if (!relances.length) return;
    let msg = `📋 *Suivi du jour — ${relances.length} prospect${relances.length > 1 ? 's' : ''} à relancer:*\n\n`;
    for (const { deal, type, emoji } of relances) {
      const stage = PD_STAGES[deal.stage_id] || '';
      msg += `${emoji} *${deal.title}* — ${type}\n  ${stage}\n`;
    }
    msg += '\n_Dis "relance [nom]" pour que je rédige le message._';
    await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) { log('ERR', 'CRON', `Suivi: ${e.message}`); }
}

async function rappelVisitesMatin() {
  if (!ALLOWED_ID) return;
  try {
    const visites = loadJSON(VISITES_FILE, []);
    const today   = new Date().toDateString();
    const visitesDuJour = visites.filter(v => new Date(v.date).toDateString() === today);
    if (!visitesDuJour.length) return;
    let msg = `📅 *Visites d'aujourd'hui — ${visitesDuJour.length}:*\n\n`;
    for (const v of visitesDuJour.sort((a, b) => new Date(a.date) - new Date(b.date))) {
      const heure = new Date(v.date).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Toronto' });
      msg += `🏡 *${v.nom}* — ${heure}${v.adresse ? '\n📍 ' + v.adresse : ''}\n\n`;
    }
    await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' });
  } catch (e) { log('ERR', 'CRON', `Visites: ${e.message}`); }
}

async function syncStatusGitHub() {
  if (!process.env.GITHUB_TOKEN) return;
  const now = new Date();
  const ts  = now.toLocaleDateString('fr-CA', { weekday:'long', year:'numeric', month:'long', day:'numeric', timeZone:'America/Toronto' })
            + ' à ' + now.toLocaleTimeString('fr-CA', { hour:'2-digit', minute:'2-digit', timeZone:'America/Toronto' });
  try {
    // PRIVACY: on ne publie PLUS les noms de clients ni les deals individuels.
    // Juste des stats agrégées anonymes pour monitoring.
    let totalActifs = 0, gagnesMois = 0, perdusMois = 0;
    let stagesCounts = {};
    if (PD_KEY) {
      const [actifs, gagnes, perdus] = await Promise.all([
        pdGet(`/deals?pipeline_id=${AGENT.pipeline_id}&status=open&limit=100`).catch(()=>null),
        pdGet('/deals?status=won&limit=100').catch(()=>null),
        pdGet('/deals?status=lost&limit=100').catch(()=>null),
      ]);
      totalActifs = (actifs?.data||[]).length;
      for (const d of (actifs?.data||[])) {
        const stage = PD_STAGES[d.stage_id] || `Étape ${d.stage_id}`;
        stagesCounts[stage] = (stagesCounts[stage]||0) + 1;
      }
      const m = now.getMonth();
      gagnesMois = (gagnes?.data||[]).filter(d=>new Date(d.won_time||0).getMonth()===m).length;
      perdusMois = (perdus?.data||[]).filter(d=>new Date(d.lost_time||0).getMonth()===m).length;
    }
    const visites    = loadJSON(VISITES_FILE, []);
    const prochaines = visites.filter(v => new Date(v.date).getTime() > Date.now()).length;

    const content = [
      `# Bot Signature SB — Rapport système`,
      `_${ts}_`,
      ``,
      `## Système`,
      `- Modèle: \`${currentModel}\` | Outils: ${TOOLS.length}`,
      `- Uptime: ${Math.floor(process.uptime()/60)}min`,
      `- Gmail Poller: ${gmailPollerState.totalLeads||0} leads traités (cumul)`,
      `- Dropbox: ${dropboxTerrains.length} terrains en cache`,
      ``,
      `## Pipeline (stats agrégées, sans identifier)`,
      `- Deals actifs: ${totalActifs}`,
      ...Object.entries(stagesCounts).map(([s,n]) => `  - ${s}: ${n}`),
      ``,
      `## Ce mois`,
      `- ✅ Gagnés: ${gagnesMois} | ❌ Perdus: ${perdusMois}`,
      `- 📅 Visites à venir (count): ${prochaines}`,
      ``,
      `> Privacy: ce fichier est public. Aucun nom/email/téléphone client.`,
      `> Pour les détails: Pipedrive directement ou \`/pipeline\` sur Telegram.`,
    ].join('\n');

    await writeGitHubFile('kira-bot', 'BOT_STATUS.md', content, `Sync: ${now.toISOString().split('T')[0]}`);
    log('OK', 'SYNC', `BOT_STATUS.md → kira-bot (stats anonymes, ${totalActifs} deals)`);
  } catch (e) { log('WARN', 'SYNC', `GitHub sync: ${e.message}`); }
}

function startDailyTasks() {
  // Rafraîchissement BOT_STATUS.md chaque heure (au lieu de 1×/jour)
  // Garantit que Claude Code peut toujours reprendre avec l'état le plus récent
  setInterval(() => syncStatusGitHub().catch(() => {}), 60 * 60 * 1000);

  // Sync bidirectionnelle Claude Code ↔ bot
  // - Lire SESSION_LIVE.md depuis GitHub (ce que Claude Code a écrit) toutes les 30 min
  // - Écrire BOT_ACTIVITY.md vers GitHub (ce que le bot a fait) toutes les 10 min
  setInterval(() => loadSessionLiveContext().catch(() => {}), 30 * 60 * 1000);
  setInterval(() => writeBotActivity().catch(() => {}), 10 * 60 * 1000);

  setInterval(() => {
    const now = new Date();
    const heure    = now.toLocaleString('fr-CA', { hour: 'numeric', hour12: false, timeZone: 'America/Toronto' });
    const h        = parseInt(heure);
    const todayStr = now.toDateString();
    if (h === 6  && lastCron.trashCI !== todayStr)  { lastCron.trashCI = todayStr; autoTrashGitHubNoise(); }
    if (h === 7  && lastCron.visites !== todayStr)  { lastCron.visites = todayStr; rappelVisitesMatin(); }
    if (h === 8  && lastCron.digest  !== todayStr)  { lastCron.digest  = todayStr; runDigestJulie(); }
    // J+1/J+3/J+7 sur glace — réactiver avec: lastCron.suivi check + runSuiviQuotidien()
    // if (h === 9  && lastCron.suivi   !== todayStr)  { lastCron.suivi   = todayStr; runSuiviQuotidien(); }
  }, 60 * 1000);
  // MONITORING PROACTIF — vérifie santé système toutes les 10 min, alerte Telegram si problème
  let monitoringState = { pollerAlertSent: false, autoEnvoiStreak: 0, lastAutoEnvoiAlert: 0 };
  setInterval(async () => {
    if (!ALLOWED_ID) return;
    const alerts = [];
    // 1. Poller silence > 10 min
    if (gmailPollerState.lastRun) {
      const minsAgo = (Date.now() - new Date(gmailPollerState.lastRun).getTime()) / 60000;
      if (minsAgo > 10) {
        if (!monitoringState.pollerAlertSent) {
          alerts.push(`🔴 *Gmail Poller silencieux depuis ${Math.round(minsAgo)}min* (devrait tourner aux 5min)`);
          monitoringState.pollerAlertSent = true;
        }
      } else monitoringState.pollerAlertSent = false;
    }
    // 2. Streak échecs auto-envoi (≥3 fails consécutifs → alerte, max 1×/h)
    const recent = (autoEnvoiState.log || []).slice(0, 5);
    const recentFails = recent.slice(0, 3).filter(l => !l.success).length;
    if (recentFails >= 3 && (Date.now() - monitoringState.lastAutoEnvoiAlert) > 3600000) {
      alerts.push(`🔴 *Auto-envoi docs ÉCHOUÉ 3 fois consécutifs* — vérifier Gmail/Dropbox.\n${recent.slice(0,3).map(l => `  • ${l.email}: ${String(l.error).substring(0,60)}`).join('\n')}`);
      monitoringState.lastAutoEnvoiAlert = Date.now();
    }
    // 3. Circuits ouverts prolongés
    for (const [name, c] of Object.entries(circuits)) {
      if (c.openUntil > Date.now() && c.fails >= 10) {
        alerts.push(`🔴 *Circuit ${name} OUVERT* (${c.fails} fails) — API down prolongée`);
      }
    }
    // Envoyer les alertes
    for (const a of alerts) {
      await bot.sendMessage(ALLOWED_ID, a, { parse_mode: 'Markdown' }).catch(() => {});
    }
  }, 10 * 60 * 1000);

  log('OK', 'CRON', 'Tâches: visites 7h, digest 8h→Julie, sync BOT_STATUS chaque heure, monitoring 10min');
}

// ─── Webhooks intelligents ────────────────────────────────────────────────────
async function handleWebhook(route, data) {
  if (!ALLOWED_ID) return;
  try {

    // ── CENTRIS — Lead entrant → deal auto + J+0 prêt ────────────────────────
    if (route === '/webhook/centris') {
      const nom     = (data.nom || data.name || 'Inconnu').trim();
      const tel     = data.telephone || data.tel || data.phone || '';
      const email   = data.email || '';
      const listing = data.url_listing || data.url || data.centris_url || '';
      const typeRaw = (data.type || listing).toLowerCase();

      // DÉDUP CROSS-SOURCE multi-clé: si ce lead a déjà été notifié (par email,
      // tel, centris# OU nom+source), skip. Évite doublons quand Centris webhook
      // + Gmail email pour le même prospect.
      const centrisForDedup = listing.match(/\/(\d{7,9})\b/)?.[1] || data.centris || '';
      if (leadAlreadyNotifiedRecently({ email, telephone: tel, centris: centrisForDedup, nom, source: 'centris' })) {
        log('INFO', 'WEBHOOK', `Centris dédup: ${nom} (${email||tel||centrisForDedup}) déjà notifié — skip`);
        return;
      }

      // Détecter le type depuis l'URL ou les données
      let type = 'terrain';
      if (/maison|house|résidentiel|residential/.test(typeRaw))    type = 'maison_usagee';
      else if (/plex|duplex|triplex|quadruplex/.test(typeRaw))     type = 'plex';
      else if (/construction|neuve?|new/.test(typeRaw))            type = 'construction_neuve';

      // Extraire numéro Centris de l'URL
      const centrisMatch = listing.match(/\/(\d{7,9})\b/);
      const centrisNum   = centrisMatch?.[1] || data.centris || '';

      // AUTO-CRÉER le deal dans Pipedrive
      let dealResult = null;
      let dealId     = null;
      if (PD_KEY) {
        try {
          const parts = nom.split(' ');
          dealResult = await creerDeal({
            prenom: parts[0], nom: parts.slice(1).join(' '),
            telephone: tel, email, type,
            source: 'centris', centris: centrisNum,
            note: `Lead Centris — ${new Date().toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}\nURL: ${listing}`
          });
          // Récupérer l'ID du deal créé pour le J+0
          const sr = await pdGet(`/deals/search?term=${encodeURIComponent(nom)}&limit=1`);
          dealId = sr?.data?.items?.[0]?.item?.id;
        } catch(e) { dealResult = `⚠️ Erreur deal: ${e.message}`; }
      }

      // Brouillon J+0 automatique
      const typeLabel = { terrain:'terrain', maison_usagee:'propriété', plex:'plex', construction_neuve:'construction neuve' }[type] || 'propriété';
      const j0texte = `Bonjour,\n\nMerci de votre intérêt pour ce ${typeLabel}${centrisNum ? ` (Centris #${centrisNum})` : ''}.\n\nJe communique avec vous pour vous donner plus d'informations et répondre à vos questions. Quand seriez-vous disponible pour qu'on se parle?\n\nAu plaisir,\n${AGENT.prenom}\n${AGENT.telephone}`;

      if (email) {
        pendingEmails.set(ALLOWED_ID, { to: email, toName: nom, sujet: `${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} — ${AGENT.compagnie}`, texte: j0texte });
      }

      let msg = `🏡 *Nouveau lead Centris!*\n\n👤 *${nom}*${tel ? '\n📞 ' + tel : ''}${email ? '\n✉️ ' + email : ''}${listing ? '\n🔗 ' + listing : ''}\nType: ${type}${centrisNum ? ' | #' + centrisNum : ''}\n\n`;
      msg += dealResult ? `${dealResult}\n\n` : '';
      if (email) {
        msg += `📧 *J+0 prêt:*\n_"${j0texte.substring(0, 120)}..."_\n\nDis *"envoie"* pour envoyer maintenant.`;
      } else {
        msg += `⚠️ Pas d'email — appelle directement: ${tel || 'tel non fourni'}`;
      }
      await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' });
    }

    // ── SMS ENTRANT — Match Pipedrive + contexte + brouillon réponse ──────────
    if (route === '/webhook/sms') {
      const from  = data.from || data.numero || '';
      const msg   = data.body || data.message || '';
      const nom   = data.nom || '';

      let contextMsg = `📱 *SMS entrant*\n\nDe: *${nom || from}*\n_"${msg.substring(0, 300)}"_\n\n`;

      // Chercher dans Pipedrive par téléphone ou nom
      let dealContext = '';
      if (PD_KEY && (from || nom)) {
        try {
          const terme = nom || from.replace(/\D/g, '');
          const sr = await pdGet(`/deals/search?term=${encodeURIComponent(terme)}&limit=1`);
          const deal = sr?.data?.items?.[0]?.item;
          if (deal) {
            const stage = PD_STAGES[deal.stage_id] || deal.stage_id;
            dealContext = `📊 *Pipedrive:* ${deal.title} — ${stage}\n\n`;
            // Brouillon réponse rapide
            const reponse = `Bonjour,\n\nMerci pour votre message. Je vous reviens rapidement.\n\nAu plaisir,\n${AGENT.prenom}\n${AGENT.telephone}`;
            if (deal.person_id) {
              const person = await pdGet(`/persons/${deal.person_id}`);
              const emailP = person?.data?.email?.[0]?.value;
              if (emailP) {
                pendingEmails.set(ALLOWED_ID, { to: emailP, toName: deal.title, sujet: 'RE: votre message', texte: reponse });
                dealContext += `📧 Réponse email prête — dis *"envoie"* ou modifie d'abord.\n\n`;
              }
            }
          } else {
            dealContext = `❓ *Pas trouvé dans Pipedrive* — dis "crée prospect ${nom || from}" si nouveau.\n\n`;
          }
        } catch {}
      }

      await bot.sendMessage(ALLOWED_ID, contextMsg + dealContext + `_Dis "voir ${nom || from}" pour le contexte complet._`, { parse_mode: 'Markdown' });

      // Ajouter note Pipedrive si deal trouvé
      if (PD_KEY && (nom || from)) {
        const sr = await pdGet(`/deals/search?term=${encodeURIComponent(nom || from)}&limit=1`).catch(() => null);
        const deal = sr?.data?.items?.[0]?.item;
        if (deal) await pdPost('/notes', { deal_id: deal.id, content: `SMS reçu: "${msg}"` }).catch(() => {});
      }
    }

    // ── REPLY EMAIL — Prospect a répondu → contexte + brouillon ─────────────
    if (route === '/webhook/reply') {
      const de    = data.from || data.email || '';
      const sujet = data.subject || '';
      const corps = (data.body || data.text || '').trim();
      const nom   = data.nom || de.split('@')[0];

      let contextMsg = `📧 *Réponse de prospect!*\n\nDe: *${nom}* (${de})\nObjet: ${sujet}\n\n_"${corps.substring(0, 400)}${corps.length > 400 ? '...' : ''}"_\n\n`;

      // Chercher dans Pipedrive + charger contexte
      let dealContext = '';
      if (PD_KEY && de) {
        try {
          const sr = await pdGet(`/deals/search?term=${encodeURIComponent(nom)}&limit=1`);
          const deal = sr?.data?.items?.[0]?.item;
          if (deal) {
            const stage = PD_STAGES[deal.stage_id] || deal.stage_id;
            dealContext = `📊 *Pipedrive:* ${deal.title} — ${stage}\n`;
            // Avancer l'étape si premier contact
            if (deal.stage_id === 49) {
              await pdPut(`/deals/${deal.id}`, { stage_id: 50 }).catch(() => {});
              dealContext += `➡️ Étape: Nouveau lead → *Contacté* ✅\n`;
            }
            // Ajouter note
            await pdPost('/notes', { deal_id: deal.id, content: `Email reçu [${sujet}]: "${corps.substring(0, 500)}"` }).catch(() => {});
            dealContext += `📝 Note ajoutée dans Pipedrive\n\n`;

            // Brouillon réponse
            const reponse = `Bonjour,\n\nMerci pour votre réponse. Je vous reviens dès que possible.\n\nAu plaisir,\n${AGENT.prenom}\n${AGENT.telephone}`;
            pendingEmails.set(ALLOWED_ID, { to: de, toName: nom, sujet: `RE: ${sujet}`, texte: reponse });
            dealContext += `📧 Brouillon réponse prêt — dis *"envoie"* ou précise ce que tu veux répondre.`;
          } else {
            dealContext = `❓ *${nom}* pas dans Pipedrive.\nDis "crée prospect ${nom}" si c'est un nouveau lead.\n\nBrouillon réponse? Dis "réponds à ${nom}"`;
          }
        } catch(e) { dealContext = `_(Pipedrive: ${e.message.substring(0,80)})_`; }
      }

      await bot.sendMessage(ALLOWED_ID, contextMsg + dealContext, { parse_mode: 'Markdown' });
    }

  } catch (e) { log('ERR', 'WEBHOOK', e.message); }
}

// ─── Arrêt propre ─────────────────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  if (saveTimer) clearTimeout(saveTimer);
  saveJSON(HIST_FILE, Object.fromEntries(chats));
  await saveMemoryToGist().catch(() => {});
  log('OK', 'BOOT', 'Arrêt propre');
  process.exit(0);
});

// ─── HTTP server (health + webhooks) ─────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];

  // ── Health endpoint détaillé (JSON) — observabilité complète ──────────────
  if (req.method === 'GET' && url === '/health') {
    const uptimeS = Math.floor((Date.now() - metrics.startedAt) / 1000);
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime_sec: uptimeS,
      uptime_human: `${Math.floor(uptimeS/3600)}h ${Math.floor((uptimeS%3600)/60)}m`,
      model: currentModel,
      thinking: thinkingMode,
      tools: TOOLS.length,
      mémos: kiramem.facts.length,
      subsystems: {
        pipedrive:  !!PD_KEY,
        brevo:      !!BREVO_KEY,
        gmail:      !!(process.env.GMAIL_CLIENT_ID && gmailToken),
        dropbox:    !!dropboxToken,
        centris:    centrisSession.authenticated,
        github:     !!process.env.GITHUB_TOKEN,
        whisper:    !!process.env.OPENAI_API_KEY,
        gist:       !!gistId,
      },
      metrics,
      circuits: Object.fromEntries(
        Object.entries(circuits).map(([k,v]) => [k, {
          fails: v.fails,
          open:  Date.now() < v.openUntil,
          open_remaining_sec: Math.max(0, Math.ceil((v.openUntil - Date.now())/1000)),
        }])
      ),
      session_live_kb: Math.round((sessionLiveContext?.length||0)/1024),
      dropbox_terrains: dropboxTerrains.length,
      gmail_poller: {
        total_leads: gmailPollerState.totalLeads||0,
        last_run: gmailPollerState.lastRun,
        stats: pollerStats,  // runs + lastScan breakdown + totals + lastError
      },
      cost: {
        today_usd:       Number((costTracker.daily[today()] || 0).toFixed(4)),
        this_month_usd:  Number((costTracker.monthly[thisMonth()] || 0).toFixed(2)),
        total_usd:       Number(costTracker.total.toFixed(2)),
        by_model:        Object.fromEntries(Object.entries(costTracker.byModel).map(([k,v])=>[k, Number(v.toFixed(2))])),
      },
      webhook_health: global.__webhookHealth || { status: 'not_initialized' },
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health, null, 2));
    return;
  }

  // ── Dashboard HTML — stats temps réel avec branding Signature SB ──────────
  if (req.method === 'GET' && url === '/dashboard') {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized — add ?token=WEBHOOK_SECRET');
      return;
    }
    const uptimeS = Math.floor((Date.now() - metrics.startedAt) / 1000);
    const pollerLast = gmailPollerState.lastRun ? new Date(gmailPollerState.lastRun) : null;
    const minsAgo = pollerLast ? Math.floor((Date.now() - pollerLast.getTime()) / 60000) : null;
    const autoStats = {
      total: autoEnvoiState.totalAuto || 0,
      fails: autoEnvoiState.totalFails || 0,
      rate: ((autoEnvoiState.totalAuto||0) + (autoEnvoiState.totalFails||0)) > 0
        ? Math.round(100 * (autoEnvoiState.totalAuto||0) / ((autoEnvoiState.totalAuto||0) + (autoEnvoiState.totalFails||0)))
        : 0,
    };
    const recent = (autoEnvoiState.log || []).slice(0, 10);
    const avgMs = recent.filter(l => l.success).reduce((s, l, _, a) => s + (l.deliveryMs||0)/(a.length||1), 0);
    const pollerHealth = minsAgo === null ? '⚪ jamais' : minsAgo > 10 ? `🔴 ${minsAgo}min` : `🟢 ${minsAgo}min`;
    const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dashboard — Signature SB Bot</title><style>
body{margin:0;background:#0a0a0a;color:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',Arial,sans-serif;padding:16px;}
.container{max-width:900px;margin:0 auto}
.header{border-bottom:3px solid #aa0721;padding:20px 0;margin-bottom:24px}
.header h1{margin:0;font-size:22px;letter-spacing:2px;text-transform:uppercase}
.header .sub{color:#888;font-size:12px;margin-top:6px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:24px}
.card{background:#111;border:1px solid #1e1e1e;border-left:3px solid #aa0721;border-radius:4px;padding:16px 18px}
.card .label{color:#888;font-size:10px;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px}
.card .value{font-family:Georgia,serif;font-size:32px;font-weight:700;line-height:1}
.card .sub{color:#aaa;font-size:12px;margin-top:6px}
.green{color:#34c759}
.red{color:#ff3b30}
.yellow{color:#ffcc00}
h2{color:#aa0721;font-size:11px;text-transform:uppercase;letter-spacing:3px;margin:24px 0 12px;border-bottom:1px solid #1e1e1e;padding-bottom:8px}
.log{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:4px;padding:14px;font-family:'SF Mono',Menlo,monospace;font-size:12px;line-height:1.7}
.log .ok{color:#34c759}
.log .fail{color:#ff3b30}
.footer{margin-top:40px;padding-top:16px;border-top:1px solid #1e1e1e;color:#666;font-size:11px;text-align:center}
</style></head><body><div class="container">
<div class="header"><h1>Signature SB — Dashboard Bot</h1><div class="sub">Temps réel · ${new Date().toLocaleString('fr-CA',{timeZone:'America/Toronto'})}</div></div>
<h2>🚀 Auto-envoi docs</h2>
<div class="grid">
  <div class="card"><div class="label">Total envoyés</div><div class="value green">${autoStats.total}</div><div class="sub">depuis démarrage</div></div>
  <div class="card"><div class="label">Échecs</div><div class="value ${autoStats.fails > 0 ? 'red' : ''}">${autoStats.fails}</div><div class="sub">après 3 retries</div></div>
  <div class="card"><div class="label">Taux succès</div><div class="value ${autoStats.rate >= 90 ? 'green' : autoStats.rate >= 70 ? 'yellow' : 'red'}">${autoStats.rate}%</div><div class="sub">global</div></div>
  <div class="card"><div class="label">Temps moyen</div><div class="value">${Math.round(avgMs/1000)}s</div><div class="sub">lead → docs envoyés</div></div>
</div>
<h2>📧 Gmail Poller</h2>
<div class="grid">
  <div class="card"><div class="label">Leads traités</div><div class="value">${gmailPollerState.totalLeads || 0}</div><div class="sub">total depuis boot</div></div>
  <div class="card"><div class="label">Dernier scan</div><div class="value" style="font-size:16px">${pollerHealth}</div><div class="sub">scan toutes les 5min</div></div>
  <div class="card"><div class="label">IDs mémorisés</div><div class="value" style="font-size:24px">${(gmailPollerState.processed||[]).length}</div><div class="sub">anti-doublon</div></div>
  <div class="card"><div class="label">Uptime bot</div><div class="value" style="font-size:18px">${Math.floor(uptimeS/3600)}h ${Math.floor((uptimeS%3600)/60)}m</div></div>
</div>
<h2>🏠 Pipeline</h2>
<div class="grid">
  <div class="card"><div class="label">Dropbox</div><div class="value" style="font-size:24px">${dropboxTerrains.length}</div><div class="sub">dossiers terrain en cache</div></div>
  <div class="card"><div class="label">Modèle IA</div><div class="value" style="font-size:16px">${currentModel.replace('claude-','')}</div><div class="sub">thinking: ${thinkingMode}</div></div>
  <div class="card"><div class="label">Tools actifs</div><div class="value">${TOOLS.length}</div><div class="sub">Pipedrive · Gmail · Dropbox</div></div>
  <div class="card"><div class="label">Mémos Kira</div><div class="value">${kiramem.facts.length}</div></div>
</div>
<h2>📋 10 derniers auto-envois</h2>
<div class="log">${recent.length === 0 ? '<span style="color:#666">Aucun auto-envoi encore</span>' : recent.map(l => {
  const when = new Date(l.timestamp).toLocaleString('fr-CA',{timeZone:'America/Toronto',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
  return l.success
    ? `<span class="ok">✅</span> <span style="color:#888">${when}</span> · <strong>${l.email}</strong> · ${l.pdfsCount} PDFs · ${l.strategy}(${l.score}) · ${Math.round(l.deliveryMs/1000)}s`
    : `<span class="fail">❌</span> <span style="color:#888">${when}</span> · ${l.email} · ${String(l.error).substring(0, 80)}`;
}).join('<br>')}</div>
<div class="footer">Signature SB · Bot Kira · auto-refresh manuel · <a href="/health" style="color:#aa0721">/health JSON</a></div>
</div></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`Assistant SignatureSB OK — ${new Date().toISOString()} — tools:${TOOLS.length} — mémos:${kiramem.facts.length}`);
    return;
  }

  // ── Admin endpoints — protégés par WEBHOOK_SECRET (accès assistant) ──────
  if (req.method === 'GET' && url === '/admin/chat-history') {
    const token = (req.url || '').split('token=')[1]?.split('&')[0];
    if (!process.env.WEBHOOK_SECRET || token !== process.env.WEBHOOK_SECRET) {
      res.writeHead(401); res.end('unauthorized'); return;
    }
    const history = getHistory(ALLOWED_ID).slice(-30).map(m => ({
      role: m.role,
      // Truncate pour éviter payloads énormes
      content: typeof m.content === 'string' ? m.content.substring(0, 2000) : JSON.stringify(m.content).substring(0, 2000),
      ts: m.ts,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ history, total: getHistory(ALLOWED_ID).length, audit: auditLog.slice(-20) }, null, 2));
    return;
  }

  // ── Webhook Telegram — PROTÉGÉ par X-Telegram-Bot-Api-Secret-Token ───────
  // Sans ce header, n'importe qui peut injecter des commandes dans le bot.
  // Le secret est configuré côté Telegram via setWebhook(secret_token).
  if (req.method === 'POST' && url === '/webhook/telegram') {
    const tgSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const provided = req.headers['x-telegram-bot-api-secret-token'];
    if (tgSecret && provided !== tgSecret) {
      log('WARN', 'SECURITY', `Webhook Telegram — bad/missing secret-token from ${req.socket.remoteAddress}`);
      res.writeHead(401); res.end('unauthorized'); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200); res.end('ok');
      try {
        const update = JSON.parse(body || '{}');
        bot.processUpdate(update);
      } catch (e) { log('WARN', 'TG', `processUpdate: ${e.message}`); }
    });
    return;
  }

  // ── Webhook GitHub — PROTÉGÉ par HMAC SHA-256 signature ──────────────────
  if (req.method === 'POST' && url === '/webhook/github') {
    const ghSecret = process.env.GITHUB_WEBHOOK_SECRET;
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 100000) req.destroy(); });
    req.on('end', async () => {
      if (ghSecret) {
        const crypto = require('crypto');
        const sig = req.headers['x-hub-signature-256'] || '';
        const expected = 'sha256=' + crypto.createHmac('sha256', ghSecret).update(body).digest('hex');
        if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
          log('WARN', 'SECURITY', `Webhook GitHub — bad/missing HMAC from ${req.socket.remoteAddress}`);
          res.writeHead(401); res.end('unauthorized'); return;
        }
      }
      res.writeHead(200); res.end('ok');
      try {
        const event = req.headers['x-github-event'] || '';
        const data  = JSON.parse(body || '{}');
        if (event === 'push' && data.ref === 'refs/heads/main') {
          log('OK', 'WEBHOOK', `GitHub push → rechargement SESSION_LIVE.md (${data.commits?.length||0} commits)`);
          await loadSessionLiveContext();
          logActivity(`Sync GitHub: ${data.commits?.length||0} commits — SESSION_LIVE rechargé`);
        }
      } catch (e) { log('WARN', 'WEBHOOK', `GitHub: ${e.message}`); }
    });
    return;
  }

  if (req.method === 'POST' && ['/webhook/centris', '/webhook/sms', '/webhook/reply'].includes(url)) {
    // Rate limiting par IP — anti-abuse (20 req/min max)
    if (!webhookRateOK(req.socket.remoteAddress, url)) {
      log('WARN', 'SECURITY', `Rate limit hit: ${req.socket.remoteAddress} → ${url}`);
      res.writeHead(429); res.end('too many requests'); return;
    }
    const wSecret = process.env.WEBHOOK_SECRET;
    // OBLIGATOIRE — pas d'auth optionnelle sur webhooks publics
    if (!wSecret) {
      log('ERR', 'SECURITY', 'WEBHOOK_SECRET manquant — webhooks rejetés par sécurité');
      res.writeHead(503); res.end('webhook secret not configured'); return;
    }
    const provided = req.headers['x-webhook-secret'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '');
    if (provided !== wSecret) {
      log('WARN', 'SECURITY', `Webhook ${url} — bad secret from ${req.socket.remoteAddress}`);
      res.writeHead(401); res.end('unauthorized'); return;
    }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 50000) req.destroy(); });
    req.on('end', async () => {
      try {
        const data = JSON.parse(body || '{}');
        res.writeHead(200); res.end('ok');
        if (url === '/webhook/centris') mTick('leads');
        await handleWebhook(url, data);
      } catch {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

// ─── Gmail Lead Poller — surveille les emails entrants toutes les 5min ────────
let gmailPollerState = loadJSON(POLLER_FILE, { processed: [], lastRun: null, totalLeads: 0 });

// Sources d'emails → leads immobiliers
// Lead parsing — extrait dans lead_parser.js pour testabilité
const { detectLeadSource, isJunkLeadEmail, parseLeadEmail, parseLeadEmailWithAI } = leadParser;

// ── Dédoublonnage multi-clé, persisté disque (survit aux redeploys) ─────────
// Indexe par: email (exact, lower-case), téléphone (10 derniers chiffres),
// centris# (normalisé), signature nom+source. TTL 7 jours.
const LEADS_DEDUP_FILE = path.join(DATA_DIR, 'leads_dedup.json');
const recentLeadsByKey = new Map(Object.entries(loadJSON(LEADS_DEDUP_FILE, {})));
function saveLeadsDedup() { saveJSON(LEADS_DEDUP_FILE, Object.fromEntries(recentLeadsByKey)); if (typeof schedulePollerSave === 'function') schedulePollerSave(); }

function normalizePhone(p) {
  return String(p || '').replace(/\D/g, '').slice(-10); // 10 derniers chiffres
}
function normalizeName(n) {
  return String(n || '').toLowerCase().trim().replace(/\s+/g, ' ').replace(/[^a-zà-ü\s]/gi, '');
}
function buildLeadKeys({ email, telephone, centris, nom, source }) {
  const keys = [];
  if (email)             keys.push('e:' + email.toLowerCase().trim());
  const p = normalizePhone(telephone);
  if (p && p.length >= 10) keys.push('t:' + p);
  if (centris)           keys.push('c:' + String(centris).replace(/\D/g, ''));
  const n = normalizeName(nom);
  if (n && source)       keys.push('ns:' + n + ':' + source);
  return keys;
}

function leadAlreadyNotifiedRecently(emailOrLead, telephone, centris, nom, source) {
  // Support 2 signatures: (email, phone) legacy OU ({email, telephone, centris, nom, source}) nouveau
  const lead = typeof emailOrLead === 'object' ? emailOrLead : { email: emailOrLead, telephone, centris, nom, source };
  const now = Date.now();
  const TTL = 7 * 24 * 60 * 60 * 1000;
  // Purge expired
  for (const [k, t] of recentLeadsByKey) {
    if (now - t > TTL) recentLeadsByKey.delete(k);
  }
  const keys = buildLeadKeys(lead);
  if (keys.length === 0) return false; // aucune clé utile → ne bloque pas
  for (const k of keys) {
    if (recentLeadsByKey.has(k)) {
      log('INFO', 'DEDUP', `Lead match: ${k} (vu ${Math.round((now-recentLeadsByKey.get(k))/60000)}min ago)`);
      return true;
    }
  }
  // Marque toutes les clés pour bloquer futures occurrences même partielles
  for (const k of keys) recentLeadsByKey.set(k, now);
  saveLeadsDedup();
  return false;
}

async function traiterNouveauLead(lead, msgId, from, subject, source) {
  const { nom, telephone, email, centris, adresse, type } = lead;

  // DÉDUP multi-clé 7j — email OU tel OU centris# OU (nom+source) = skip
  if (leadAlreadyNotifiedRecently({ email, telephone, centris, nom, source: source.source })) {
    log('INFO', 'POLLER', `Dédup 7j: lead ${nom || email || telephone || centris} déjà notifié — skip`);
    return;
  }

  log('OK', 'POLLER', `Lead ${source.label}: ${nom || email || telephone} | Centris: ${centris || '?'}`);

  // 1. Créer deal Pipedrive
  let dealTxt = '';
  let dealId  = null;
  if (PD_KEY) {
    try {
      const noteBase = [
        `Lead ${source.label} reçu le ${new Date().toLocaleString('fr-CA', { timeZone: 'America/Toronto' })}`,
        adresse ? `Propriété: ${adresse}` : '',
        centris ? `Centris: #${centris}` : '',
        `Email source: ${from}`,
        `Sujet: ${subject}`,
      ].filter(Boolean).join('\n');

      dealTxt = await creerDeal({
        prenom: nom?.split(' ')[0] || nom || '',
        nom:    nom?.split(' ').slice(1).join(' ') || '',
        telephone, email, type, source: source.source, centris,
        note: noteBase,
      });

      // Récupérer l'ID du deal créé
      const sr = await pdGet(`/deals/search?term=${encodeURIComponent(nom || email || telephone)}&limit=1`);
      dealId = sr?.data?.items?.[0]?.item?.id;
    } catch (e) { dealTxt = `⚠️ Deal: ${e.message.substring(0, 80)}`; }
  }

  // 2. Matching Dropbox AVANCÉ (4 stratégies) + auto-envoi si score ≥90
  let docsTxt = '';
  let j0Brouillon = null;
  let autoEnvoiMsg = '';

  let dbxMatch = null;
  if (centris || adresse) {
    try { dbxMatch = await matchDropboxAvance(centris, adresse); } catch (e) { log('WARN', 'POLLER', `Match: ${e.message}`); }
  }

  if (dbxMatch?.folder) {
    docsTxt = `📁 Match Dropbox: *${dbxMatch.folder.adresse || dbxMatch.folder.name}* (${dbxMatch.strategy}, score ${dbxMatch.score}, ${dbxMatch.pdfs.length} PDF${dbxMatch.pdfs.length > 1 ? 's' : ''})`;
  } else if (dbxMatch?.candidates?.length) {
    docsTxt = `📁 Candidats Dropbox: ${dbxMatch.candidates.map(c => `${c.folder.adresse || c.folder.name} (${c.score})`).join(', ')}`;
  }

  // AUTO-ENVOI — flow 3 seuils (validé par Shawn 2026-04-22):
  //   Score ≥90  → envoi automatique direct (très confiant du match)
  //   Score 80-89→ notif AVANT, attend confirmation "envoie" (zone d'incertitude)
  //   Score <80  → brouillon seulement
  // Conditions pré-requises: email + nom + (téléphone OU centris#) = 3 infos min
  // Dédup 7j garantit zéro doublon de tout ce flow.
  let dealFullObj = null;
  if (dealId) {
    try { dealFullObj = (await pdGet(`/deals/${dealId}`))?.data; } catch {}
  }
  const hasMinInfo = !!(email && nom && (telephone || centris));
  const hasMatch   = dbxMatch?.folder && dbxMatch.pdfs.length > 0;

  if (hasMinInfo && hasMatch && dealFullObj && dbxMatch.score >= 90 && !autoSendPaused) {
    // ✅ AUTO-ENVOI — très confiant du match Dropbox
    try {
      const autoRes = await envoyerDocsAuto({
        email, nom, centris, dealId, deal: dealFullObj, match: dbxMatch,
      });
      if (autoRes.sent) {
        autoEnvoiMsg = `\n🚀 *Docs envoyés auto* à ${email}\n   ${dbxMatch.pdfs.length} PDFs · match "${dbxMatch.folder.adresse||dbxMatch.folder.name}" · score ${dbxMatch.score} · ${Math.round(autoRes.deliveryMs/1000)}s${autoRes.attempt > 1 ? ` (${autoRes.attempt} tentatives)` : ''}`;
        auditLogEvent('auto-send', 'docs-sent', { email, centris, score: dbxMatch.score, pdfs: dbxMatch.pdfs.length, ms: autoRes.deliveryMs });
      } else if (autoRes.skipped) {
        autoEnvoiMsg = `\n⏭ Auto-envoi skip: ${autoRes.reason}`;
      } else {
        autoEnvoiMsg = `\n⚠️ *Auto-envoi ÉCHOUÉ* après ${autoRes.attempts} tentatives: ${String(autoRes.error).substring(0, 120)}\n   Envoie manuellement: \`envoie les docs à ${email}\``;
        pendingDocSends.set(email, { email, nom, centris, dealId, deal: dealFullObj, match: dbxMatch });
        auditLogEvent('auto-send', 'docs-failed', { email, error: String(autoRes.error).substring(0, 200) });
      }
    } catch (e) {
      autoEnvoiMsg = `\n⚠️ Auto-envoi exception: ${e.message.substring(0, 100)}`;
      pendingDocSends.set(email, { email, nom, centris, dealId, deal: dealFullObj, match: dbxMatch });
    }
  } else if (hasMinInfo && hasMatch && dbxMatch.score >= 80) {
    // 🤔 ZONE D'INCERTITUDE 80-89 — confirmer avant envoi
    pendingDocSends.set(email, { email, nom, centris, dealId, deal: dealFullObj, match: dbxMatch });
    autoEnvoiMsg = `\n🤔 *Match à confirmer* — score ${dbxMatch.score}/100 (zone d'incertitude)\n` +
                   `   Dossier Dropbox: *${dbxMatch.folder.adresse || dbxMatch.folder.name}*\n` +
                   `   ${dbxMatch.pdfs.length} PDFs prêts\n` +
                   `   ✅ Dis \`envoie les docs à ${email}\` pour livrer\n` +
                   `   ❌ Dis \`annule ${email}\` pour ignorer`;
  } else if (email && hasMatch) {
    // Score <80 ou infos incomplètes — brouillon seulement
    pendingDocSends.set(email, { email, nom, centris, dealId, deal: dealFullObj, match: dbxMatch });
    const why = !hasMinInfo ? `infos incomplètes (${[nom?'nom':null, email?'email':null, (telephone||centris)?'contact':null].filter(Boolean).join('+') || 'rien'})` : `score faible ${dbxMatch.score}`;
    autoEnvoiMsg = `\n📦 *Docs en attente* (${why})\n   Vérifie et dis \`envoie les docs à ${email}\` si OK`;
  } else if (email && dbxMatch?.candidates?.length) {
    autoEnvoiMsg = `\n🔍 Plusieurs candidats Dropbox — check lequel est le bon avant d'envoyer`;
  }

  // Préparer brouillon J+0
  const prospectNom   = nom || (email?.split('@')[0]) || 'Madame/Monsieur';
  const typeLabel     = { terrain:'terrain', maison_usagee:'propriété', plex:'plex', construction_neuve:'construction neuve' }[type] || 'propriété';
  const j0Texte = `Bonjour,\n\nMerci de votre intérêt${centris ? ` pour la propriété Centris #${centris}` : adresse ? ` pour la propriété au ${adresse}` : ''}.\n\nJ'aimerais vous contacter pour vous donner plus d'informations et répondre à vos questions. Quand seriez-vous disponible pour qu'on se parle?\n\nAu plaisir,\n${AGENT.prenom}\n${AGENT.telephone}`;

  // Si email dispo → stocker brouillon (Shawn dit "envoie")
  if (email) {
    const sujetJ0 = centris
      ? `Centris #${centris} — ${AGENT.compagnie}`
      : `Votre demande — ${AGENT.compagnie}`;
    j0Brouillon = { to: email, toName: prospectNom, sujet: sujetJ0, texte: j0Texte };
    pendingEmails.set(ALLOWED_ID, j0Brouillon);
  }

  // 3. Notifier Shawn immédiatement
  if (!ALLOWED_ID) return;
  let msg = `🔔 *Nouveau lead ${source.label}!*\n\n`;
  if (nom)       msg += `👤 *${nom}*\n`;
  if (telephone) msg += `📞 ${telephone}\n`;
  if (email)     msg += `✉️ ${email}\n`;
  if (adresse)   msg += `📍 ${adresse}\n`;
  if (centris)   msg += `🏡 Centris #${centris}\n`;
  msg += `\n${dealTxt || '⚠️ Pipedrive non configuré'}\n`;
  if (docsTxt) msg += `\n${docsTxt}\n`;
  if (autoEnvoiMsg) msg += autoEnvoiMsg;
  if (j0Brouillon) {
    msg += `\n📧 *Brouillon J+0 prêt* — dis *"envoie"* pour l'envoyer à ${email}`;
  } else if (!email) {
    msg += `\n⚠️ Pas d'email — appelle directement: ${telephone || '(non fourni)'}`;
  }

  await bot.sendMessage(ALLOWED_ID, msg, { parse_mode: 'Markdown' }).catch(e => {
    log('WARN', 'POLLER', `Telegram notify: ${e.message}`);
    bot.sendMessage(ALLOWED_ID, msg.replace(/\*/g, '').replace(/_/g, '')).catch(() => {});
  });
}

// Stats poller (pour /health + debug P0)
// ── Health check proactif Anthropic — ping Haiku léger toutes les 6h pour
// détecter crédit bas / clé révoquée AVANT qu'un vrai appel échoue.
// Si fail → alerte Telegram proactive avec action (déjà codée dans formatAPIError)
async function anthropicHealthCheck() {
  if (!API_KEY) return;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 5, messages: [{ role: 'user', content: 'ok' }] }),
    });
    clearTimeout(t);
    if (!res.ok) {
      const body = await res.text();
      const err = { status: res.status, message: `${res.status} ${body.substring(0, 200)}` };
      log('WARN', 'HEALTH', `Anthropic ping: ${err.message.substring(0, 120)}`);
      // formatAPIError détecte credit/auth et alerte Telegram avec cooldown 30min
      formatAPIError(err);
      metrics.lastApiError = { at: new Date().toISOString(), status: res.status, message: err.message.substring(0, 300) };
    } else {
      log('OK', 'HEALTH', 'Anthropic OK (healthcheck Haiku)');
      // Succès → effacer lastApiError si était credit/auth (problème résolu)
      if (metrics.lastApiError && /credit|billing|authentication|invalid.*key/i.test(metrics.lastApiError.message || '')) {
        log('OK', 'HEALTH', '🎉 Anthropic retour à la normale — clear lastApiError');
        metrics.lastApiError = null;
        if (ALLOWED_ID) {
          bot.sendMessage(ALLOWED_ID, '✅ *Anthropic est de retour*\nLe bot a récupéré l\'accès Claude. Tout reprend normalement.', { parse_mode: 'Markdown' }).catch(() => {});
        }
      }
    }
  } catch (e) {
    log('WARN', 'HEALTH', `Anthropic ping exception: ${e.message}`);
  }
}

const pollerStats = {
  runs: 0,
  lastRun: null,
  lastDuration: 0,
  lastError: null,
  lastScan: { found: 0, junk: 0, noSource: 0, lowInfo: 0, dealCreated: 0, errors: 0 },
  totalsFound: 0, totalsJunk: 0, totalsNoSource: 0, totalsLowInfo: 0, totalsDealCreated: 0, totalsErrors: 0,
};

// ── baselineSilentAtBoot — marque tous les leads 7 derniers jours comme
// déjà vus SANS notifier. Appelé au boot si processed[] vide.
async function baselineSilentAtBoot() {
  const token = await getGmailToken();
  if (!token) return;
  const shawnEmail = AGENT.email.toLowerCase();
  const queries = [
    `newer_than:7d from:centris NOT from:${shawnEmail}`,
    `newer_than:7d from:remax NOT from:${shawnEmail}`,
    `newer_than:7d from:realtor NOT from:${shawnEmail}`,
    `newer_than:7d from:duproprio NOT from:${shawnEmail}`,
    `newer_than:7d subject:(demande OR "intéress" OR inquiry) NOT from:${shawnEmail}`,
  ];
  let marked = 0;
  const seen = new Set();
  for (const q of queries) {
    const list = await gmailAPI(`/messages?maxResults=50&q=${encodeURIComponent(q)}`).catch(() => null);
    if (!list?.messages?.length) continue;
    for (const m of list.messages) {
      if (seen.has(m.id) || gmailPollerState.processed.includes(m.id)) continue;
      seen.add(m.id);
      gmailPollerState.processed.push(m.id);
      marked++;
      try {
        const full = await gmailAPI(`/messages/${m.id}?format=full`).catch(() => null);
        if (full) {
          const hdrs = full.payload?.headers || [];
          const get = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
          const from    = get('from');
          const subject = get('subject');
          const body    = gmailExtractBody(full.payload);
          if (!isJunkLeadEmail(subject, from, body)) {
            const source = detectLeadSource(from, subject);
            if (source) {
              const lead = parseLeadEmail(body, subject, from);
              leadAlreadyNotifiedRecently({
                email: lead.email, telephone: lead.telephone, centris: lead.centris,
                nom: lead.nom, source: source.source,
              });
            }
          }
        }
      } catch {}
    }
  }
  gmailPollerState.lastRun = new Date().toISOString();
  if (gmailPollerState.processed.length > 500) gmailPollerState.processed = gmailPollerState.processed.slice(-500);
  saveJSON(POLLER_FILE, gmailPollerState);
  schedulePollerSave(); // → Gist
  log('OK', 'BOOT', `Baseline silencieux: ${marked} leads marqués, ${recentLeadsByKey.size} dédup entries`);
}

// ── autoTrashGitHubNoise — supprime auto les emails notifications GitHub/Dependabot/CI
// Shawn ne veut plus être notifié par courriel — le bot nettoie tout seul.
// Run: 30s après boot + cron quotidien 6h (+ manuel via /cleanemail)
async function autoTrashGitHubNoise(opts = {}) {
  try {
    const token = await getGmailToken();
    if (!token) return { trashed: 0, skipped: 'no_gmail' };

    const maxAge = opts.maxAge || '30d';
    // Tous les emails GitHub/Dependabot/CI (notifs, PR, run failed, workflow)
    const query = [
      '(',
      'from:notifications@github.com',
      'OR from:noreply@github.com',
      'OR cc:ci_activity@noreply.github.com',
      'OR cc:push@noreply.github.com',
      'OR cc:state_change@noreply.github.com',
      'OR cc:comment@noreply.github.com',
      ')',
      `newer_than:${maxAge}`,
      '-in:trash',
    ].join(' ');

    const list = await gmailAPI(`/messages?maxResults=100&q=${encodeURIComponent(query)}`);
    if (!list?.messages?.length) return { trashed: 0 };

    let trashed = 0;
    for (const m of list.messages) {
      try {
        await gmailAPI(`/messages/${m.id}/trash`, { method: 'POST' });
        trashed++;
        await new Promise(r => setTimeout(r, 200)); // éviter rate limit
      } catch (e) {
        log('WARN', 'CLEANUP', `trash ${m.id}: ${e.message.substring(0, 80)}`);
      }
    }
    log('OK', 'CLEANUP', `Auto-trashed ${trashed} emails GitHub/CI`);
    return { trashed };
  } catch (e) {
    log('WARN', 'CLEANUP', `autoTrashGitHubNoise: ${e.message}`);
    return { trashed: 0, error: e.message };
  }
}

// ── runGmailLeadPoller — BULLETPROOF (2026-04-22)
// Principe: AUCUN lead client ne doit passer inaperçu.
// - Scan SANS is:unread (dédup via processed[] state)
// - 24h fenêtre au boot (pas 6h)
// - Alert Telegram P0 si email match source mais deal non créé (bug detection)
// - Logging structuré par étape
async function runGmailLeadPoller(opts = {}) {
  const t0 = Date.now();

  // CIRCUIT BREAKER CRÉDIT: si Anthropic a retourné credit/auth error dans les
  // dernières 30min, SKIP le poller. Évite le spam de leads + save argent
  // pendant que Shawn règle son crédit. Auto-resume dès que crédit OK.
  if (metrics.lastApiError && !opts.force) {
    const age = Date.now() - new Date(metrics.lastApiError.at).getTime();
    const msg = metrics.lastApiError.message || '';
    if (age < 30 * 60 * 1000 && /credit|billing|insufficient|authentication|invalid.*key/i.test(msg)) {
      log('INFO', 'POLLER', `Skip — Anthropic down (${Math.round(age/60000)}min ago): ${msg.substring(0, 80)}`);
      return;
    }
  }

  pollerStats.runs++;
  const scan = { found: 0, junk: 0, noSource: 0, lowInfo: 0, dealCreated: 0, errors: 0 };
  const problems = []; // emails qui matchent mais n'ont pas abouti — pour alerte P0
  try {
    const token = await getGmailToken();
    if (!token) { pollerStats.lastError = 'gmail_token_unavailable'; return; }

    // Force scan 48h si demandé explicitement (/checkemail ou /forcelead)
    const since = opts.forceSince
      ? opts.forceSince
      : (gmailPollerState.lastRun
          ? Math.max(1, Math.ceil((Date.now() - new Date(gmailPollerState.lastRun).getTime()) / 60000) + 2) + 'm'
          : '24h'); // Au boot: 24h (pas 6h — laisser de la marge pour emails manqués)

    // Queries SANS is:unread — emails lus scannés aussi (dédup via processed[])
    // Plusieurs queries ciblées + un catch-all pour robustesse
    const shawnEmail = AGENT.email.toLowerCase();
    const queries = [
      `newer_than:${since} from:centris NOT from:${shawnEmail}`,
      `newer_than:${since} from:remax NOT from:${shawnEmail}`,
      `newer_than:${since} from:realtor NOT from:${shawnEmail}`,
      `newer_than:${since} from:duproprio NOT from:${shawnEmail}`,
      // Catch-all: demande dans subject, pas d'une source auto
      `newer_than:${since} subject:(demande OR "intéress" OR inquiry OR "prospect") NOT from:${shawnEmail} NOT from:noreply@signaturesb NOT from:notifications@github`,
    ];

    let newLeads = 0;
    const processedThisRun = new Set();
    const singleId = opts.singleMsgId || null;

    // Mode forcelead: traiter 1 msgId spécifique, bypass queries
    const msgIds = singleId ? [{ id: singleId }] : null;

    for (const q of (msgIds ? [null] : queries)) {
      let list;
      if (msgIds) {
        list = { messages: msgIds };
      } else {
        try {
          list = await gmailAPI(`/messages?maxResults=25&q=${encodeURIComponent(q)}`);
        } catch (e) {
          scan.errors++;
          log('WARN', 'POLLER', `Query fail [${q.substring(0,40)}]: ${e.message}`);
          continue;
        }
      }
      if (!list?.messages?.length) continue;
      scan.found += list.messages.length;

      for (const msgRef of list.messages) {
        const id = msgRef.id;
        // En mode forcelead, on bypass le dédup pour forcer le retraitement
        if (!singleId && (gmailPollerState.processed.includes(id) || processedThisRun.has(id))) continue;
        processedThisRun.add(id);

        try {
          const full = await gmailAPI(`/messages/${id}?format=full`);
          const hdrs = full.payload?.headers || [];
          const get  = n => hdrs.find(h => h.name.toLowerCase() === n)?.value || '';
          const from    = get('from');
          const subject = get('subject');
          const body    = gmailExtractBody(full.payload);

          // Ignorer les emails de Shawn lui-même
          if (from.toLowerCase().includes(shawnEmail)) {
            gmailPollerState.processed.push(id); continue;
          }

          // FILTRE JUNK — rejette newsletters, alertes saved-search, notifications
          if (isJunkLeadEmail(subject, from, body)) {
            scan.junk++;
            log('INFO', 'POLLER', `Junk: ${subject.substring(0, 60)} (${from.substring(0, 40)})`);
            gmailPollerState.processed.push(id); continue;
          }

          const source = detectLeadSource(from, subject);
          if (!source) { scan.noSource++; gmailPollerState.processed.push(id); continue; }

          let lead = parseLeadEmail(body, subject, from);
          let infoCount = [lead.nom, lead.email, lead.telephone, lead.centris, lead.adresse].filter(Boolean).length;

          // AI FALLBACK — si regex extrait <3 infos, appel Claude Haiku pour extraction structurée
          // Seuil augmenté à <3 (était <2) pour être plus safe
          if (infoCount < 3 && API_KEY) {
            log('INFO', 'POLLER', `Regex ${infoCount} infos — AI fallback pour "${subject.substring(0,50)}"`);
            try {
              lead = await parseLeadEmailWithAI(body, subject, from, lead, { apiKey: API_KEY, logger: log });
              infoCount = [lead.nom, lead.email, lead.telephone, lead.centris, lead.adresse].filter(Boolean).length;
            } catch (e) { log('WARN', 'POLLER', `AI fallback: ${e.message}`); }
          }

          // VALIDATION lead viable — minimum 2 infos OU Centris# seul suffit
          if (infoCount < 2 && !lead.centris) {
            scan.lowInfo++;
            // ⚠ ALERTE P0: email match source (Centris/RE/MAX) mais extraction insuffisante = BUG probable
            problems.push({ id, subject, from, source: source.label, reason: `${infoCount} info extraites après AI fallback` });
            log('WARN', 'POLLER', `Lead non viable: "${subject.substring(0, 50)}" (${source.label}) — PROBLÈME P0`);
            gmailPollerState.processed.push(id); continue;
          }

          await traiterNouveauLead(lead, id, from, subject, source);
          gmailPollerState.processed.push(id);
          gmailPollerState.totalLeads = (gmailPollerState.totalLeads || 0) + 1;
          scan.dealCreated++;
          newLeads++;
          await new Promise(r => setTimeout(r, 1500));
        } catch (e) {
          scan.errors++;
          problems.push({ id, subject: 'N/A', from: 'N/A', source: 'N/A', reason: `Exception: ${e.message.substring(0, 100)}` });
          log('WARN', 'POLLER', `msg ${id}: ${e.message}`);
          gmailPollerState.processed.push(id);
        }
      }
    }

    // FIFO max 500 IDs
    if (gmailPollerState.processed.length > 500) {
      gmailPollerState.processed = gmailPollerState.processed.slice(-500);
    }
    gmailPollerState.lastRun = new Date().toISOString();
    saveJSON(POLLER_FILE, gmailPollerState); schedulePollerSave();

    // Update stats globales
    pollerStats.lastScan = scan;
    pollerStats.totalsFound      += scan.found;
    pollerStats.totalsJunk       += scan.junk;
    pollerStats.totalsNoSource   += scan.noSource;
    pollerStats.totalsLowInfo    += scan.lowInfo;
    pollerStats.totalsDealCreated+= scan.dealCreated;
    pollerStats.totalsErrors     += scan.errors;
    pollerStats.lastRun = new Date().toISOString();
    pollerStats.lastDuration = Date.now() - t0;
    pollerStats.lastError = null;

    // ALERTE P0 Telegram: leads potentiels manqués
    // Skip si Anthropic est down (crédit/auth) — ce n'est pas une vraie anomalie parser
    const anthropicDown = metrics.lastApiError &&
      Date.now() - new Date(metrics.lastApiError.at).getTime() < 30 * 60 * 1000 &&
      /credit|billing|authentication|invalid.*key/i.test(metrics.lastApiError.message || '');
    if (problems.length && ALLOWED_ID && !anthropicDown) {
      const lines = problems.slice(0, 5).map(p =>
        `• [${p.source}] ${p.subject.substring(0, 60)} — ${p.reason}`
      );
      const alertMsg = [
        `🚨 *P0 — ${problems.length} lead(s) potentiellement manqué(s)*`,
        ``,
        ...lines,
        ``,
        `Dis \`/forcelead ${problems[0].id}\` pour forcer le retraitement du premier.`,
        `Ou vérifie Gmail directement.`,
      ].join('\n');
      bot.sendMessage(ALLOWED_ID, alertMsg, { parse_mode: 'Markdown' }).catch(() => {
        bot.sendMessage(ALLOWED_ID, alertMsg.replace(/[*_`]/g, '')).catch(() => {});
      });
    }

    if (newLeads > 0) {
      log('OK', 'POLLER', `Scan: ${scan.found} found | ${scan.junk} junk | ${scan.dealCreated} deals | ${newLeads} nouveaux`);
    }
  } catch (e) {
    pollerStats.lastError = e.message;
    log('ERR', 'POLLER', `Erreur fatale: ${e.message}`);
  }
}

// ─── Démarrage séquentiel ─────────────────────────────────────────────────────
async function main() {
  // ── CRITIQUE: Démarrer le server HTTP EN PREMIER pour passer health check Render ──
  log('INFO', 'BOOT', `Step 0: server.listen(${PORT}) [CRITICAL]`);
  server.on('error', err => {
    log('ERR', 'BOOT', `server error: ${err.code || err.message}`);
    // Si EADDRINUSE, retry après 2s (l'ancienne instance libère le port)
    if (err.code === 'EADDRINUSE') setTimeout(() => server.listen(PORT).on('error', () => {}), 2000);
  });
  server.listen(PORT, () => log('OK', 'BOOT', `HTTP server listening on port ${PORT}`));

  log('INFO', 'BOOT', 'Step 1: refresh Dropbox token');
  if (process.env.DROPBOX_REFRESH_TOKEN) {
    try {
      const ok = await refreshDropboxToken();
      if (!ok) log('WARN', 'BOOT', 'Dropbox refresh échoué au démarrage');
    } catch (e) { log('WARN', 'BOOT', `Dropbox refresh exception: ${e.message}`); }
  }

  log('INFO', 'BOOT', 'Step 2: load Dropbox structure');
  try { await loadDropboxStructure(); } catch (e) { log('WARN', 'BOOT', `Dropbox struct: ${e.message}`); }

  log('INFO', 'BOOT', 'Step 3: init Gist');
  try { await initGistId(); } catch (e) { log('WARN', 'BOOT', `Gist init: ${e.message}`); }

  log('INFO', 'BOOT', 'Step 4: load memory');
  try { await loadMemoryFromGist(); } catch (e) { log('WARN', 'BOOT', `Memory: ${e.message}`); }

  log('INFO', 'BOOT', 'Step 5: load session live context');
  try { await loadSessionLiveContext(); } catch (e) { log('WARN', 'BOOT', `Session live: ${e.message}`); }

  // Refresh token Dropbox toutes les 3h (tokens expirent ~4h)
  setInterval(async () => {
    if (process.env.DROPBOX_REFRESH_TOKEN) await refreshDropboxToken().catch(() => {});
  }, 3 * 60 * 60 * 1000);

  // Refresh structure Dropbox toutes les 30min — terrain cache toujours à jour
  setInterval(async () => {
    await loadDropboxStructure().catch(e => log('WARN', 'DROPBOX', `Refresh structure: ${e.message}`));
  }, 30 * 60 * 1000);

  // ── Anthropic Health Check — ping Haiku pour détecter credit/auth problems
  // avant qu'un vrai appel Claude échoue. Adaptive: 6h normal, 5min si down.
  setTimeout(() => anthropicHealthCheck(), 30000); // 1er check 30s après boot
  setInterval(() => {
    const isDown = metrics.lastApiError &&
      Date.now() - new Date(metrics.lastApiError.at).getTime() < 60 * 60 * 1000 &&
      /credit|billing|authentication|invalid.*key/i.test(metrics.lastApiError.message || '');
    // Si down → check toutes les 5min (détecte reprise rapide après recharge)
    // Sinon → check toutes les 6h (pas de spam)
    if (isDown) anthropicHealthCheck();
  }, 5 * 60 * 1000); // tick 5min (fait le call seulement si down)
  setInterval(() => anthropicHealthCheck(), 6 * 60 * 60 * 1000); // check propre 6h

  // ── Gmail Lead Poller — surveille les leads entrants ──────────────────────
  if (process.env.GMAIL_CLIENT_ID && POLLER_ENABLED) {
    // Boot: restaurer state depuis Gist (cross-redeploy persistence).
    // Puis, si processed[] est vide (premier boot OU Gist vide) → baseline AUTO
    // silencieux: marque tous les leads récents comme déjà vus SANS notifier.
    // Évite le spam "re-notif de tout l'historique" à chaque redeploy.
    setTimeout(async () => {
      await loadPollerStateFromGist().catch(()=>{});
      if (gmailPollerState.processed.length < 5) {
        log('INFO', 'BOOT', 'State vide — baseline silencieux 7j au boot (zéro notif rétro)');
        await baselineSilentAtBoot().catch(e => log('WARN', 'BOOT', `Baseline: ${e.message}`));
      }
      runGmailLeadPoller().catch(e => log('WARN', 'POLLER', `Boot: ${e.message}`));
    }, 8000);
    // Polling toutes les 5 minutes
    setInterval(() => runGmailLeadPoller().catch(() => {}), 5 * 60 * 1000);
    // Boot: nettoyer emails GitHub/CI 30s après démarrage (Shawn veut zéro spam)
    setTimeout(() => autoTrashGitHubNoise().catch(() => {}), 30000);
    log('OK', 'BOOT', 'Gmail Lead Poller + auto-trash CI noise activés');
  } else if (!POLLER_ENABLED) {
    log('WARN', 'BOOT', '🛑 Gmail Lead Poller DÉSACTIVÉ (POLLER_ENABLED=false) — /checkemail pour scan manuel');
  } else {
    log('WARN', 'BOOT', 'Gmail Lead Poller désactivé — GMAIL_CLIENT_ID manquant');
  }

  // Pre-login Centris au démarrage si credentials disponibles
  if (process.env.CENTRIS_USER && process.env.CENTRIS_PASS) {
    centrisLogin()
      .then(ok => log(ok ? 'OK' : 'WARN', 'CENTRIS', ok ? `Pré-login réussi (agent ${process.env.CENTRIS_USER})` : 'Pré-login échoué — retry automatique à la première requête'))
      .catch(() => {});
  }

  log('INFO', 'BOOT', 'Step 6: registerHandlers');
  try { registerHandlers(); } catch (e) { log('ERR', 'BOOT', `registerHandlers FATAL: ${e.message}\n${e.stack}`); throw e; }

  log('INFO', 'BOOT', 'Step 7: startDailyTasks');
  try { startDailyTasks(); } catch (e) { log('ERR', 'BOOT', `startDailyTasks FATAL: ${e.message}`); throw e; }

  log('INFO', 'BOOT', 'Step 8: configuration WEBHOOK Telegram (auto-healing bulletproof)');
  const webhookUrl = `https://signaturesb-bot-s272.onrender.com/webhook/telegram`;

  // ── AUTO-HEAL WEBHOOK BULLETPROOF ─────────────────────────────────────────
  // Garantit que le webhook Telegram est TOUJOURS fonctionnel. Si fail:
  // 1. Detect via getWebhookInfo
  // 2. Resync avec exponential backoff
  // 3. Après 3 fails consécutifs → escalade GitHub Issue + fallback Brevo email
  // 4. Auto-recover dès que ça remarche
  const webhookHealth = {
    lastSync: null,
    lastCheck: null,
    consecutiveFails: 0,
    lastError: null,
    status: 'unknown',
  };
  // Expose dans /health
  global.__webhookHealth = webhookHealth;

  async function syncWebhookWithSecret(reason = 'routine') {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    try {
      const setParams = {
        url: webhookUrl,
        allowed_updates: ['message', 'edited_message', 'callback_query'],
        max_connections: 40,
      };
      if (secret) setParams.secret_token = secret;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(setParams),
      });
      clearTimeout(t);
      const data = await res.json();
      if (data.ok) {
        webhookHealth.lastSync = new Date().toISOString();
        webhookHealth.consecutiveFails = 0;
        webhookHealth.lastError = null;
        webhookHealth.status = 'healthy';
        log('OK', 'WEBHOOK', `Sync OK (${reason}) — secret=${secret ? 'set' : 'none'}`);
        auditLogEvent('webhook', 'synced', { reason, hasSecret: !!secret });
        return true;
      } else {
        webhookHealth.lastError = data.description || 'unknown';
        log('WARN', 'WEBHOOK', `setWebhook fail: ${data.description}`);
        return false;
      }
    } catch (e) {
      webhookHealth.lastError = e.message;
      log('WARN', 'WEBHOOK', `sync exception: ${e.message}`);
      return false;
    }
  }

  // Fallback: envoyer alerte via Brevo email si Telegram bot down
  async function alertShawnViaFallback(subject, body) {
    if (!BREVO_KEY || !SHAWN_EMAIL) return;
    try {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender: { email: AGENT.email, name: 'Kira Bot' },
          to: [{ email: SHAWN_EMAIL }],
          subject, htmlContent: `<pre>${body}</pre>`,
        })
      });
      log('OK', 'FALLBACK', `Email alerte envoyé à ${SHAWN_EMAIL}`);
    } catch (e) { log('WARN', 'FALLBACK', `Brevo fallback fail: ${e.message}`); }
  }

  async function checkWebhookHealth() {
    webhookHealth.lastCheck = new Date().toISOString();
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15000);
      const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getWebhookInfo`, { signal: ctrl.signal });
      clearTimeout(t);
      const data = await res.json();
      const w = data.result || {};
      const now = Math.floor(Date.now() / 1000);
      const errorRecent = w.last_error_date && (now - w.last_error_date) < 300;
      const tooPending  = (w.pending_update_count || 0) > 20;
      const anomaly = errorRecent || tooPending;

      if (!anomaly) {
        if (webhookHealth.status !== 'healthy') {
          log('OK', 'WEBHOOK', '🎉 Webhook sain à nouveau');
          webhookHealth.status = 'healthy';
          webhookHealth.consecutiveFails = 0;
          if (ALLOWED_ID) bot.sendMessage(ALLOWED_ID, '✅ Webhook Telegram retour à la normale.').catch(()=>{});
        }
        return;
      }

      // Anomalie détectée
      webhookHealth.status = 'degraded';
      webhookHealth.consecutiveFails++;
      log('WARN', 'WEBHOOK', `Anomaly #${webhookHealth.consecutiveFails}: pending=${w.pending_update_count} lastErr=${w.last_error_message}`);
      auditLogEvent('webhook', 'anomaly', { pending: w.pending_update_count, error: w.last_error_message, consecutive: webhookHealth.consecutiveFails });

      const synced = await syncWebhookWithSecret(`auto-heal #${webhookHealth.consecutiveFails}`);
      if (synced && ALLOWED_ID) {
        bot.sendMessage(ALLOWED_ID, `🔧 *Webhook auto-heal*\n${w.last_error_message}\nResync OK. Renvoie messages perdus si besoin.`, { parse_mode: 'Markdown' }).catch(()=>{});
      }

      // Escalade: 3+ fails consécutifs → GitHub Issue + Brevo email
      if (webhookHealth.consecutiveFails >= 3) {
        log('ERR', 'WEBHOOK', `🚨 ESCALADE — ${webhookHealth.consecutiveFails} fails consécutifs`);
        auditLogEvent('webhook', 'escalated', { fails: webhookHealth.consecutiveFails });
        const msg = `Webhook Telegram cassé après ${webhookHealth.consecutiveFails} tentatives.\n` +
                    `Pending: ${w.pending_update_count}\n` +
                    `Error: ${w.last_error_message}\n` +
                    `Bot URL: ${webhookUrl}\n` +
                    `Action: vérifier TELEGRAM_WEBHOOK_SECRET + TELEGRAM_BOT_TOKEN sur Render.`;
        alertShawnViaFallback('🚨 Kira Bot — webhook Telegram cassé', msg).catch(()=>{});
      }
    } catch (e) {
      webhookHealth.consecutiveFails++;
      webhookHealth.lastError = e.message;
      log('WARN', 'WEBHOOK', `check exception: ${e.message}`);
    }
  }

  // 1er sync au boot (+5s), puis check santé toutes les 2 min (plus agressif)
  setTimeout(() => syncWebhookWithSecret('boot'), 5000);
  setInterval(checkWebhookHealth, 2 * 60 * 1000);

  log('OK', 'BOOT', `✅ Kira démarrée [${currentModel}] — ${DATA_DIR} — mémos:${kiramem.facts.length} — tools:${TOOLS.length} — port:${PORT}`);

  setTimeout(() => syncStatusGitHub().catch(() => {}), 30000);

  // ── PRE-FLIGHT Claude API — détecte tool invalide dès le boot ─────────────
  setTimeout(async () => {
    try {
      await claude.messages.create({
        model: currentModel, max_tokens: 10,
        tools: TOOLS_WITH_CACHE,
        messages: [{ role: 'user', content: 'ping' }]
      });
      log('OK', 'PREFLIGHT', `✅ Claude API accepte les ${TOOLS.length} tools`);
    } catch (e) {
      const msg = e.message || '';
      const badIdx = msg.match(/tools\.(\d+)\.custom\.name/);
      if (badIdx) {
        const badTool = TOOLS[parseInt(badIdx[1])]?.name || '?';
        log('ERR', 'PREFLIGHT', `🚨 TOOL REJETÉ: "${badTool}" — regex [a-zA-Z0-9_-] violée`);
        if (ALLOWED_ID) bot.sendMessage(ALLOWED_ID, `🚨 *BOT EN PANNE*\nTool "${badTool}" invalide pour ${currentModel}.\nFix immédiat requis — accent ou caractère spécial dans le nom.`, { parse_mode: 'Markdown' }).catch(()=>{});
      } else if (e.status === 400) {
        log('ERR', 'PREFLIGHT', `🚨 API 400: ${msg.substring(0, 200)}`);
        if (ALLOWED_ID) bot.sendMessage(ALLOWED_ID, `🚨 *Claude API 400*\n${msg.substring(0, 200)}`, { parse_mode: 'Markdown' }).catch(()=>{});
      } else {
        log('WARN', 'PREFLIGHT', `API test: ${msg.substring(0, 150)}`);
      }
    }
  }, 3000);

  // Rapport de boot réussi — Claude Code peut voir que le bot a bien démarré
  setTimeout(async () => {
    try {
      if (process.env.GITHUB_TOKEN) {
        const content = `# ✅ Boot réussi\n_${new Date().toLocaleString('fr-CA',{timeZone:'America/Toronto'})}_\n\n- Modèle: ${currentModel}\n- Outils: ${TOOLS.length}\n- Uptime: ${Math.floor(process.uptime())}s\n- Centris: ${centrisSession.authenticated?'✅':'⏳'}\n- Dropbox: ${dropboxToken?'✅':'❌'}\n\n## Logs boot (150 dernières lignes)\n\`\`\`\n${(bootLogsCapture||[]).slice(-150).join('\n')}\n\`\`\`\n`;
        const url = `https://api.github.com/repos/signaturesb/kira-bot/contents/BOOT_REPORT.md`;
        const getRes = await fetch(url, { headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } });
        const sha = getRes.ok ? (await getRes.json()).sha : undefined;
        await fetch(url, {
          method: 'PUT',
          headers: { 'Authorization': `token ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: `Boot OK ${new Date().toISOString()}`, content: Buffer.from(content).toString('base64'), ...(sha ? { sha } : {}) })
        });
        log('OK', 'BOOT', 'BOOT_REPORT.md écrit dans GitHub');
      }
    } catch (e) { log('WARN', 'BOOT', `Report: ${e.message}`); }
  }, 15000);
}

main().catch(err => {
  log('ERR', 'BOOT', `❌ ERREUR DÉMARRAGE: ${err.message}\n${err.stack?.substring(0, 500) || ''}`);
  // Ne PAS exit(1) — laisser Render faire le health check
  // Si health fail, Render restart. Si on exit, on crash loop.
  setTimeout(() => process.exit(1), 5000); // Délai pour que les logs soient envoyés
});
