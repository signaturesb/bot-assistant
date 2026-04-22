# SESSION LIVE — 2026-04-22 00:15

## 🎯 RÉSOLU: startCommand Render pointait vers `index.js` inexistant!

**Cause racine de TOUS les deploy fails depuis c209c9e:**
Service Render (via UI) configuré avec `startCommand: node index.js`
Mais notre fichier est `bot.js` (package.json main: bot.js)
→ Node exit 1 immédiat, AUCUN code bot.js jamais exécuté.

**Symptômes qui auraient dû m'alerter plus tôt:**
- Exit code 1 toujours en ~10s (Node peut pas trouver index.js)
- Build succeed, deploy fail (npm install OK, rien à exécuter)
- AUCUN log de bot.js (pas de CRASH_REPORT, pas de BOOT_REPORT)
- Même un bot.js minimal de 35 lignes crashait

**Fix (commit 6a2fccb + 39e6561) — LIVE ✅:**
- `PATCH /v1/services/{id}` → `startCommand: node bot.js`
- bot.js restauré (4048 lignes, 39 outils, webhook Telegram)
- Deploy `dep-xxx | live | 39e6561` — confirmation health 200 + BOOT_REPORT écrit

**Production live confirmé 2026-04-22 00:12:**
- tools: 39
- model: claude-opus-4-7
- subsystems ✅: pipedrive, brevo, gmail, dropbox, github, gist
- ⏳: centris (lazy login au 1er call)
- ❌: whisper (OPENAI_API_KEY absent — optionnel)

**RÈGLE À RETENIR:**
Toujours vérifier la config Render `startCommand` si deploy fail sans logs.
Commande: `curl GET /v1/services/{id}` → vérifier `serviceDetails.envSpecificDetails.startCommand`

---

## 🚨 ANCIENNE SECTION — BUG CRITIQUE (conservée pour historique)

**Render deploy failed 5× de suite** — cause identifiée via run local:

```
[POLL] #1-10: ETELEGRAM: 404 Not Found
[POLL] Restart forcé... → process.exit(1)
```

**Root cause:** Code ligne ~2986 de bot.js:
```javascript
if (pollingErrors >= 10) { log('WARN', 'POLL', 'Restart forcé...'); process.exit(1); }
```

Quand Render déploie: 2 instances (vieille + nouvelle) partagent TELEGRAM_BOT_TOKEN.
Telegram ne permet qu'une instance à polling → 404 sur la plus récente.
Après 10 erreurs → `process.exit(1)` → Render marque deploy failed.

**Fix à appliquer:**
- RETIRER le `process.exit(1)` sur polling errors
- Backoff exponentiel au lieu de crash
- Reset `pollingErrors` sur premier succès

## 🐛 BUG #2: Comparables Centris

Shawn voit dans la preview HTML des numéros Centris fictifs. Le scraping Centris actuel peut retourner peu/pas de vrais résultats car:
- Centris.ca utilise React/SSR
- Les données viennent d'appels API internes
- Le scraping HTML direct capture peu d'info

**Solution à implémenter:** reverse-engineer l'API Centris interne (utilisée par leur JS) ou utiliser Matrix Centris (système agent).

## 📊 État des deploys

| Commit | Deploy | Status |
|---|---|---|
| c5241958 | dep-d7k3nfbrjlhs73botbo0 | failed (polling crash) |
| 776e3f39 | dep-d7k3d0f41pts73en8tpg | failed |
| a8348e57 | dep-d7k3amn41pts73en869g | failed |
| ec30aacb | dep-d7k31vaqqhas73cg65rg | failed |
| c209c9ea | dep-d7k2qpf41pts73en2ba0 | failed |
| 2b815d27 | dep-d7k2m4cm0tmc73aa9gtg | **LIVE** (ancien, 28 tools) |

Actuellement en production: `2b815d27` (ancien code, 28 tools).
Les 5 derniers commits contiennent toutes les features mais ne sont pas déployés.

## ⚡ PLAN IMMÉDIAT

1. Fix `pollingErrors → process.exit(1)` → backoff doux
2. Commit + push → Render va enfin pouvoir déployer
3. Vérifier /health ensuite
4. Puis aborder le Centris scraping amélioré

## 🗂️ Commits à venir

- ✅ Fix polling crash (priorité 1) — commit 2f164df poussé
- ✅ Debug verbose + auto-reporting GitHub — commit b084701
- ✅ **FIX CRITIQUE**: `server.listen()` en Step 0 (commit cd92e0f) — causait timeout health check Render
- Amélioration scraping Centris ZONE COURTIER (priorité 2 — EN COURS)

## 🔍 Découverte clé (2026-04-21 23:40)

**Render fait un health check sur `/` avec timeout court au démarrage.**
Mon bot faisait `server.listen(PORT)` à l'étape 9 de `main()`, APRÈS 5 awaits
(Dropbox refresh, loadStructure, initGist, loadMemory, loadSessionLive).

Si l'un de ces awaits prend >30s → Render tue le process avant que le server
soit up → deploy marqué "failed" sans log.

C'est pourquoi CRASH_REPORT.md n'était jamais écrit: Render killait le process
avant que mon handler uncaughtException ait une chance de s'exécuter.

**Solutions appliquées:**
- cd92e0f: server.listen() en Step 0 (health check rapide)
- e012f23: `server.on('error')` avec retry EADDRINUSE + polling non-throwable

## 🎯 BUG MYSTÉRIEUX RENDER

**Les faits:**
- Build réussit (18-20s)
- Deploy démarre, 10s plus tard → crash "nonZeroExit: 1"
- Aucun log visible dans l'UI (rien dans Render events detail)
- CRASH_REPORT.md pas écrit → crash AVANT que le handler GitHub marche
- Localement avec TOUS les env vars → tout fonctionne (tools:39, leads traités)

**Hypothèses restantes:**
1. Conflict port avec ancienne instance Render (EADDRINUSE) — fix e012f23
2. Conflict polling Telegram (409/404) — fix e012f23 avec handler dummy
3. Render SIGTERM inattendu pendant startup
4. Limite mémoire 512MB du plan starter dépassée (pas probable)

**Historique tentatives:**
- cd92e0f: server.listen en Step 0 → ÉCHEC
- e012f23: server.on('error') + polling non-throw → ÉCHEC  
- 2641720: délai 10s avant startPolling → ÉCHEC
- 5271a98: PIVOT MAJEUR → webhook Telegram au lieu de polling → EN ATTENTE

**5271a98 — Webhook mode:**
- POST /webhook/telegram reçoit les updates
- bot.setWebHook() configuré 5s après boot
- Pas de polling = pas de conflit multi-instance
- C'est la méthode officielle Telegram pour production

**Si 2641720 échoue aussi:**
1. **Switch webhook Telegram** au lieu de polling (plus fiable en prod)
   - `bot.setWebHook('https://signaturesb-bot-s272.onrender.com/webhook/telegram')`
   - Ajouter handler POST /webhook/telegram
   - Retirer `bot.startPolling()`
2. **Downgrade node-telegram-bot-api** à version plus stable (0.61.0 peut-être)
3. **Splitter en 2 services Render** (un polling, un HTTP/API)

## 📋 Tout le travail mémorisé

Commits de cette session:
- bfdd042: mémoriser bug mystérieux Render
- 2641720: délai 10s avant polling
- e012f23: server error handler + polling non-throw
- cd92e0f: server.listen Step 0
- b084701: système auto-diagnostic GitHub
- bd1ab88: logging verbose chaque étape
- 2f164df: fix polling crash process.exit
- c524195: metrics + circuits + /health + webhook GitHub
- 776e3f3: sync bidirectionnelle Mac ↔ bot
- a8348e5: mémoire 3-niveaux (SESSION_LIVE.md)
- ec30aac: validation messages + rate limit + erreurs propres
- 46751a0: J+1/J+3/J+7 sur glace
- cf2b8bd: webhooks intelligents + mobile + historique_contact
- 6dae7eb: Pipedrive complet (voir_prospect_complet, stagnants)
- 3ff000c: AGENT_CONFIG SaaS + Dropbox profond
- 22de937: 12 bugs critiques (processed Map, races, photo timeout)
- ca8de20: Opus 4.7 vision + thinking + 16k tokens
- 4bf2fa3: Opus 4.7 + Dropbox fix + mailing-masse

Reprise session garantie: lire ce fichier + CLAUDE.md + ÉTAT_SYSTÈME.md.
Mémoire Claude Code dans /Users/signaturesb/.claude/projects/.../memory/

## 🔑 Accès Centris courtier (Shawn confirme)

Shawn a deux façons d'accéder aux données pro:
1. **Prospect Mobile** (iPhone app) — agent version, full data comparables + actifs
2. **Centris.ca Zone Courtier** (web) — même login agent, accès desktop

Credentials partagés pour les deux:
- User: `110509`
- Pass: `REDACTED_PASSWORD`

Pour le bot, **Centris.ca Zone Courtier** est la cible (scrapable).
Prospect Mobile = app iOS privée, pas accessible programmatiquement facilement.

**URLs à tester pour login courtier:**
- `https://www.centris.ca/fr/connexion` (puis redirect vers zone courtier)
- `https://www.centris.ca/zone/courtier`
- `https://matrix.centris.ca/`
- `https://mem.centris.ca/`

**Plan:** une fois Render déployé (attendre 2f164df live), tester via Telegram:
`/centris` → voir le message d'erreur exact → ajuster URLs/login flow.

## 🔐 Tout est mémorisé

Fichiers persistants garantis:
- Git: tous les commits (sur les 2 remotes: kira-bot + bot-assistant)
- SESSION_LIVE.md (ce fichier, dans le repo)
- CLAUDE.md (dans le repo)
- ÉTAT_SYSTÈME.md (dans le repo)
- Mémoires Claude Code: `project_session_live.md`, etc.
- BOT_STATUS.md (bot l'écrit chaque heure — quand il tournera)

**Pour reprendre après crash:** ouvrir un nouveau Claude Code, lire ce fichier, continuer.
