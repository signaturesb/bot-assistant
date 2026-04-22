# ÉTAT DU SYSTÈME — Signature SB Bot

> Référence permanente. Mis à jour après chaque session.
> Si conversation interrompue: lire ce fichier pour reprendre exactement.

**Dernière mise à jour:** 2026-04-19  
**Dernier commit:** 3b10a9e  
**Taille bot.js:** 2996 lignes  
**Outils actifs:** 40  
**Modèle:** claude-opus-4-7

---

## SURVEILLANCE AUTOMATIQUE — EN PRODUCTION

| Feature | Fréquence | Status |
|---|---|---|
| Gmail Lead Poller | Toutes les 5min | ✅ Actif |
| Reload structure Dropbox | Toutes les 30min | ✅ Actif |
| Refresh token Dropbox | Toutes les 3h | ✅ Actif |
| Rappel visites matin | 7h quotidien | ✅ Actif |
| Digest Julie | 8h quotidien | ✅ Actif |
| Sync BOT_STATUS.md → GitHub | 18h quotidien | ✅ Actif |

---

## GMAIL LEAD POLLER (commit 3b10a9e)

**Fichier état:** `/data/gmail_poller.json`

Sources surveillées:
- Centris.ca (`from:centris`)
- RE/MAX Québec (`from:remax`)
- Realtor.ca / DuProprio
- Demandes directes (sujet: demande/lead/prospect/visite/information)

Pour chaque lead détecté:
1. Extrait: nom, téléphone, email, Centris#, adresse, type propriété
2. Crée deal Pipedrive (cherche personne existante d'abord)
3. Cherche docs dans Dropbox /Terrain en ligne/ par Centris#
4. Stocke brouillon J+0 → Shawn dit "envoie"
5. Notifie Telegram immédiatement

Commandes:
- `/checkemail` → force scan 48h (pour retrouver leads manqués)
- `/poller` → statut, dernier scan, total leads traités

---

## FLOWS — TOUS PARFAITS

| Flow | Status | Notes |
|---|---|---|
| Email (Gmail → Brevo fallback) | ✅ Parfait | Auto-fallback si Gmail fail |
| Envoi docs Dropbox (Gmail avec PJ) | ✅ Parfait | Limite 24MB, note honnête |
| Création deal Pipedrive | ✅ Parfait | Cherche person existante |
| Gmail Lead Poller | ✅ Actif | Scan 5min continu |
| Webhooks Centris/SMS/reply | ✅ Actif | Auto-deal + brouillon |
| Vision photos/PDFs | ✅ Actif | Opus 4.7 natif |
| Vocaux Whisper | ✅ Actif | |
| Thinking mode (/penser) | ✅ Actif | 10k tokens |

---

## TOUTES LES FONCTIONNALITÉS

| Feature | Status |
|---|---|
| Pipedrive complet (14 outils) | ✅ |
| `voir_prospect_complet` (inclut Gmail) | ✅ |
| `prospects_stagnants` | ✅ |
| `changer_etape` | ✅ |
| `voir_activites` | ✅ |
| `modifier_deal` | ✅ |
| `creer_activite` | ✅ |
| Dropbox profond (cache terrains) | ✅ |
| `chercher_listing_dropbox` | ✅ |
| `envoyer_docs_prospect` | ✅ |
| Gmail Lead Poller | ✅ |
| Vision photos | ✅ |
| PDFs | ✅ |
| Brevo email mass | ✅ (node launch.js) |
| Contacts iPhone (vcf) | ✅ |
| `historique_contact` | ✅ |
| `repondre_vite` | ✅ |
| GitHub read/write | ✅ |
| AGENT_CONFIG SaaS | ✅ |
| Prompt caching optimisé | ✅ |
| Webhook sécurité (WEBHOOK_SECRET) | ✅ |
| Sync BOT_STATUS.md GitHub | ✅ |
| J+1/J+3/J+7 | ⏸️ SUR GLACE |
| Comparables Centris | ❌ À implémenter |
| Registre foncier SIRF | ❌ À implémenter |
| DuProprio comparison | ❌ À implémenter |

---

## ARCHITECTURE

### Prompt Caching
- `SYSTEM_BASE` (statique) → `cache_control: ephemeral` → toujours en cache
- `getSystemDynamic()` (Dropbox + mémoire) → pas en cache
- Résultat: ~80% moins de cache misses

### Sécurité
- `WEBHOOK_SECRET` validé sur `/webhook/*`
- `isDuplicate()` Map FIFO max 2000 entrées
- `executeToolSafe()` timeout 30s
- Gist sync throttlé 5min

### `send()` robuste
- `stripMarkdown()` avant fallback → texte lisible même si Markdown fail

---

## PIPEDRIVE

Pipeline ID: 7 (via `AGENT.pipeline_id`)  
Étapes: 49(Nouveau)→50(Contacté)→51(Discussion)→52(Visite prévue)→53(Visite faite)→54(Offre)→55(Gagné)

Champs:
- Type: `d8961ad7b8b9bf9866befa49ff2afae58f9a888e`
- Séquence: `17a20076566919bff80b59f06866251ed250fcab`
- Centris: `22d305edf31135fc455a032e81582b98afc80104`

---

## DROPBOX

Paths: `/Terrain en ligne/` · `/Liste de contact/email_templates/` · `/Contacts/`  
Cache `dropboxTerrains[]`: {name, path, centris, adresse} — lookup O(1) par Centris  
Template: `/Liste de contact/email_templates/master_template_signature_sb.html`  
Brevo template ID 43 = version production bot

---

## ENV VARS RENDER

```
TELEGRAM_BOT_TOKEN · TELEGRAM_ALLOWED_USER_ID=5261213272
ANTHROPIC_API_KEY · OPENAI_API_KEY
PIPEDRIVE_API_KEY · BREVO_API_KEY
GMAIL_CLIENT_ID · GMAIL_CLIENT_SECRET · GMAIL_REFRESH_TOKEN
DROPBOX_ACCESS_TOKEN · DROPBOX_REFRESH_TOKEN · DROPBOX_APP_KEY · DROPBOX_APP_SECRET
SHAWN_EMAIL · JULIE_EMAIL · GIST_ID · GITHUB_TOKEN · WEBHOOK_SECRET
SIRF_USER · SIRF_PASS  (valeurs en env vars — jamais en clair ici)
AGENT_NOM · AGENT_PRENOM · AGENT_TEL · AGENT_COMPAGNIE · (autres AGENT_* optionnels)
```

**RÈGLE CRITIQUE:** PUT /services/{id}/env-vars remplace TOUTES — envoyer liste complète.

---

## À FAIRE PROCHAINES SESSIONS

1. `chercher_comparables` — scraping Centris sold
2. `comparer_marche` — DuProprio
3. `registre_foncier` — SIRF + Infolot + APCIQ
4. Couverture géo 60+ muns
5. `PERPLEXITY_API_KEY` dans Render
6. Make.com webhooks → signaturesb-bot-s272.onrender.com
7. Réactiver J+1/J+3/J+7 (décommenter cron ~ligne 2425)
