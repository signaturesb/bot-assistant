#!/usr/bin/env node
// ─── scripts/rotate-render-key.js ───────────────────────────────────────────
// Pipeline complet pour rotater la RENDER_API_KEY en 1 commande:
//   1. Tu fournis la nouvelle clé (arg ou stdin)
//   2. Script valide (appel /v1/owners)
//   3. Si OK → met dans .env local
//   4. (optionnel) --revoke-old pour révoquer l'ancienne via API si supportée
//
// Usage:
//   node scripts/rotate-render-key.js rnd_NEWKEYHERE

'use strict';
require('dotenv').config();
const fs = require('fs');
const https = require('https');

const args = process.argv.slice(2);
const newKey = args[0];
if (!newKey || !newKey.startsWith('rnd_')) {
  console.error('Usage: node scripts/rotate-render-key.js rnd_XXXXXXXXXXXXXXXX');
  console.error('Obtiens une nouvelle clé: https://dashboard.render.com/u/settings/api-keys');
  process.exit(1);
}

function renderAPI(method, path, key, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.render.com',
      path: `/v1${path}`,
      method,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${chunks}`));
        try { resolve(chunks ? JSON.parse(chunks) : null); } catch { resolve(chunks); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // 1. Valider la nouvelle clé
  console.log('→ Validation nouvelle clé...');
  try {
    const owners = await renderAPI('GET', '/owners', newKey);
    const owner = owners?.[0]?.owner;
    console.log(`  ✅ Clé valide · Owner: ${owner?.email} (${owner?.name}, ${owner?.type})`);
  } catch (e) {
    console.error(`  ❌ Clé invalide: ${e.message}`);
    process.exit(1);
  }

  // 2. Tester accès au service bot
  const SERVICE = process.env.RENDER_SERVICE_ID || 'srv-d7fh9777f7vs73a15ddg';
  try {
    const svc = await renderAPI('GET', `/services/${SERVICE}`, newKey);
    console.log(`  ✅ Accès service confirmé: ${svc.name} (${svc.serviceDetails?.url || 'no url'})`);
  } catch (e) {
    console.error(`  ❌ Service inaccessible: ${e.message}`);
    process.exit(1);
  }

  // 3. Update .env local (atomic write)
  const envPath = '.env';
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  if (env.match(/^RENDER_API_KEY=/m)) {
    env = env.replace(/^RENDER_API_KEY=.*$/m, `RENDER_API_KEY=${newKey}`);
  } else {
    env += `\nRENDER_API_KEY=${newKey}\n`;
  }
  fs.writeFileSync(`${envPath}.tmp`, env);
  fs.renameSync(`${envPath}.tmp`, envPath);
  console.log(`  ✅ .env updated`);

  // 4. Push la nouvelle clé dans Render env vars aussi (cohérence)
  try {
    const items = await renderAPI('GET', `/services/${SERVICE}/env-vars?limit=100`, newKey);
    const pairs = items.map(it => ({ ...it.envVar }));
    let updated = false;
    for (const p of pairs) {
      if (p.key === 'RENDER_API_KEY') {
        p.value = newKey;
        updated = true;
        break;
      }
    }
    if (!updated) pairs.push({ key: 'RENDER_API_KEY', value: newKey });
    await renderAPI('PUT', `/services/${SERVICE}/env-vars`, newKey, pairs);
    console.log(`  ✅ Render env vars: RENDER_API_KEY ${updated ? 'updated' : 'added'}`);
  } catch (e) {
    console.log(`  ⚠️ Push Render env: ${e.message}`);
  }

  // 5. Nettoyer temp files potentiels
  const tmpFiles = ['/tmp/_gh', '/tmp/kira_gh_token.txt', '/tmp/render_test.json'];
  for (const f of tmpFiles) {
    if (fs.existsSync(f)) {
      try { fs.unlinkSync(f); console.log(`  ✅ temp cleaned: ${f}`); } catch {}
    }
  }

  console.log('\n🎉 Rotation Render API key terminée.');
  console.log('\n⚠️ Dernière étape manuelle: supprimer la VIEILLE clé sur Render:');
  console.log('   https://dashboard.render.com/u/settings/api-keys');
})().catch(e => {
  console.error(`❌ ${e.message}`);
  process.exit(1);
});
