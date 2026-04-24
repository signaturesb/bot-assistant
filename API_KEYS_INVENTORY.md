---
name: Inventaire clés API — où elles vivent + comment les récupérer
description: Mapping exhaustif des services externes, leurs env vars, leurs scopes, et procédure de récupération/rotation. Pour éviter de recréer à chaque session.
type: reference
originSessionId: 123c6523-786e-45b3-be63-c08bf99b99bc
---
# 🔑 Inventaire complet des clés API

**Règle absolue de sécurité:** les VALEURS des clés ne sont jamais écrites dans ce fichier ni dans aucune mémoire. Seulement les NOMS des env vars, où elles vivent, et la procédure pour les utiliser/régénérer.

## Source de vérité

**Toutes les env vars de prod** sont sur **Render** pour le service `srv-d7fh9777f7vs73a15ddg` (bot-assistant, URL: signaturesb-bot-s272.onrender.com).

Deux façons d'y accéder:
1. **Dashboard Render:** https://dashboard.render.com → srv-d7fh9777f7vs73a15ddg → Environment
2. **API Render:** `curl -H "Authorization: Bearer $RENDER_API_KEY" https://api.render.com/v1/services/srv-d7fh9777f7vs73a15ddg/env-vars`

**⚠️ RÈGLE CRITIQUE** (déjà dans CLAUDE.md): `PUT /services/{id}/env-vars` remplace TOUTES — toujours envoyer la liste complète.

## Services + env vars (mapping complet)

### Telegram
- `TELEGRAM_BOT_TOKEN` — token du bot kira (@signaturesb_bot). Rotation via BotFather sur Telegram si compromis.
- `TELEGRAM_ALLOWED_USER_ID=5261213272` — User ID Shawn (hardcoded, pas sensible). Pour le retrouver: `curl https://api.telegram.org/bot<token>/getUpdates`.
- `TELEGRAM_WEBHOOK_SECRET` — secret X-Telegram-Bot-Api-Secret-Token pour authentifier les webhooks entrants. Peut être n'importe quelle string random — bot la valide automatiquement.

### Anthropic (Claude)
- `ANTHROPIC_API_KEY` — clé Opus/Sonnet/Haiku. Dashboard: https://console.anthropic.com/settings/keys
- Usage actuel: default sonnet 4.6, routing auto Opus 4.7 sur mots-clés complexes
- Modèles actifs: `claude-sonnet-4-6`, `claude-opus-4-7`, `claude-haiku-4-5` (pour healthcheck léger)
- Cost tracker intégré alerte à $10/jour et $100/mois

### Gmail (Google Workspace OAuth)
- `GMAIL_CLIENT_ID` — ID OAuth client
- `GMAIL_CLIENT_SECRET` — secret OAuth client  
- `GMAIL_REFRESH_TOKEN` — refresh token pour shawn@signaturesb.com
- Scopes requis: `https://www.googleapis.com/auth/gmail.readonly` + `gmail.send` + `gmail.modify` (pour trash auto)
- Dashboard: https://console.cloud.google.com/apis/credentials
- Procédure régen refresh token: voir `project_toolkit.md` ou `scripts/oauth-gmail.js` si existant

### Dropbox
- `DROPBOX_ACCESS_TOKEN` — token court-durée (auto-refresh via refresh token aux 3h)
- `DROPBOX_REFRESH_TOKEN` — refresh token long-durée
- `DROPBOX_APP_KEY` — app key OAuth
- `DROPBOX_APP_SECRET` — app secret OAuth
- Dashboard: https://www.dropbox.com/developers/apps
- App: "Kira Bot" (ou similaire)

### Pipedrive (CRM)
- `PIPEDRIVE_API_KEY` — clé API personnelle de Shawn
- Dashboard: https://signaturesb.pipedrive.com/settings/api (ou nom du compte)
- Pipeline ID: 7 (hardcoded dans bot.js)
- Champs custom (hardcoded):
  - Type: `d8961ad7b8b9bf9866befa49ff2afae58f9a888e`
  - Séquence: `17a20076566919bff80b59f06866251ed250fcab`
  - Centris: `22d305edf31135fc455a032e81582b98afc80104`

### Brevo (ex-Sendinblue) — email + SMS
- `BREVO_API_KEY` — dashboard: https://app.brevo.com/settings/keys/api
- Listes: prospects=4, acheteurs=5, vendeurs=7
- Template ID 43 = version bot (⚠️ NE JAMAIS modifier logos base64)
- Sender SMS configuré: "KiraBot"
- Numéro Shawn pour SMS fallback: 514-927-1340 (extrait de AGENT.telephone)

### OpenAI (Whisper vocaux)
- `OPENAI_API_KEY` — optionnel, pour transcription audio messages Telegram
- Dashboard: https://platform.openai.com/api-keys
- **Actuellement absent dans Render** → Whisper désactivé

### GitHub
- `GITHUB_TOKEN` — PAT (personal access token) pour:
  - Lire/écrire dans `signaturesb/kira-bot` (dev)
  - Lire/écrire dans `signaturesb/bot-assistant` (prod Render)
  - Créer Gists (backup state)
  - Créer Issues (escalation)
- Dashboard: https://github.com/settings/tokens
- Scopes requis: `repo`, `gist`, `workflow`

### Gist (persistance state)
- `GIST_ID` — ID du Gist de backup (auto-créé au boot si absent — bot envoie alerte Telegram avec l'ID à ajouter dans Render)

### Centris (site courtier)
- `CENTRIS_USER` — code courtier (hardcoded dans session actuelle: 110509)
- `CENTRIS_PASS` — password
- URL: https://agent.centris.ca (authenticated)
- Usage: agent Centris pour comparables vendus/en vigueur

### Render (meta — pour le bot lui-même)
- `RENDER_API_KEY` — clé API Render (hors service, env var locale/personnelle Shawn)
- Service ID: `srv-d7fh9777f7vs73a15ddg`
- Commandes utiles:
  ```
  # Lister tous les env vars
  curl -H "Authorization: Bearer $RENDER_API_KEY" https://api.render.com/v1/services/srv-d7fh9777f7vs73a15ddg/env-vars
  # Voir deploys récents (identifier Failed)
  curl -H "Authorization: Bearer $RENDER_API_KEY" https://api.render.com/v1/services/srv-d7fh9777f7vs73a15ddg/deploys?limit=10
  # Logs service
  curl -H "Authorization: Bearer $RENDER_API_KEY" https://api.render.com/v1/services/srv-d7fh9777f7vs73a15ddg/logs?limit=100
  ```
- **Env vars RENDER_GIT_COMMIT et RENDER_GIT_BRANCH** sont auto-injectées par Render à chaque build — pas besoin de les créer. Bot les utilise dans /health et /version.

### Env vars auxiliaires
- `SHAWN_EMAIL=shawn@signaturesb.com` — email courtier (identifie aussi AGENT.email)
- `JULIE_EMAIL=julie@signaturesb.com` — assistante, fallback digest
- `POLLER_ENABLED` (optionnel, default true) — kill-switch poller
- `AUTO_SEND_THRESHOLD` (optionnel, default 75) — seuil match Dropbox pour auto-envoi
- `GMAIL_POLL_INTERVAL_MS` (optionnel, default 30000) — interval polling
- `AGENT_*` (multi-courtier SaaS) — AGENT_NOM, AGENT_TEL, AGENT_COMPAGNIE, AGENT_REGION, AGENT_COULEUR, DBX_TERRAINS, etc.

## Procédure de récupération si perte de clé

1. **Telegram bot token:** BotFather → `/mybots` → `signaturesb_bot` → "API Token" → Revoke + nouveau
2. **Anthropic:** console.anthropic.com → Settings → API Keys → Delete + Create
3. **Gmail refresh:** revoquer dans Google Cloud Console → re-exécuter OAuth flow (scripts/oauth-gmail.js si existant — sinon setup interactif une fois)
4. **Dropbox:** dashboard → App → Reset refresh token
5. **Pipedrive:** Personal preferences → API → Generate new
6. **Brevo:** Settings → API Keys → Create
7. **GitHub:** Settings → Developer settings → Personal access tokens → Regenerate
8. **Centris:** reset password via formulaire agent (si compromis)
9. **Render API key:** dashboard user settings → API Keys → Generate

## Où Shawn peut trouver ses clés (hors Render)

- **Password manager** (probablement Apple Keychain sur Mac + iPhone — à confirmer si/quand demandé)
- **Render dashboard** (env vars prod) → c'est la source de vérité
- **Email d'onboarding** de chaque service (dernière ressource)

## Scripts utilitaires existants

- `scripts/sync-env-render.js` — sync .env local → Render (voir `npm run sync-env`)
- `scripts/rotate-render-key.js` — rotation de la clé Render en 1 commande (mentionné dans les logs de commits)
- `scripts/doctor.js` — vérifie env vars et connectivité (`npm run doctor`)
- `scripts/audit-history.sh` — audit bash de l'historique

## Accès pour moi (Claude Code)

Ce dont j'ai besoin pour agir en autonomie:
- ✅ Accès au repo local (read/write bot.js) — OK
- ✅ gh CLI authentifié (push GitHub) — OK
- ⚠️ **RENDER_API_KEY pas dans mon environment shell** — je ne peux pas:
  - Voir les logs Render pour debugger un crash
  - Voir les env vars configurés
  - Voir le statut des deploys (Failed/Live)
  - Faire un manual deploy
- ⚠️ **WEBHOOK_SECRET pas dans mon environment** — je ne peux pas curl les endpoints /admin/*

**Pour optimiser:** si Shawn veut que je diagnostique à distance plus efficacement, il peut:
1. Mettre `RENDER_API_KEY` dans mon shell env → je peux voir deploys + logs
2. Mettre `WEBHOOK_SECRET` → je peux curl /admin/audit, /admin/diagnose pour debug instant
3. Alternativement: créer un endpoint `/admin/logs?token=X&tail=200` qui retourne les logs Render au bot lui-même (les stocke déjà en `bootLogsCapture`)

## À faire (nice-to-have futurs)

- [ ] Endpoint `/admin/logs?token=X&tail=200` pour streamer les logs sans Render API
- [ ] Script `scripts/list-keys.js` qui mape RENDER env vars ↔ code usage (audit automatique)
- [ ] Add `RENDER_API_KEY` presence check dans /diagnose
