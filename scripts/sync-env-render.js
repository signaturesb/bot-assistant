#!/usr/bin/env node
// ─── scripts/sync-env-render.js ─────────────────────────────────────────────
// Synchronise ton .env local → Render env vars du service bot.
// Usage:
//   node scripts/sync-env-render.js [--dry-run]
//
// Avant: assure-toi que .env contient les valeurs à jour (notamment rotations récentes).
// Après: Render redéploie automatiquement avec les nouvelles env vars.
//
// ⚠️ RÈGLE CRITIQUE RENDER: PUT /services/{id}/env-vars REMPLACE toutes les
//    env vars existantes. Ce script lit TOUTES les vars de .env et les push.
//    Les vars existantes non-présentes dans .env seront SUPPRIMÉES.
//    → En mode --dry-run on affiche le diff sans modifier.

'use strict';
require('dotenv').config();
const fs = require('fs');
const https = require('https');

const API_KEY = process.env.RENDER_API_KEY;
const SERVICE = process.env.RENDER_SERVICE_ID || 'srv-d7fh9777f7vs73a15ddg';
const DRY     = process.argv.includes('--dry-run');

if (!API_KEY) {
  console.error('❌ RENDER_API_KEY manquant dans .env');
  process.exit(1);
}

function renderAPI(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.render.com',
      path: `/v1${path}`,
      method,
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode} ${path}: ${chunks}`));
        try { resolve(chunks ? JSON.parse(chunks) : null); }
        catch { resolve(chunks); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function parseDotEnv(path) {
  if (!fs.existsSync(path)) return {};
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const i = trimmed.indexOf('=');
    if (i < 0) continue;
    const k = trimmed.slice(0, i).trim();
    let v = trimmed.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k && v) out[k] = v;
  }
  return out;
}

// Clés à ne PAS envoyer vers Render (vars locales uniquement)
const LOCAL_ONLY = new Set([
  'RENDER_API_KEY',
  'RENDER_SERVICE_ID',
  'BOT_URL',
  'GITHUB_REPO',
]);

(async () => {
  console.log(`🔄 Sync .env → Render service ${SERVICE}${DRY ? ' (DRY RUN)' : ''}\n`);

  const local = parseDotEnv('.env');
  const localKeys = Object.keys(local).filter(k => !LOCAL_ONLY.has(k));
  if (!localKeys.length) {
    console.error('❌ Aucune variable utilisable dans .env');
    process.exit(1);
  }

  const remote = await renderAPI('GET', `/services/${SERVICE}/env-vars?limit=100`);
  const remoteMap = {};
  for (const item of remote) {
    const v = item.envVar || item;
    remoteMap[v.key] = v.value;
  }

  const added = localKeys.filter(k => !(k in remoteMap));
  const changed = localKeys.filter(k => k in remoteMap && remoteMap[k] !== local[k]);
  const removed = Object.keys(remoteMap).filter(k => !(k in local));

  console.log(`  + ${added.length} nouvelles: ${added.join(', ') || '—'}`);
  console.log(`  ~ ${changed.length} modifiées: ${changed.join(', ') || '—'}`);
  console.log(`  − ${removed.length} supprimées: ${removed.join(', ') || '—'}\n`);

  if (DRY) {
    console.log('✅ DRY RUN — aucune modification faite');
    return;
  }

  if (removed.length) {
    console.log(`⚠️  ${removed.length} vars seront supprimées de Render. Ctrl+C pour annuler (3s)...`);
    await new Promise(r => setTimeout(r, 3000));
  }

  const payload = localKeys.map(k => ({ key: k, value: local[k] }));
  await renderAPI('PUT', `/services/${SERVICE}/env-vars`, payload);
  console.log(`✅ ${localKeys.length} env vars synchronisées. Render redéploie dans ~30s.`);
})().catch(e => {
  console.error(`❌ Erreur: ${e.message}`);
  process.exit(1);
});
