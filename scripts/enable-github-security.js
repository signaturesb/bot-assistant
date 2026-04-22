#!/usr/bin/env node
// ─── scripts/enable-github-security.js ──────────────────────────────────────
// Active sur les 2 repos GitHub (signaturesb/kira-bot + signaturesb/bot-assistant):
//   - Secret scanning
//   - Push protection (bloque les commits contenant des secrets détectés)
//   - Dependabot vulnerability alerts
//   - Private vulnerability reporting
//
// Usage:
//   export GITHUB_TOKEN=ghp_xxx  # token avec scope `repo` + `admin:repo_hook`
//   node scripts/enable-github-security.js
//
// One-shot: rouler une fois après régénération du token GitHub.

'use strict';
require('dotenv').config();
const https = require('https');

const TOKEN = process.env.GITHUB_TOKEN;
const REPOS = ['signaturesb/kira-bot', 'signaturesb/bot-assistant'];

if (!TOKEN) {
  console.error('❌ GITHUB_TOKEN manquant (scope: repo + admin:repo_hook)');
  process.exit(1);
}

function gh(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${TOKEN}`,
        'Accept':        'application/vnd.github+json',
        'User-Agent':    'signaturesb-security-setup',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        const payload = chunks ? (() => { try { return JSON.parse(chunks); } catch { return chunks; } })() : null;
        if (res.statusCode >= 400) {
          const msg = payload?.message || chunks;
          return reject(new Error(`HTTP ${res.statusCode} ${method} ${path}: ${msg}`));
        }
        resolve({ status: res.statusCode, body: payload });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function enableForRepo(repo) {
  console.log(`\n📦 ${repo}`);

  // 1. Secret scanning + push protection (via PATCH security_and_analysis)
  try {
    await gh('PATCH', `/repos/${repo}`, {
      security_and_analysis: {
        secret_scanning: { status: 'enabled' },
        secret_scanning_push_protection: { status: 'enabled' },
        secret_scanning_validity_checks: { status: 'enabled' },
      },
    });
    console.log('  ✅ Secret scanning + push protection activés');
  } catch (e) {
    // Plans gratuits: secret_scanning only enabled via UI; push_protection est GA publique
    console.log(`  ⚠️ Secret scanning: ${e.message}`);
    console.log(`     → Active manuellement: https://github.com/${repo}/settings/security_analysis`);
  }

  // 2. Dependabot vulnerability alerts
  try {
    await gh('PUT', `/repos/${repo}/vulnerability-alerts`, null);
    console.log('  ✅ Dependabot vulnerability alerts activés');
  } catch (e) {
    console.log(`  ⚠️ Dependabot alerts: ${e.message}`);
  }

  // 3. Dependabot automated security fixes
  try {
    await gh('PUT', `/repos/${repo}/automated-security-fixes`, null);
    console.log('  ✅ Dependabot auto security fixes activés');
  } catch (e) {
    console.log(`  ⚠️ Auto security fixes: ${e.message}`);
  }

  // 4. Private vulnerability reporting
  try {
    await gh('PUT', `/repos/${repo}/private-vulnerability-reporting`, null);
    console.log('  ✅ Private vulnerability reporting activé');
  } catch (e) {
    console.log(`  ⚠️ Private vuln reporting: ${e.message}`);
  }
}

(async () => {
  console.log('🔒 Activation sécurité GitHub pour les 2 repos bot\n');
  for (const repo of REPOS) {
    await enableForRepo(repo);
  }
  console.log('\n✅ Terminé. Vérifie manuellement les settings:');
  for (const r of REPOS) console.log(`   https://github.com/${r}/settings/security_analysis`);
})().catch(e => {
  console.error(`\n❌ Erreur fatale: ${e.message}`);
  process.exit(1);
});
