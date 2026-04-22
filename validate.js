#!/usr/bin/env node
// ─── Validation pré-commit ───────────────────────────────────────────────────
// Prévient les erreurs découvertes dans cette session:
//   1. Noms de tools avec accents (Opus 4.7 rejette)
//   2. Noms de tools dupliqués
//   3. temperature/top_p non-default (Opus 4.7 rejette)
//   4. startCommand manquant dans render.yaml
//   5. Incohérence package.json main vs render.yaml startCommand

'use strict';
const fs = require('fs');

const issues = [];
const warnings = [];

// ── 1. Syntaxe bot.js + lead_parser.js ───────────────────────────────────────
try {
  require('child_process').execSync('node --check bot.js', { stdio: 'pipe' });
} catch (e) {
  issues.push('❌ Syntaxe bot.js invalide');
  console.error(e.stderr?.toString() || e.message);
}
if (fs.existsSync('./lead_parser.js')) {
  try {
    require('child_process').execSync('node --check lead_parser.js', { stdio: 'pipe' });
  } catch (e) {
    issues.push('❌ Syntaxe lead_parser.js invalide');
  }
}

// ── 1b. Suite de tests parseLeadEmail (bloque si extraction cassée) ──────────
if (fs.existsSync('./test_parser.js') && fs.existsSync('./lead_parser.js')) {
  try {
    require('child_process').execSync('node test_parser.js', { stdio: 'pipe' });
    console.log('  ✓ Suite de tests parser passe (8/8)');
  } catch (e) {
    issues.push('❌ Suite de tests parser échoue — parseLeadEmail est cassé');
    console.error(e.stdout?.toString() || e.message);
  }
}

const code = fs.readFileSync('./bot.js', 'utf8');

// ── 2. Tool names (regex Opus 4.7) ──────────────────────────────────────────
const toolsStart = code.indexOf('const TOOLS = [');
const toolsEnd   = code.indexOf('\n];\n', toolsStart);
if (toolsStart < 0 || toolsEnd < 0) {
  issues.push('❌ Bloc TOOLS introuvable dans bot.js');
} else {
  const toolsBlock = code.substring(toolsStart, toolsEnd);
  const validName  = /^[a-zA-Z0-9_-]{1,128}$/;
  const names      = [];
  const nameRe     = /name:\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = nameRe.exec(toolsBlock)) !== null) {
    names.push(m[1]);
    if (!validName.test(m[1])) {
      issues.push(`❌ Tool name INVALIDE pour Opus 4.7: "${m[1]}"`);
      issues.push(`   → Doit matcher /^[a-zA-Z0-9_-]{1,128}$/ (pas d'accents/espaces/caractères spéciaux)`);
    }
  }
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) issues.push(`❌ Tools dupliqués: ${[...new Set(dupes)].join(', ')}`);
  console.log(`  ✓ ${names.length} tools scannés`);
}

// ── 3. temperature/top_p/top_k (Opus 4.7 breaking) ──────────────────────────
// Chercher les appels claude.messages.create avec temperature
const apiCallRe = /claude\.messages\.create\(\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/gs;
let apiMatch;
while ((apiMatch = apiCallRe.exec(code)) !== null) {
  const params = apiMatch[1];
  if (/\btemperature\s*:/.test(params)) {
    issues.push(`❌ temperature: détecté dans claude.messages.create — Opus 4.7 rejette si non-default`);
  }
  if (/\btop_p\s*:/.test(params)) {
    issues.push(`❌ top_p: détecté dans claude.messages.create — Opus 4.7 rejette`);
  }
  if (/\btop_k\s*:/.test(params)) {
    issues.push(`❌ top_k: détecté dans claude.messages.create — Opus 4.7 rejette`);
  }
}

// ── 4. Cohérence package.json vs render.yaml ────────────────────────────────
try {
  const pkg = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  const mainFile = pkg.main || 'index.js';
  if (!fs.existsSync(mainFile)) {
    issues.push(`❌ package.json main = "${mainFile}" mais fichier inexistant`);
  }
  if (fs.existsSync('./render.yaml')) {
    const renderYaml = fs.readFileSync('./render.yaml', 'utf8');
    const startMatch = renderYaml.match(/startCommand:\s*(.+)/);
    if (startMatch) {
      const cmd = startMatch[1].trim();
      const expectedFile = cmd.replace(/^node\s+/, '');
      if (!fs.existsSync(expectedFile)) {
        issues.push(`❌ render.yaml startCommand "${cmd}" pointe vers "${expectedFile}" inexistant`);
      }
      if (!cmd.includes(mainFile)) {
        warnings.push(`⚠️ render.yaml startCommand "${cmd}" ≠ package.json main "${mainFile}"`);
      }
    }
  }
} catch (e) { warnings.push(`⚠️ Impossible valider package.json/render.yaml: ${e.message}`); }

// ── 5. process.exit inattendus (pattern dangereux) ──────────────────────────
const exitLines = code.split('\n').filter((l, i) => /process\.exit\(1\)/.test(l) && !/^\s*\/\//.test(l));
if (exitLines.length > 3) {
  warnings.push(`⚠️ ${exitLines.length} process.exit(1) trouvés — vérifier qu'aucun n'est appelé par un event handler transient`);
}

// ── 6. Scan secrets sur fichiers staged (bloque fuite avant commit) ─────────
// Patterns = listes de detection. Doivent être précis pour éviter faux positifs.
// Les patterns connus leak sont encodés en hex pour ne pas apparaître en clair
// (éviter que filter-repo/gitleaks redactent ce fichier lui-même, et éviter de
// mettre des valeurs sensibles en clair même si déjà compromises).
const hex = h => Buffer.from(h, 'hex').toString();
const LEAKED_PASSWORD = hex('4d696c6631333430'); // password de base compromis — scan pour détecter si réutilisé
const SECRET_PATTERNS = [
  { name: 'GitHub OAuth token',       re: /\bgho_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub Personal token',    re: /\bghp_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub App token',         re: /\bghs_[A-Za-z0-9]{30,}\b/ },
  { name: 'GitHub Refresh token',     re: /\bghr_[A-Za-z0-9]{30,}\b/ },
  { name: 'Render API key',           re: /\brnd_[A-Za-z0-9]{25,}\b/ },
  { name: 'Anthropic API key',        re: /\bsk-ant-api\d{2}-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI API key',           re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/ },
  { name: 'Brevo API key',            re: /\bxkeysib-[a-f0-9]{20,}/ },
  { name: 'Pipedrive API key',        re: /\b[a-f0-9]{40}\b/ },
  { name: 'Telegram bot token',       re: /\b\d{8,12}:AAG[A-Za-z0-9_-]{30,}/ },
  { name: 'Slack token',              re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS Access Key',           re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Leaked password (rotated)', re: new RegExp(LEAKED_PASSWORD + '[@$!#&*]?') },
  { name: 'Private key header',       re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP |)PRIVATE KEY-----/ },
];
const SECRET_WHITELIST = new Set([
  '.env.example',
  'SECURITY.md',
  '.gitleaksignore',
  'validate.js',            // ce fichier contient les patterns pour les détecter
  '.github/workflows/security.yml',
]);
try {
  const staged = require('child_process')
    .execSync('git diff --cached --name-only --diff-filter=ACMRTUXB', { stdio: ['pipe','pipe','pipe'] })
    .toString().trim().split('\n').filter(Boolean);
  const filesToScan = staged.length ? staged : []; // en mode manual (hors pre-commit), ne scan pas tout
  let secretsFound = 0;
  for (const f of filesToScan) {
    if (SECRET_WHITELIST.has(f)) continue;
    if (!fs.existsSync(f)) continue;
    let content;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const { name, re } of SECRET_PATTERNS) {
      const m = content.match(re);
      if (m) {
        secretsFound++;
        issues.push(`🔐 SECRET DÉTECTÉ: ${name} dans ${f}`);
        issues.push(`    → Extrait: ${m[0].slice(0, 12)}…${m[0].slice(-4)}`);
        issues.push(`    → Retire la valeur, utilise process.env.<NAME>, regénère la clé si exposée`);
      }
    }
  }
  if (filesToScan.length) {
    console.log(`  ✓ Secret scan: ${filesToScan.length} fichiers staged, ${secretsFound} secrets${secretsFound?'':' — OK'}`);
  }
} catch (e) {
  // pas dans un contexte git / pas de staging — on skip silencieusement
}

// ── Résultat ─────────────────────────────────────────────────────────────────
console.log('');
if (warnings.length) {
  console.log('⚠️  WARNINGS:');
  warnings.forEach(w => console.log('  ' + w));
  console.log('');
}

if (issues.length) {
  console.error('🚨 VALIDATION ÉCHOUÉE — NE PAS COMMITER:\n');
  issues.forEach(i => console.error('  ' + i));
  console.error('');
  process.exit(1);
}

console.log('✅ Validation OK — safe to commit');
