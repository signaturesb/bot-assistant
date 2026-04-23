# 🚨 unhandledRejection
_2026-04-22 21 h 01 min 26 s_

## Erreur
```
Cannot create property '0' on number '1'
TypeError: Cannot create property '0' on number '1'
    at mTick (/opt/render/project/src/bot.js:159:44)
    at handleEmailConfirmation (/opt/render/project/src/bot.js:3504:3)
    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)
    at async TelegramBot.<anonymous> (/opt/render/project/src/bot.js:3862:9)
```

## Logs du boot (capture complète)
```
INFO|BOOT|Step 0: server.listen(10000) [CRITICAL]
INFO|BOOT|Step 1: refresh Dropbox token
OK|BOOT|HTTP server listening on port 10000
OK|DROPBOX|Token rafraîchi ✓
INFO|BOOT|Step 2: load Dropbox structure
OK|DROPBOX|Structure: 34 terrains, 4 sections chargées
INFO|BOOT|Step 3: init Gist
OK|GIST|Configuré: a9a1a92fef67d6d3d7bddeaed5359f44
INFO|BOOT|Step 4: load memory
OK|GIST|1 faits chargés
INFO|BOOT|Step 5: load session live context
OK|SYNC|SESSION_LIVE.md chargé (11KB)
OK|BOOT|Gmail Lead Poller + auto-trash CI noise activés
INFO|BOOT|Step 6: registerHandlers
INFO|BOOT|Step 7: startDailyTasks
OK|CRON|Tâches: visites 7h, digest 8h→Julie, sync BOT_STATUS chaque heure, monitoring 10min
INFO|BOOT|Step 8: configuration WEBHOOK Telegram (au lieu de polling — production-grade)
OK|BOOT|✅ Kira démarrée [claude-sonnet-4-6] — /tmp — mémos:1 — tools:39 — port:10000
WARN|CENTRIS|Login: HTTP 200 — location: 
WARN|CENTRIS|Pré-login échoué — retry automatique à la première requête
OK|PREFLIGHT|✅ Claude API accepte les 39 tools
OK|BOOT|Webhook Telegram configuré: https://signaturesb-bot-s272.onrender.com/webhook/telegram
INFO|BOOT|State vide — baseline silencieux 7j au boot (zéro notif rétro)
OK|GMAIL|Token rafraîchi ✓
OK|BOOT|Baseline silencieux: 15 leads marqués, 8 dédup entries
INFO|POLLER|Junk: [Anglehart, Jacques] Maison Lanaudiere 225k- (Shawn Barrette <centris@mlsmatrix.com>)
INFO|POLLER|Regex 1 infos — AI fallback pour "Centris.ca - Demande d’information pour le Chemin "
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
OK|POLLER|Lead Centris.ca:  | Centris: 12582379
WARN|POLLER|Telegram notify: ETELEGRAM: 400 Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 288
INFO|POLLER|Junk: [Charrette, Stéphane] Maison 430 et moins (Shawn Barrette <centris@mlsmatrix.com>)
INFO|POLLER|Regex 1 infos — AI fallback pour "Centris.ca - Demande d’information pour le 5e Rang"
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
OK|POLLER|Lead Centris.ca:  | Centris: 26063767
OK|BOOT|BOOT_REPORT.md écrit dans GitHub
INFO|POLLER|Junk: Shawn, vous avez 2 nouvelles notifications (Notifications Centris <no-reply@centris.)
INFO|POLLER|Junk: Shawn, vous avez 1 nouvelle notification (Notifications Centris <no-reply@centris.)
INFO|POLLER|Junk: Shawn, vous avez 1 nouvelle notification (Notifications Centris <no-reply@centris.)
INFO|POLLER|Regex 1 infos — AI fallback pour "Centris.ca - Demande d’information pour le 5e Rang"
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
INFO|DEDUP|Lead match: c:26063767 (vu 0min ago)
INFO|POLLER|Dédup 7j: lead 26063767 déjà notifié — skip
INFO|POLLER|Regex 1 infos — AI fallback pour "Centris.ca - Demande d’information pour le Chemin "
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
OK|POLLER|Lead Centris.ca:  | Centris: 9092441
WARN|POLLER|Telegram notify: ETELEGRAM: 400 Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 272
INFO|POLLER|Regex 1 infos — AI fallback pour "Centris.ca - Demande d’information pour le Chemin "
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
INFO|DEDUP|Lead match: c:12582379 (vu 0min ago)
INFO|POLLER|Dédup 7j: lead 12582379 déjà notifié — skip
INFO|POLLER|Junk: Shawn, vous avez 1 nouvelle notification (Notifications Centris <no-reply@centris.)
INFO|POLLER|Junk: Shawn, vous avez 1 nouvelle notification (Notifications Centris <no-reply@centris.)
OK|HEALTH|Anthropic OK (healthcheck Haiku)
INFO|POLLER|Junk: Shawn, vous avez 1 nouvelle notification (Notifications Centris <no-reply@centris.)
INFO|POLLER|Junk: Shawn, vous avez 1 nouvelle notification (Notifications Centris <no-reply@centris.)
INFO|POLLER|Junk: Shawn, vous avez 1 nouvelle notification (Notifications Centris <no-reply@centris.)
INFO|POLLER|Junk: Shawn, vous avez 1 nouvelle notification (Notifications Centris <no-reply@centris.)
OK|POLLER|Lead RE/MAX Québec: Mme Cordeiro | Centris: ?
OK|SYNC|BOT_STATUS.md → kira-bot (stats anonymes, 100 deals)
INFO|DEDUP|Lead match: e:thabatha.cordeiro@remax-quebec.com (vu 0min ago)
INFO|POLLER|Dédup 7j: lead thabatha.cordeiro@remax-quebec.com déjà notifié — skip
INFO|POLLER|Regex 0 infos — AI fallback pour "Two Weeks Until Commercial Symposium!"
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=false
WARN|POLLER|Lead non viable: "Two Weeks Until Commercial Symposium!" (RE/MAX Québec) — PROBLÈME P0
INFO|POLLER|Regex 1 infos — AI fallback pour "Vos propriétés vendues"
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=false
WARN|POLLER|Lead non viable: "Vos propriétés vendues" (RE/MAX Québec) — PROBLÈME P0
INFO|POLLER|Regex 1 infos — AI fallback pour "L'actuali-T RE/MAX : Entrevue avec nos recrues de "
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=false
WARN|POLLER|Lead non viable: "L'actuali-T RE/MAX : Entrevue avec nos recrues de " (RE/MAX Québec) — PROBLÈME P0
OK|POLLER|Lead Realtor.ca: lead@realtor.ca | Centris: 13711030
INFO|POLLER|Regex 1 infos — AI fallback pour "L’inscription pour l’adresse Rue Sarine, #171, Raw"
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=false
WARN|POLLER|Lead non viable: "L’inscription pour l’adresse Rue Sarine, #171, Raw" (Realtor.ca) — PROBLÈME P0
INFO|POLLER|Regex 1 infos — AI fallback pour "Demande de visite - Carlo Calabrese, RE/MAX HARMON"
OK|AI_PARSER|Extracted: nom=false tel=false email=true centris=false
WARN|POLLER|Lead non viable: "Demande de visite - Carlo Calabrese, RE/MAX HARMON" (Demande directe) — PROBLÈME P0
INFO|DEDUP|Lead match: c:26063767 (vu 1min ago)
INFO|POLLER|Dédup 7j: lead Shawn Barrette déjà notifié — skip
INFO|DEDUP|Lead match: c:26063767 (vu 1min ago)
INFO|POLLER|Dédup 7j: lead Shawn Barrette déjà notifié — skip
INFO|POLLER|Regex 1 infos — AI fallback pour "Demande de visite - Philois Raphaël, VENDIRECT INC"
OK|AI_PARSER|Extracted: nom=false tel=false email=true centris=false
WARN|POLLER|Lead non viable: "Demande de visite - Philois Raphaël, VENDIRECT INC" (Demande directe) — PROBLÈME P0
INFO|POLLER|Regex 1 infos — AI fallback pour "Centris.ca - Demande d’information pour le 5e Rang"
IN|MSG|Comment je fais pour arrêter toutes ces envois de nouveaux lead, c’est des vieux
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
OK|POLLER|Lead Centris.ca:  | Centris: 24022451
WARN|POLLER|Telegram notify: ETELEGRAM: 400 Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 266
INFO|TOOL|refresh_contexte_session({})
OK|SYNC|SESSION_LIVE.md chargé (11KB)
INFO|POLLER|Regex 1 infos — AI fallback pour "Centris.ca - Demande d’information pour le Chemin "
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
OK|POLLER|Lead Centris.ca:  | Centris: 25244988
WARN|POLLER|Telegram notify: ETELEGRAM: 400 Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 298
INFO|POLLER|Regex 2 infos — AI fallback pour "Centris.ca - Demande d’information pour le 2580, R"
INFO|TOOL|list_github_files({"repo":"kira-bot","path":""})
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
OK|POLLER|Lead Centris.ca:  | Centris: 25799068
INFO|TOOL|read_github_file({"repo":"kira-bot","path":"bot.js"})
INFO|TOOL|read_bot_file({"filename":"gmail_poller.json"})
INFO|POLLER|Regex 2 infos — AI fallback pour "Centris.ca - Demande d’information pour le 150, Ru"
WARN|AI_PARSER|Pas de JSON: Je ne vois pas le corps de l'email avec les informations du client. L'email fourni ne contient que l
OK|POLLER|Lead Centris.ca:  | Centris: 25525842
OK|POLLER|Lead Demande directe: julielem.adjointe@gmail.com | Centris: 15644863
INFO|DEDUP|Lead match: t:5149544695 (vu 0min ago)
INFO|POLLER|Dédup 7j: lead riverin.william@rcgt.com déjà notifié — skip
INFO|POLLER|Regex 1 infos — AI fallback pour "Centris.ca - Demande d’information pour le Rue Chi"
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
OK|POLLER|Lead Centris.ca:  | Centris: 20021531
INFO|POLLER|Regex 2 infos — AI fallback pour "Centris.ca - Demande de visite pour le 1962, Rue N"
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
OK|POLLER|Lead Centris.ca:  | Centris: 23457532
IN|MSG|Arrête tout maintenant, Lead sont même pas bons
INFO|TOOL|read_github_file({"repo":"kira-bot","path":"bot.js"})
INFO|POLLER|Regex 2 infos — AI fallback pour "Centris.ca - Demande d’information pour le 503 - 5"
OK|AI_PARSER|Extracted: nom=false tel=false email=false centris=true
OK|POLLER|Lead Centris.ca:  | Centris: 26648193
INFO|TOOL|read_github_file({"repo":"kira-bot","path":"bot.js"})
INFO|TOOL|read_github_file({"repo":"kira-bot","path":"bot.js"})
OK|POLLER|Scan: 61 found | 11 junk | 19 deals | 19 nouveaux
```

## Environnement
- Node: v22.22.0
- Platform: linux
- Memory: {"rss":114106368,"heapTotal":29118464,"heapUsed":24101480,"external":4878361,"arrayBuffers":1177032}
- Env vars présents: 138

**Claude Code peut lire ce fichier avec:**
`read_github_file(repo='kira-bot', path='CRASH_REPORT.md')`