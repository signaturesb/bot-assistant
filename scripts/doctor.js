#!/usr/bin/env node
// ─── scripts/doctor.js ──────────────────────────────────────────────────────
// Audit complet combiné: bot + Claude Code + GitHub + Render.
// npm run doctor → rapport en 5 sections.

'use strict';
require('dotenv').config();
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', B = '\x1b[34m', D = '\x1b[2m', RS = '\x1b[0m';
const pass = m => console.log(`  ${G}✓${RS} ${m}`);
const fail = m => console.log(`  ${R}✗${RS} ${m}`);
const warn = m => console.log(`  ${Y}?${RS} ${m}`);
const h1 = t => console.log(`\n${B}━━━ ${t} ━━━${RS}`);

const BOT_URL = process.env.BOT_URL || 'https://signaturesb-bot-s272.onrender.com';

function get(url, timeoutMs = 15000) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, body }); }
      });
    });
    req.on('error', e => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
  });
}

(async () => {
  let score = 0, total = 0;
  const T = ok => { total++; if (ok) score++; };

  // ── 1. BOT LIVE ─────────────────────────────────────────────────────────
  h1('1. BOT PROD (Render)');
  const health = await get(`${BOT_URL}/health`);
  if (health.status !== 200) {
    fail(`/health HTTP ${health.status || 'timeout'} — ${health.error || 'down'}`);
    T(false);
  } else {
    const h = health.body;
    pass(`Live · ${h.model} · ${h.tools} outils · ${h.uptime_human}`); T(true);
    const sub = h.subsystems || {};
    for (const s of ['pipedrive','brevo','gmail','dropbox','github']) {
      sub[s] ? pass(`  ${s}`) : fail(`  ${s}`);
      T(!!sub[s]);
    }
    const errs = h.metrics?.errors?.total || 0;
    errs === 0 ? pass(`Errors: 0`) : errs < 5 ? warn(`Errors: ${errs}`) : fail(`Errors: ${errs}`);
    T(errs < 5);
    const poller = h.gmail_poller || {};
    const pollerStats = poller.stats || {};
    if (poller.last_run) {
      const age = Math.round((Date.now() - new Date(poller.last_run).getTime()) / 60000);
      age < 10 ? pass(`Poller: scanné il y a ${age}min · ${poller.total_leads||0} leads total`) :
      age < 30 ? warn(`Poller: scanné il y a ${age}min`) :
      fail(`Poller: silencieux ${age}min`);
      T(age < 30);
    } else {
      warn(`Poller: jamais scanné`);
      T(false);
    }
    if (pollerStats.totalsLowInfo && pollerStats.totalsFound) {
      const r = Math.round(100 * pollerStats.totalsLowInfo / pollerStats.totalsFound);
      r < 20 ? pass(`Parser ratio lowInfo: ${r}%`) :
      fail(`Parser ratio lowInfo: ${r}% — vérifier lead_parser.js`);
      T(r < 20);
    }
  }

  // ── 2. SÉCURITÉ ─────────────────────────────────────────────────────────
  h1('2. SÉCURITÉ LOCAL');
  const hookPath = execSync('git config core.hooksPath 2>/dev/null || echo ""').toString().trim();
  hookPath === '.githooks' ? pass('pre-commit hooks actifs') : fail('pre-commit non configuré');
  T(hookPath === '.githooks');
  for (const f of ['.githooks/pre-commit','validate.js','.env.example','SECURITY.md']) {
    fs.existsSync(f) ? pass(f) : fail(`${f} manquant`);
    T(fs.existsSync(f));
  }
  const workflows = [
    'security.yml','codeql.yml','scorecard.yml','dependency-review.yml',
    'smoke-test.yml','auto-merge-dependabot.yml','lead-recovery-watchdog.yml'
  ];
  let wfOk = 0;
  for (const w of workflows) { const p = `.github/workflows/${w}`; if (fs.existsSync(p)) wfOk++; }
  wfOk === workflows.length ? pass(`7 workflows CI en place`) :
    fail(`${wfOk}/${workflows.length} workflows`);
  T(wfOk === workflows.length);

  // ── 3. GIT STATE ────────────────────────────────────────────────────────
  h1('3. GIT');
  const branch = execSync('git rev-parse --abbrev-ref HEAD').toString().trim();
  const sha = execSync('git rev-parse --short HEAD').toString().trim();
  const dirty = execSync('git status --porcelain').toString().trim();
  pass(`${branch} @ ${sha}`); T(true);
  dirty ? warn(`Working dir sale: ${dirty.split('\n').length} fichiers non committés`) :
    pass('Working dir clean');
  T(!dirty);

  // Sync avec remotes
  try {
    execSync('git fetch --all --quiet 2>&1');
    const ahead = parseInt(execSync('git rev-list --count @{u}..HEAD 2>/dev/null || echo 0').toString().trim() || '0');
    const behind = parseInt(execSync('git rev-list --count HEAD..@{u} 2>/dev/null || echo 0').toString().trim() || '0');
    ahead === 0 && behind === 0 ? pass('Sync avec origin') :
      warn(`ahead:${ahead} behind:${behind} vs origin`);
    T(ahead === 0 && behind === 0);
  } catch { warn('Impossible check remote sync'); T(false); }

  // ── 4. MÉMOIRE CLAUDE CODE ──────────────────────────────────────────────
  h1('4. MÉMOIRE CLAUDE CODE');
  const memDir = '/Users/signaturesb/.claude/projects/-Users-signaturesb-Documents-github-Claude--code-Telegram/memory';
  if (fs.existsSync(memDir)) {
    const files = fs.readdirSync(memDir).filter(f => f.endsWith('.md'));
    pass(`${files.length} fichiers mémoire`); T(true);
    const feedbackRules = files.filter(f => f.startsWith('feedback_'));
    pass(`${feedbackRules.length} règles feedback permanentes`); T(feedbackRules.length >= 3);
  } else {
    fail('Dossier mémoire absent'); T(false);
  }

  // ── 5. ENV LOCAL ────────────────────────────────────────────────────────
  h1('5. CONFIG LOCALE');
  if (fs.existsSync('.env')) {
    const env = fs.readFileSync('.env', 'utf8');
    const hasRender = /RENDER_API_KEY=.+\S/.test(env);
    const hasGH     = /GITHUB_TOKEN=.+\S/.test(env);
    hasRender ? pass('.env RENDER_API_KEY défini') : warn('.env RENDER_API_KEY vide — npm run sync-env désactivé');
    hasGH     ? pass('.env GITHUB_TOKEN défini')   : warn('.env GITHUB_TOKEN vide — npm run enable-security désactivé');
    T(true); // info only
  } else {
    warn('.env absent — npm run sync-env + enable-security désactivés');
  }

  // ── SCORE ───────────────────────────────────────────────────────────────
  const pct = Math.round(100 * score / total);
  const clr = pct >= 90 ? G : pct >= 70 ? Y : R;
  console.log(`\n${clr}━━━ Santé globale: ${score}/${total} (${pct}%) ━━━${RS}`);
  if (pct < 100) {
    console.log(`\n${D}→ Commandes utiles:${RS}`);
    console.log(`  npm run preflight       — validate + security-status`);
    console.log(`  npm run sync-env        — push .env → Render`);
    console.log(`  npm run enable-security — active GitHub protections`);
    console.log(`  bash scripts/audit-history.sh — scan historique secrets`);
  }
  console.log('');
})().catch(e => {
  console.error(`\n${R}❌ Erreur doctor: ${e.message}${RS}`);
  process.exit(1);
});
