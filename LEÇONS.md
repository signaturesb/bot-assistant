# LEÇONS — Base de connaissances pour Claude Code

> Toute session Claude Code doit lire ce fichier avant de debugger.
> Contient les pièges déjà rencontrés et leur solution définitive.

---

## 🎯 Méthode de diagnostic rapide

**Problème bot?** → `node diagnose.js` (2 secondes, 7 checks)  
**Avant de commit?** → hook pre-commit lance `node validate.js` automatiquement  
**Déploy Render échoue?** → vérifier `startCommand` AVANT tout autre debug

---

## 🚨 Pièges Opus 4.7 (breaking changes vs 4.6)

### 1. Noms de tools — regex stricte
**Symptôme:** TOUS les messages échouent avec "Requête invalide" / HTTP 400  
**Erreur API:** `tools.X.custom.name: String should match pattern '^[a-zA-Z0-9_-]{1,128}$'`  
**Cause:** Un tool avec accent/espace/caractère spécial dans son `name`  
**Exemple vécu:** `'créer_deal'` (é) → renommé `'creer_deal'`  
**Détection:** `node validate.js` ou endpoint `/health` montrera erreurs 400 qui s'accumulent  
**Prévention:** hook pre-commit bloque automatiquement

### 2. temperature / top_p / top_k interdits
**Symptôme:** 400 immédiat  
**Cause:** Opus 4.7 refuse les valeurs non-default  
**Prévention:** `validate.js` check `claude.messages.create` params

### 3. Prefilling avec dernier message = assistant
**Symptôme:** "This model does not support assistant message prefilling"  
**Cause:** Historique corrompu, le dernier message n'est pas `role: 'user'`  
**Fix automatique:** `validateMessagesForAPI()` nettoie l'array avant envoi  
**Solution user:** `/reset` dans Telegram si ça arrive encore

---

## 🚨 Pièges Render

### 1. startCommand pointe vers fichier inexistant
**Symptôme (vécu 2026-04-22):** 10+ deploys failed, `nonZeroExit: 1` en 10s, AUCUN log, BOOT_REPORT jamais écrit  
**Cause:** Service Render configuré avec `startCommand: node index.js` mais fichier = `bot.js`  
**Détection:**
```bash
curl GET /v1/services/{id} -H "Authorization: Bearer $RENDER_API" | jq '.serviceDetails.envSpecificDetails.startCommand'
```
**Fix:** 
```bash
curl -X PATCH /v1/services/{id} -H "Authorization: Bearer $RENDER_API" \
  -d '{"serviceDetails":{"envSpecificDetails":{"startCommand":"node bot.js"}}}'
```
**Prévention:** `validate.js` check cohérence render.yaml ↔ package.json ↔ fichier réel

### 2. Health check timeout
**Symptôme:** Deploy fail en 30-120s  
**Cause:** `server.listen()` appelé trop tard dans main() (après plusieurs `await`)  
**Fix:** server.listen() en STEP 0 de main(), avant tout le reste  
**Status actuel:** déjà fixé dans bot.js ✅

### 3. Polling Telegram conflict
**Symptôme:** 404/409 pendant redéploiement, potentiel crash  
**Cause:** Deux instances partagent même token pendant zero-downtime deploy  
**Fix:** Passé en **webhook mode** au lieu de polling  
**POST /webhook/telegram** reçoit les updates

### 4. Env vars non listées via API
**Symptôme:** env var "manquante" mais bot fonctionne  
**Cause:** Environment groups Render (synced) pas exposés via `/env-vars`  
**Fix:** Ajouter explicitement via `PUT /v1/services/{id}/env-vars` avec liste COMPLÈTE

### 5. PUT env-vars REMPLACE tout
**Règle critique:** `PUT /services/{id}/env-vars` remplace TOUTES les vars  
**Fix:** toujours envoyer la liste complète (27+ vars actuellement)

---

## 🚨 Pièges Git / Repos

### Double push kira-bot + bot-assistant
Le service Render utilise `signaturesb/bot-assistant`, mais le dev se fait sur `signaturesb/kira-bot`.  
Git `origin` configuré pour push aux DEUX:
```bash
git remote set-url --add --push origin https://github.com/signaturesb/kira-bot.git
git remote set-url --add --push origin https://github.com/signaturesb/bot-assistant.git
```
Un seul `git push origin main` → Render redéploie automatiquement.

---

## 📊 Monitoring et observabilité

**URLs utiles:**
- `GET https://signaturesb-bot-s272.onrender.com/` — health check rapide (texte)
- `GET https://signaturesb-bot-s272.onrender.com/health` — JSON détaillé (subsystems, metrics, circuits)

**GitHub files (sync bot ↔ Mac):**
- `BOOT_REPORT.md` — écrit 15s après chaque boot (confirmation)
- `CRASH_REPORT.md` — écrit en cas d'erreur fatale
- `BOT_STATUS.md` — écrit chaque heure (pipeline, stats)
- `BOT_ACTIVITY.md` — écrit toutes les 10min (actions récentes)
- `SESSION_LIVE.md` — Mac → bot (je le maintiens à jour)

**Commandes Telegram:**
- `/status` — état rapide
- `/metrics` — stats (messages, API calls, erreurs, circuits)
- `/health` — same as /status + plus
- `/centris` — test login agent Centris
- `/poller` — status Gmail Lead Poller
- `/checkemail` — force scan leads 48h
- `/reset` — nouveau chat si corrompu

---

## 🛠️ Scripts outils

### `validate.js` — pre-commit (automatique via hook)
5 checks: syntaxe, tool names, temperature, cohérence render.yaml, process.exit

### `diagnose.js` — diagnostic complet (manuel)
7 sections: Bot, /health, Render deploys, env vars, GitHub reports, Code local, Git status  
Temps: ~2 secondes  
`node diagnose.js`

### `.githooks/pre-commit` — bloque commits cassés
Activé via `git config core.hooksPath .githooks`  
Bypass (dangereux): `git commit --no-verify`

### Pre-flight runtime (dans bot.js)
3 secondes après boot, test Claude API.  
Si fail → alerte Telegram instantanée avec le tool fautif.

---

## 🔑 Credentials critiques (dans Render — **jamais en clair dans le repo**)

- `TELEGRAM_BOT_TOKEN` · `TELEGRAM_ALLOWED_USER_ID`
- `ANTHROPIC_API_KEY` · `PIPEDRIVE_API_KEY` · `BREVO_API_KEY`
- `GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN` — OAuth Gmail
- `DROPBOX_APP_KEY/SECRET/REFRESH_TOKEN/ACCESS_TOKEN` — OAuth Dropbox
- `GITHUB_TOKEN` — sync BOT_STATUS, webhook
- `CENTRIS_USER` + `CENTRIS_PASS` — agent Centris
- `SIRF_USER` + `SIRF_PASS` — Registre foncier
- `GIST_ID` — mémoire persistante
- `WEBHOOK_SECRET` — pour webhooks Make.com
- `RENDER_API_KEY` + `RENDER_SERVICE_ID` — pour diagnose.js / fix.js

**Manquants optionnels:**
- `OPENAI_API_KEY` — pour Whisper (transcription vocaux). Non critique.

---

## 🧠 Architecture mentale

**Bot = 4 composantes:**
1. **Claude** (Opus 4.7) — cerveau, parse messages + appelle outils
2. **HTTP server** — webhooks Telegram/Centris/SMS + /health
3. **Intégrations** — Pipedrive, Gmail, Dropbox, GitHub, Brevo, Centris
4. **Mémoire** — Gist (faits), GitHub files (état), /tmp (session)

**Flux d'un message user:**
```
Telegram webhook → POST /webhook/telegram → bot.processUpdate →
  handler (message/photo/voice) → callClaude(chatId, msg) →
    [validate messages] [circuit check] [mTick api.claude] →
    claude.messages.create → [tool_use loop] → reply →
    [extract memos] [log activity] → send(chatId, reply)
```

**Points de défaillance possibles:**
- Avant claude.messages.create: `400` (tool name, prefill, temperature)
- Pendant tool execution: `timeout 30s` (executeToolSafe)
- API externe: circuit breaker coupe après 5 échecs (protège cascade)
- Sortie: formatAPIError convertit codes HTTP en messages français lisibles

---

## 📚 Historique des bugs résolus cette session

1. ❌ Crash polling `pollingErrors >= 10 → process.exit(1)` — fixé commit `2f164df`
2. ❌ Render startCommand `node index.js` (mauvais fichier) — fixé commit `6a2fccb`
3. ❌ Tool `créer_deal` avec accent rejeté Opus 4.7 — fixé commit `d50e129`
4. ❌ Emails/PDF sans timeout → crash silencieux — fixé commit `22de937`
5. ❌ `thinkingMode` race condition → désactivé globalement par erreur — fixé commit `22de937`
6. ❌ Gmail token null ne faisait pas fallback Brevo — fixé commit `3111f20`
7. ❌ PDF >25MB crashait Gmail — fixé commit `3111f20`
8. ❌ Conversation avec assistant en dernier message → prefilling rejeté — fixé commit `ec30aac`

---

## 🎯 Règles d'or

1. **Avant de commit code:** le pre-commit hook valide. Laisser tourner.
2. **Avant un deploy:** `node diagnose.js` doit être vert.
3. **Après push:** attendre ~90s, puis vérifier `curl /` → tools count doit matcher.
4. **Si bot silencieux:** `curl /health` pour voir les erreurs dans metrics.
5. **Si deploy fail:** checker `startCommand` EN PREMIER (piège #1).
6. **Modifier bot.js:** toujours via Edit tool, jamais Write (évite écraser).
7. **Push = push dual automatique** vers kira-bot + bot-assistant (déjà configuré).

---

**Dernière mise à jour:** 2026-04-22 — Session qui a résolu 8 bugs critiques.
