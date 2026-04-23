# ✅ Boot réussi
_2026-04-22 20 h 00 min 09 s_

- Modèle: claude-sonnet-4-6
- Outils: 39
- Uptime: 17s
- Centris: ⏳
- Dropbox: ✅

## Logs boot (150 dernières lignes)
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
```
