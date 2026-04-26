// build_style_profile.js — Analyse les messages indexés et génère STYLE_PROFILE.md
//
// Lit imessage_index.jsonl + gmail_index.jsonl, sample 300 messages "from_me=true",
// les passe à Claude Sonnet pour extraction de style:
//  - Vocabulaire/expressions québécoises
//  - Formules d'ouverture/fermeture
//  - Longueur typique selon contexte
//  - Ton selon type de contact (client immobilier vs collègue vs assistant)
//  - Tics de langage
//  - Sujets fréquents
//
// Output: data/style_profile.md (lisible par humains + bot)
//         data/style_profile.json (structuré pour requêtes auto)

require('dotenv').config({ path: __dirname + '/../../../mailing-masse/.env' });
require('dotenv').config({ path: '/Users/signaturesb/Downloads/signaturesb-bot.env', override: false });
require('dotenv').config({ path: __dirname + '/../../.env', override: false });

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const IMSG_FILE = path.join(DATA_DIR, 'imessage_index.jsonl');
const GMAIL_FILE = path.join(DATA_DIR, 'gmail_index.jsonl');
const OUT_MD = path.join(DATA_DIR, 'style_profile.md');
const OUT_JSON = path.join(DATA_DIR, 'style_profile.json');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error('❌ ANTHROPIC_API_KEY manquant');
  process.exit(1);
}

// ─── EXCLUSIONS — contacts perso, JAMAIS dans le style profile client ─────
// Le bot doit générer du texte pro pour les clients. Les conversations avec
// Julie (adjointe), conjointe, famille, amis proches contiennent du slang/
// sacres qui n'ont rien à voir avec le ton client.
const EXCLUDE_CONTACT_PATTERNS = [
  /julie\s*adjoint/i,
  /^femme$/i,
  /\bcousin\b/i,
  /\bcousine\b/i,
  /\bcatholique\s+que\s+le\s+pape\b/i, // surnom ami
  /\bbenny\s+crack\b/i,
  /\bbarrosky\b/i,
  /\braph\s+gump\b/i,
  /\btristan\s+olivier-lauz/i, // ami proche d'après volume
  /\bjs\s+vanier\b/i, // surnom
  /\bjeremy\s+bilodeau\b/i,
  /\bdave\s+cousin\b/i,
];

function isClientContact(name) {
  if (!name || name === 'unknown') return false;
  return !EXCLUDE_CONTACT_PATTERNS.some(re => re.test(name));
}

// ─── Charge les messages from_me ──────────────────────────────────────────
function loadMessages() {
  const messages = [];
  const sources = [
    { file: IMSG_FILE, type: 'imessage' },
    { file: GMAIL_FILE, type: 'gmail' }
  ];

  let totalRaw = 0, totalExcluded = 0;
  for (const src of sources) {
    if (!fs.existsSync(src.file)) {
      console.log(`  ⚠️  ${src.type}: pas de fichier (skip)`);
      continue;
    }
    const lines = fs.readFileSync(src.file, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const m = JSON.parse(line);
        if (!m.from_me) continue;
        totalRaw++;
        if (!isClientContact(m.pipedrive_name)) { totalExcluded++; continue; }
        messages.push({
          type: src.type,
          ts: m.ts,
          text: m.text || m.snippet || '',
          contact: m.pipedrive_name || 'unknown',
          subject: m.subject || null
        });
      } catch {}
    }
    console.log(`  ✓ ${src.type}: ${messages.length} messages CLIENT cumulés (from_me=true)`);
  }
  console.log(`\n  📊 Filtre perso: ${totalExcluded} msgs exclus (Julie/famille/amis) / ${totalRaw} from_me total`);
  return messages;
}

// Sample 300 messages diversifiés
function sampleMessages(messages, count = 300) {
  // Filtre: au moins 20 chars, pas juste emoji
  const valid = messages.filter(m => m.text && m.text.length >= 20 && /[a-zA-Z]/.test(m.text));
  if (valid.length <= count) return valid;
  // Random sample
  const sample = [];
  const indices = new Set();
  while (sample.length < count) {
    const i = Math.floor(Math.random() * valid.length);
    if (!indices.has(i)) { indices.add(i); sample.push(valid[i]); }
  }
  return sample;
}

// ─── Claude Sonnet analyze ────────────────────────────────────────────────
async function analyzeStyle(samples) {
  const examples = samples.slice(0, 300).map((m, i) =>
    `[${i + 1}] (${m.type}, à ${m.contact}${m.subject ? `, sujet: ${m.subject.substring(0, 40)}` : ''})\n${m.text.substring(0, 500)}`
  ).join('\n\n---\n\n');

  const prompt = `Tu analyses le style d'écriture PROFESSIONNEL CLIENT de Shawn Barrette, courtier immobilier RE/MAX à Rawdon (Lanaudière, Québec).

⚠️ RÈGLE ABSOLUE: ce profile sera utilisé pour DRAFTER DES MESSAGES À DES CLIENTS. Le ton doit être professionnel québécois STANDARD. JAMAIS de slang ("fak", "tsé", "stu", "pis", "ben"), JAMAIS de sacres (calisse, criss, tabarnak, esti, shit), JAMAIS de surnoms grossiers. Si tu vois ces mots dans les messages, IGNORE-LES — ils sont leftover de conversations perso non filtrées et ne doivent JAMAIS apparaître dans le profile.

Voici 300 messages réels qu'il a envoyés (iMessage + Gmail) à des clients immobiliers présents dans son CRM Pipedrive:

${examples}

Génère un STYLE PROFILE CLIENT-FACING complet pour permettre à un assistant IA de drafter des messages PRO pour ses clients.

Format exigé (JSON dans <profile>):
<profile>
{
  "DO_NOT_USE_EVER": ["fak", "tsé", "stu", "pis", "ben", "anyway", "calisse", "criss", "esti", "tabarnak", "shit", "lol", "tous slang/sacres similaires"],
  "vocabulaire_pro_quebecois": ["expressions PROFESSIONNELLES québécoises acceptables", "ex: 'au plaisir', 'sans faute', 'à l'occasion'"],
  "ouvertures_typiques": {
    "client_initial": ["Bonjour [nom]!", "..."],
    "client_existant": ["Salut [prénom]"],
    "assistant_julie": ["..."]
  },
  "fermetures_typiques": ["Merci!", "Au plaisir", "..."],
  "longueur": {
    "imessage_moyen": "X chars/mots typique",
    "email_moyen": "X chars/mots typique",
    "longueur_max_avant_appel": "Si réponse > X mots, il préfère appeler"
  },
  "ton_par_contexte": {
    "lead_chaud_terrain": "description du ton",
    "negotiation_offre": "...",
    "suivi_post_visite": "..."
  },
  "sujets_frequents": ["liste", "des", "thèmes"],
  "regles_implicites": [
    "Toujours mentionner le numéro Centris quand parle d'un terrain",
    "Préfère décliner par téléphone que par texte pour gros sujets",
    "..."
  ],
  "exemples_response_pattern": [
    {
      "trigger": "Client demande prix",
      "response_style": "Réponse courte avec chiffre rond + invitation à appeler"
    }
  ],
  "emoji_usage": "rare/fréquent + lesquels",
  "ponctuation": "Ex: utilise '!' fréquent, '...' rare"
}
</profile>

PUIS un résumé en 5-10 lignes pour humains (style narrative, ce qui caractérise Shawn).

Sois précis et factuel. Cite des passages des messages comme preuves quand pertinent.`;

  console.log(`\n🧠 Analyse Claude Sonnet (~30-60 sec)...`);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.content[0].text;
}

async function main() {
  console.log(`📂 Chargement messages indexés...`);
  const messages = loadMessages();
  if (!messages.length) {
    console.error(`❌ Aucun message — run scrape_imessage.js et/ou scrape_gmail.js d'abord`);
    process.exit(1);
  }
  console.log(`\n📊 Total: ${messages.length} messages from_me`);

  const sample = sampleMessages(messages, 300);
  console.log(`📌 Sample: ${sample.length} messages diversifiés`);

  const analysis = await analyzeStyle(sample);

  // Extract JSON profile
  const profileMatch = analysis.match(/<profile>([\s\S]*?)<\/profile>/);
  let profileJson = null;
  if (profileMatch) {
    try { profileJson = JSON.parse(profileMatch[1].trim()); }
    catch (e) { console.warn('  ⚠️  JSON parse failed:', e.message); }
  }

  // Markdown output
  const md = `# STYLE PROFILE — Shawn Barrette

_Généré le ${new Date().toLocaleString('fr-CA')} — basé sur ${sample.length} messages réels (sample de ${messages.length} total)_

${analysis}
`;
  fs.writeFileSync(OUT_MD, md);
  if (profileJson) {
    fs.writeFileSync(OUT_JSON, JSON.stringify({
      generated: new Date().toISOString(),
      sampleSize: sample.length,
      totalMessages: messages.length,
      profile: profileJson
    }, null, 2));
  }

  console.log(`\n✓ Sauvegardé:`);
  console.log(`  ${OUT_MD}`);
  if (profileJson) console.log(`  ${OUT_JSON}`);
  console.log(`\n📖 Pour lire: open ${OUT_MD}`);
}

if (require.main === module) {
  main().catch(e => { console.error('❌', e.message); process.exit(1); });
}
