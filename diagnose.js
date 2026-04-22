#!/usr/bin/env node
// ─── diagnose.js — Diagnostic complet du système ─────────────────────────────
// Usage: node diagnose.js
// Vérifie en 30 secondes: Render, GitHub, Claude API, toutes les intégrations
// → rapport complet + actions suggérées

'use strict';
const https = require('https');

const GREEN = '\x1b[32m', RED = '\x1b[31m', YEL = '\x1b[33m', BLUE = '\x1b[34m', RESET = '\x1b[0m';
const ok = (msg) => console.log(`${GREEN}✅${RESET} ${msg}`);
const err = (msg) => console.log(`${RED}❌${RESET} ${msg}`);
const warn = (msg) => console.log(`${YEL}⚠️ ${RESET} ${msg}`);
const info = (msg) => console.log(`${BLUE}ℹ️ ${RESET} ${msg}`);
const section = (title) => console.log(`\n${BLUE}━━━ ${title} ━━━${RESET}`);

// Credentials (read from .env.shared if possible)
const creds = {
  RENDER_API: 'REDACTED_RENDER_API_KEY',
  RENDER_SERVICE: 'srv-d7fh9777f7vs73a15ddg',
  GITHUB_TOKEN: 'REDACTED_GITHUB_TOKEN',
  BOT_URL: 'https://signaturesb-bot-s272.onrender.com',
  REPO: 'signaturesb/kira-bot',
};

async function fetch(url, opts = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: opts.method || 'GET', headers: opts.headers || {},
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => res({ status: resp.statusCode, body: data, headers: resp.headers }));
    });
    req.on('error', rej);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const issues = [];
const fixes = [];

(async () => {
  console.log(`${BLUE}🔍 Diagnostic système Signature SB — ${new Date().toLocaleString('fr-CA')}${RESET}`);

  // ── 1. Bot HTTP health ─────────────────────────────────────────────────────
  section('Bot Production');
  try {
    const r = await fetch(`${creds.BOT_URL}/`);
    if (r.status === 200) {
      const match = r.body.match(/tools:(\d+) — mémos:(\d+)/);
      const tools = match ? match[1] : '?';
      const mémos = match ? match[2] : '?';
      ok(`Bot répond (tools: ${tools}, mémos: ${mémos})`);
      if (parseInt(tools) < 30) {
        issues.push(`Bot tools:${tools} — ancien déploiement`);
        fixes.push('git push origin main → forcer redeploy');
      }
    } else {
      err(`Bot HTTP ${r.status}`);
      issues.push('Bot ne répond pas');
    }
  } catch (e) { err(`Bot injoignable: ${e.message}`); issues.push(`Bot injoignable: ${e.message}`); }

  // ── 2. /health JSON détaillé ───────────────────────────────────────────────
  try {
    const h = await fetch(`${creds.BOT_URL}/health`);
    if (h.status === 200) {
      const data = JSON.parse(h.body);
      ok(`Uptime: ${data.uptime_human} | Modèle: ${data.model}`);
      const subs = data.subsystems || {};
      for (const [k, v] of Object.entries(subs)) {
        if (v) ok(`  ${k}: actif`);
        else if (['centris', 'whisper'].includes(k)) warn(`  ${k}: inactif (optionnel)`);
        else { err(`  ${k}: INACTIF`); issues.push(`${k} inactif sur production`); }
      }
      const errs = data.metrics?.errors?.total || 0;
      if (errs > 0) {
        warn(`${errs} erreurs depuis boot — détail: ${JSON.stringify(data.metrics.errors.byStatus)}`);
        if (data.metrics.errors.byStatus['400']) {
          issues.push(`${data.metrics.errors.byStatus['400']} erreurs 400 — vérifier tool names ou payload`);
          fixes.push('node validate.js → identifier le tool cassé');
        }
      } else ok('0 erreurs depuis boot');
    }
  } catch (e) { warn(`/health indisponible: ${e.message}`); }

  // ── 3. Render deploy status ────────────────────────────────────────────────
  section('Render');
  try {
    const d = await fetch(`https://api.render.com/v1/services/${creds.RENDER_SERVICE}/deploys?limit=3`, {
      headers: { 'Authorization': `Bearer ${creds.RENDER_API}` }
    });
    const deploys = JSON.parse(d.body);
    const last = deploys[0]?.deploy;
    if (last?.status === 'live') ok(`Dernier deploy: LIVE (${last.commit?.id?.substring(0,7)})`);
    else if (last?.status === 'update_in_progress') info(`Deploy en cours (${last.commit?.id?.substring(0,7)})`);
    else { err(`Dernier deploy: ${last?.status}`); issues.push(`Deploy échoué: ${last?.status}`); }
    const failedCount = deploys.filter(x => x.deploy.status === 'update_failed').length;
    if (failedCount >= 2) {
      warn(`${failedCount}/3 derniers deploys ont échoué`);
      fixes.push('Check Render startCommand: curl GET /services/{id} | jq .serviceDetails.envSpecificDetails.startCommand');
    }
  } catch (e) { err(`Render API: ${e.message}`); }

  // ── 4. Env vars Render ─────────────────────────────────────────────────────
  try {
    const e = await fetch(`https://api.render.com/v1/services/${creds.RENDER_SERVICE}/env-vars?limit=100`, {
      headers: { 'Authorization': `Bearer ${creds.RENDER_API}` }
    });
    const vars = JSON.parse(e.body);
    const keys = new Set(vars.map(v => v.envVar.key));
    const required = ['TELEGRAM_BOT_TOKEN', 'ANTHROPIC_API_KEY', 'PIPEDRIVE_API_KEY', 'BREVO_API_KEY',
                     'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN',
                     'DROPBOX_APP_KEY', 'DROPBOX_APP_SECRET', 'DROPBOX_REFRESH_TOKEN',
                     'GITHUB_TOKEN', 'CENTRIS_USER', 'CENTRIS_PASS'];
    const missing = required.filter(k => !keys.has(k));
    if (!missing.length) ok(`${keys.size} env vars configurées — toutes critiques présentes`);
    else { err(`Env vars manquantes: ${missing.join(', ')}`); issues.push(`Env vars Render manquantes: ${missing.join(', ')}`); }
    if (!keys.has('OPENAI_API_KEY')) warn('OPENAI_API_KEY absent (Whisper vocaux désactivé, optionnel)');
  } catch (e) { err(`Render env-vars: ${e.message}`); }

  // ── 5. GitHub reports ──────────────────────────────────────────────────────
  section('GitHub (sync Mac ↔ bot)');
  for (const [file, label] of [['BOOT_REPORT.md', 'Boot récent'], ['CRASH_REPORT.md', 'Crash report'], ['BOT_STATUS.md', 'Status bot'], ['SESSION_LIVE.md', 'Session live']]) {
    try {
      const r = await fetch(`https://api.github.com/repos/${creds.REPO}/contents/${file}`, {
        headers: { 'Authorization': `token ${creds.GITHUB_TOKEN}`, 'User-Agent': 'diagnose-script' }
      });
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        const sizeKB = Math.round((data.size || 0) / 1024);
        if (file === 'CRASH_REPORT.md') warn(`${label}: ${sizeKB}KB — présent (crash récent?)`);
        else ok(`${label}: ${sizeKB}KB`);
      } else if (r.status === 404) {
        if (file === 'CRASH_REPORT.md') ok(`${label}: absent (aucun crash)`);
        else warn(`${label}: absent`);
      }
    } catch (e) { warn(`${label}: ${e.message}`); }
  }

  // ── 6. Code local ──────────────────────────────────────────────────────────
  section('Code local');
  const fs = require('fs');
  try {
    const code = fs.readFileSync('./bot.js', 'utf8');
    ok(`bot.js: ${Math.round(code.length/1024)}KB, ${code.split('\n').length} lignes`);

    // Tool names
    const toolsStart = code.indexOf('const TOOLS = [');
    const toolsEnd = code.indexOf('\n];\n', toolsStart);
    const block = code.substring(toolsStart, toolsEnd);
    const names = [...block.matchAll(/name:\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    const bad = names.filter(n => !/^[a-zA-Z0-9_-]{1,128}$/.test(n));
    if (bad.length) { err(`Tool names invalides: ${bad.join(', ')}`); issues.push(`Tools invalides: ${bad.join(', ')}`); }
    else ok(`${names.length} tool names valides`);

    // render.yaml check
    if (fs.existsSync('./render.yaml')) {
      const ry = fs.readFileSync('./render.yaml', 'utf8');
      const sc = ry.match(/startCommand:\s*(.+)/)?.[1]?.trim();
      if (sc?.includes('bot.js')) ok(`render.yaml startCommand: ${sc}`);
      else { err(`render.yaml startCommand pointe vers: ${sc}`); issues.push(`render.yaml startCommand mal configuré`); }
    }

    // Git hooks
    const hooksConfig = require('child_process').execSync('git config core.hooksPath', { encoding: 'utf8' }).trim();
    if (hooksConfig === '.githooks') ok(`Git hooks: .githooks/ (pre-commit actif)`);
    else { warn(`Git hooks: ${hooksConfig || 'non configuré'}`); fixes.push('git config core.hooksPath .githooks'); }
  } catch (e) { err(`Code local: ${e.message}`); }

  // ── 7. Git status ──────────────────────────────────────────────────────────
  try {
    const { execSync } = require('child_process');
    const dirty = execSync('git status --porcelain', { encoding: 'utf8' }).trim();
    if (dirty) warn(`Changes non committés:\n${dirty.split('\n').map(l=>'  '+l).join('\n')}`);
    else ok('Working tree clean');

    const ahead = execSync('git log origin/main..HEAD --oneline 2>/dev/null', { encoding: 'utf8' }).trim();
    if (ahead) warn(`${ahead.split('\n').length} commits non pushés`);
    else ok('Synchronisé avec origin');
  } catch (e) { warn(`Git: ${e.message}`); }

  // ── Résumé ─────────────────────────────────────────────────────────────────
  section('Résumé');
  if (!issues.length) console.log(`${GREEN}✅ Système en bonne santé — 0 problème détecté${RESET}`);
  else {
    console.log(`${RED}🚨 ${issues.length} problème(s) détecté(s):${RESET}`);
    issues.forEach(i => console.log(`  ❌ ${i}`));
    if (fixes.length) {
      console.log(`\n${YEL}💡 Actions suggérées:${RESET}`);
      fixes.forEach(f => console.log(`  → ${f}`));
    }
  }
  console.log('');
})();
