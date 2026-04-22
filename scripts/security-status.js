#!/usr/bin/env node
// ─── scripts/security-status.js ─────────────────────────────────────────────
// Dashboard rapide: état des 9 couches de sécurité.
// Usage: npm run security-status
//
// Vérifie localement ce qui peut l'être, interroge GitHub API pour le reste.

'use strict';
require('dotenv').config();
const fs = require('fs');
const https = require('https');

const GREEN = '\x1b[32m', RED = '\x1b[31m', YEL = '\x1b[33m', BLUE = '\x1b[34m', DIM = '\x1b[2m', RESET = '\x1b[0m';
const ok   = msg => console.log(`  ${GREEN}✓${RESET} ${msg}`);
const no   = msg => console.log(`  ${RED}✗${RESET} ${msg}`);
const skip = msg => console.log(`  ${YEL}?${RESET} ${msg}`);

const TOKEN = process.env.GITHUB_TOKEN;
const REPOS = ['signaturesb/kira-bot', 'signaturesb/bot-assistant'];

function gh(path) {
  return new Promise((resolve) => {
    if (!TOKEN) return resolve({ status: 401 });
    const req = https.request({
      hostname: 'api.github.com', path, method: 'GET',
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept':        'application/vnd.github+json',
        'User-Agent':    'signaturesb-security-status',
      },
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        let body = null;
        try { body = chunks ? JSON.parse(chunks) : null; } catch {}
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', () => resolve({ status: 0 }));
    req.end();
  });
}

async function check() {
  let score = 0, total = 0;
  const add = (pass) => { total++; if (pass) score++; };

  console.log(`\n${BLUE}━━━ Couche 1 — Pre-commit local ━━━${RESET}`);
  const hookPath = require('child_process').execSync('git config core.hooksPath 2>/dev/null || echo ""').toString().trim();
  if (hookPath === '.githooks') { ok('hooksPath = .githooks'); add(true); }
  else { no(`hooksPath = "${hookPath}" (attendu: .githooks) — fix: git config core.hooksPath .githooks`); add(false); }
  if (fs.existsSync('.githooks/pre-commit')) { ok('.githooks/pre-commit présent'); add(true); }
  else { no('pre-commit manquant'); add(false); }
  if (fs.existsSync('validate.js')) { ok('validate.js présent'); add(true); }
  else { no('validate.js manquant'); add(false); }

  console.log(`\n${BLUE}━━━ Couche 2-3-5-6-7 — Workflows CI ━━━${RESET}`);
  const wfDir = '.github/workflows';
  for (const wf of ['security.yml', 'codeql.yml', 'scorecard.yml', 'dependency-review.yml', 'smoke-test.yml']) {
    if (fs.existsSync(`${wfDir}/${wf}`)) { ok(wf); add(true); }
    else { no(`${wf} manquant`); add(false); }
  }

  console.log(`\n${BLUE}━━━ Couche 8 — Dependabot config ━━━${RESET}`);
  if (fs.existsSync('.github/dependabot.yml')) { ok('.github/dependabot.yml présent'); add(true); }
  else { no('dependabot.yml manquant'); add(false); }

  console.log(`\n${BLUE}━━━ .gitignore + .env ━━━${RESET}`);
  const gi = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore','utf8') : '';
  if (gi.includes('.env')) { ok('.env dans .gitignore'); add(true); }
  else { no('.env PAS dans .gitignore'); add(false); }
  if (fs.existsSync('.env.example')) { ok('.env.example template présent'); add(true); }
  else { no('.env.example manquant'); add(false); }

  console.log(`\n${BLUE}━━━ Couches 3-4-9 — GitHub server-side ━━━${RESET}`);
  if (!TOKEN) {
    skip('GITHUB_TOKEN manquant dans .env — skip checks serveur');
    skip('Pour vérifier: GITHUB_TOKEN=ghp_... npm run security-status');
  } else {
    for (const repo of REPOS) {
      console.log(`\n  ${DIM}${repo}:${RESET}`);
      const r = await gh(`/repos/${repo}`);
      if (r.status !== 200) { no(`  API ${r.status} — token invalide ou repo inaccessible`); add(false); continue; }
      const sa = r.body.security_and_analysis || {};

      // Secret scanning (couche 4)
      if (sa.secret_scanning?.status === 'enabled') { ok('  Secret scanning ACTIVÉ'); add(true); }
      else { no('  Secret scanning désactivé — run: npm run enable-security'); add(false); }

      // Push protection (couche 4)
      if (sa.secret_scanning_push_protection?.status === 'enabled') { ok('  Push Protection ACTIVÉ'); add(true); }
      else { no('  Push Protection désactivé'); add(false); }

      // Branch protection
      const bp = await gh(`/repos/${repo}/branches/main/protection`);
      if (bp.status === 200) {
        const linear = bp.body.required_linear_history?.enabled;
        const noForce = bp.body.allow_force_pushes?.enabled === false;
        if (linear && noForce) { ok('  Branch protection: linear + no force-push'); add(true); }
        else { skip(`  Branch protection partielle (linear=${linear}, noForce=${noForce})`); add(false); }
      } else {
        no('  Branch protection main absente — run: npm run enable-security');
        add(false);
      }

      // Dependabot vuln alerts (couche 8)
      const va = await gh(`/repos/${repo}/vulnerability-alerts`);
      if (va.status === 204) { ok('  Dependabot vulnerability alerts ACTIVÉS'); add(true); }
      else { no('  Dependabot alerts désactivés'); add(false); }
    }
  }

  const pct = Math.round(100 * score / total);
  const color = pct >= 90 ? GREEN : pct >= 60 ? YEL : RED;
  console.log(`\n${color}━━━ Score sécurité: ${score}/${total} (${pct}%) ━━━${RESET}`);
  if (pct < 100) {
    console.log(`\n${DIM}→ Pour activer ce qui manque: npm run enable-security${RESET}`);
  }
  console.log('');
}

check().catch(e => {
  console.error(`❌ Erreur: ${e.message}`);
  process.exit(1);
});
