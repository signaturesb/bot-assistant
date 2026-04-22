#!/usr/bin/env node
// ─── fix.js — Auto-réparation des problèmes courants ────────────────────────
// Usage: node fix.js [problem]
// Sans argument: détecte les problèmes et propose les fixes

'use strict';
const https = require('https');
const fs = require('fs');
const { execSync } = require('child_process');

require('dotenv').config();
const creds = {
  RENDER_API:     process.env.RENDER_API_KEY || '',
  RENDER_SERVICE: process.env.RENDER_SERVICE_ID || 'srv-d7fh9777f7vs73a15ddg',
  BOT_URL:        process.env.BOT_URL || 'https://signaturesb-bot-s272.onrender.com',
};
if (!creds.RENDER_API) {
  console.error('❌ RENDER_API_KEY manquant dans .env');
  process.exit(1);
}

async function fetch(url, opts = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: opts.method || 'GET', headers: opts.headers || {},
    }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => res({ status: resp.statusCode, body: data }));
    });
    req.on('error', rej);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const fixes = {
  async 'deploy-force'() {
    console.log('🚀 Forcer un redeploy Render...');
    const r = await fetch(`https://api.render.com/v1/services/${creds.RENDER_SERVICE}/deploys`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.RENDER_API}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearCache: 'do_not_clear' }),
    });
    if (r.status === 201 || r.status === 200) {
      const d = JSON.parse(r.body);
      console.log(`✅ Deploy déclenché: ${d.id}`);
    } else console.error(`❌ HTTP ${r.status}: ${r.body}`);
  },

  async 'deploy-clear-cache'() {
    console.log('🚀 Redeploy avec cache clearé...');
    const r = await fetch(`https://api.render.com/v1/services/${creds.RENDER_SERVICE}/deploys`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${creds.RENDER_API}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearCache: 'clear' }),
    });
    console.log(r.status === 201 ? '✅ Deploy+cache clear déclenché' : `❌ HTTP ${r.status}`);
  },

  async 'start-command'() {
    console.log('🔧 Fixer Render startCommand → node bot.js...');
    const r = await fetch(`https://api.render.com/v1/services/${creds.RENDER_SERVICE}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${creds.RENDER_API}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceDetails: { envSpecificDetails: { buildCommand: 'npm install', startCommand: 'node bot.js' } } }),
    });
    if (r.status === 200) console.log('✅ startCommand = node bot.js');
    else console.error(`❌ HTTP ${r.status}: ${r.body}`);
  },

  async 'install-hooks'() {
    console.log('🔧 Installer git hooks...');
    execSync('git config core.hooksPath .githooks');
    execSync('chmod +x .githooks/pre-commit validate.js diagnose.js fix.js', { stdio: 'pipe' });
    console.log('✅ Git hooks activés (pre-commit auto)');
  },

  async 'validate'() {
    console.log('🔍 Validation complète...');
    try { execSync('node validate.js', { stdio: 'inherit' }); }
    catch (e) { process.exit(1); }
  },

  async 'push-dual'() {
    console.log('🔧 Configurer push dual (kira-bot + bot-assistant)...');
    try { execSync('git remote set-url --delete --push origin https://github.com/signaturesb/kira-bot.git 2>/dev/null || true'); } catch {}
    try { execSync('git remote set-url --delete --push origin https://github.com/signaturesb/bot-assistant.git 2>/dev/null || true'); } catch {}
    execSync('git remote set-url --add --push origin https://github.com/signaturesb/kira-bot.git');
    execSync('git remote set-url --add --push origin https://github.com/signaturesb/bot-assistant.git');
    console.log('✅ Push dual configuré — un seul `git push origin main` push vers les 2 repos');
    execSync('git remote -v', { stdio: 'inherit' });
  },

  async 'test-centris'() {
    console.log('🔐 Test login Centris agent...');
    const user = process.env.CENTRIS_USER, pass = process.env.CENTRIS_PASS;
    if (!user || !pass) return console.error('❌ CENTRIS_USER/CENTRIS_PASS manquants dans .env');
    console.log(`User: ${user} | Tester via Telegram: /centris`);
  },

  async 'bot-status'() {
    console.log('📊 Bot production status...');
    const r = await fetch(`${creds.BOT_URL}/health`);
    if (r.status !== 200) return console.error(`❌ Bot injoignable (HTTP ${r.status})`);
    const d = JSON.parse(r.body);
    console.log(`\n✅ Uptime: ${d.uptime_human} | Modèle: ${d.model} | Tools: ${d.tools}`);
    console.log(`\nSubsystems:`);
    Object.entries(d.subsystems).forEach(([k, v]) => console.log(`  ${v ? '✅' : '❌'} ${k}`));
    const errs = d.metrics?.errors?.total || 0;
    console.log(`\nErreurs: ${errs} ${errs > 0 ? `(${JSON.stringify(d.metrics.errors.byStatus)})` : ''}`);
    console.log(`Messages: text=${d.metrics?.messages?.text||0} voice=${d.metrics?.messages?.voice||0} photo=${d.metrics?.messages?.photo||0} pdf=${d.metrics?.messages?.pdf||0}`);
    const openCircuits = Object.entries(d.circuits||{}).filter(([,v])=>v.open).map(([k])=>k);
    if (openCircuits.length) console.log(`⚠️ Circuits ouverts: ${openCircuits.join(', ')}`);
  },
};

const arg = process.argv[2];
if (!arg) {
  console.log('🛠️  Commands disponibles:\n');
  for (const cmd of Object.keys(fixes)) {
    console.log(`  node fix.js ${cmd}`);
  }
  console.log(`\nExamples:
  node fix.js bot-status       # Status complet production
  node fix.js validate         # Valider code avant commit
  node fix.js deploy-force     # Forcer un redeploy Render
  node fix.js install-hooks    # Activer git hooks pre-commit
  node fix.js push-dual        # Configurer push kira-bot + bot-assistant`);
  process.exit(0);
}

const fn = fixes[arg];
if (!fn) { console.error(`❌ Commande inconnue: ${arg}`); process.exit(1); }
fn().catch(e => { console.error(`❌ ${e.message}`); process.exit(1); });
