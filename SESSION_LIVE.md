# SESSION LIVE — Reprise exacte après crash

> **Mis à jour après chaque commit.** Si conversation Claude Code crash → lire ce fichier pour reprendre exactement.
> Dernière mise à jour: **2026-04-21** | Commit actuel: **ec30aac**

---

## 🎯 SUR QUOI ON TRAVAILLE MAINTENANT

**Objectif en cours:** Système anti-erreurs 100% fiable + mémoire persistante session  
**Dernière action:** Fix erreurs 400/429 avec validation messages + rate limiter + reprise mémoire  
**Statut déploiement:** Commit ec30aac poussé aux deux repos (kira-bot + bot-assistant) — Render build en cours

## 📋 CONTEXTE IMMÉDIAT

Shawn a reçu des erreurs dans Telegram:
- `400: "This model does not support assistant message pre..."` (prefilling)
- `429: rate_limit_error` × 4 (retries en cascade)

**Cause identifiée:** historique corrompu avec `assistant` en dernier message → Opus 4.7 refuse le prefilling → retry 400 en boucle → 429.

**Fix appliqué (commit ec30aac):**
1. `validateMessagesForAPI()` — garantit premier=user, dernier=user, pas de rôles consécutifs
2. `checkRateLimit()` — max 15 req/min, bloque avant API
3. `formatAPIError()` — messages lisibles au lieu de JSON brut
4. 400 = pas de retry + reset auto historique
5. 429 = backoff 8s × tentative

## ⚙️ ÉTAT TECHNIQUE

| Composant | État |
|---|---|
| Bot Render | signaturesb-bot-s272.onrender.com |
| Service | srv-d7fh9777f7vs73a15ddg |
| Dernier commit | ec30aac (2026-04-21) |
| Outils actifs | 46 |
| Modèle | claude-opus-4-7 |
| Lignes bot.js | ~3700 |

**Env vars Render (27):**
TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN, PIPEDRIVE_API_KEY, BREVO_API_KEY, GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN, DROPBOX_*, CENTRIS_USER=110509, CENTRIS_PASS=REDACTED_PASSWORD, SIRF_USER=57K0426, WEBHOOK_SECRET, GIST_ID, etc.

**Manquant:** OPENAI_API_KEY (Whisper — optionnel)

## 🔗 LIEN CLAUDE CODE ↔ BOT

**Pour reprendre le contexte à chaque nouvelle session:**
1. Lire ce fichier (`SESSION_LIVE.md`) — contexte immédiat
2. Lire `CLAUDE.md` — architecture complète
3. Lire `ÉTAT_SYSTÈME.md` — état par feature
4. Si bot runtime nécessaire: `read_github_file(repo='kira-bot', path='BOT_STATUS.md')`

**Git remote:** push dual automatique (origin → kira-bot + bot-assistant) pour que Render déploie.

## 📝 PROCHAINES ÉTAPES IDENTIFIÉES

1. ✅ Attendre déploiement Render ec30aac (5-10min)
2. Shawn teste avec une photo → devrait fonctionner sans erreur 400/429
3. Si erreur persiste: lire logs Render + ajuster `validateMessagesForAPI`
4. Features à implémenter (priorité basse): Registre SIRF, DuProprio, J+1/3/7 réactivation

## 🗂️ COMMITS RÉCENTS (session actuelle)

- `ec30aac` — fix: système anti-erreurs validation + rate limit + messages propres
- `c209c9e` — fix: sync GitHub → kira-bot + rapport complet Claude Code ↔ bot
- `421b66b` — fix: pre-login Centris + /centris + /status amélioré + ANTHROPIC Render
- `34cb896` — feat: Centris agent authentifié — comparables + en vigueur
- `3b10a9e` — feat: Gmail Lead Poller — surveillance auto leads Centris/RE-MAX

## ⚠️ DÉCISIONS RÉCENTES IMPORTANTES

- **J+1/J+3/J+7:** sur glace (décision Shawn 2026-04-19) — cron commenté ~ligne 3105
- **Source comparables:** Centris agent authentifié (110509) — pas Pipedrive, pas scraping public
- **Application prospect mobile = Centris** (pas Pipedrive) — pour comparables vendus
- **Deux repos GitHub:** kira-bot (dev) + bot-assistant (Render). Push dual configuré.

## 🔐 CREDENTIALS CRITIQUES (dans Render)

- Centris agent: `110509` / `REDACTED_PASSWORD`
- SIRF Registre foncier: `57K0426` / `REDACTED_PASSWORD`
- Render API: `REDACTED_RENDER_API_KEY`
