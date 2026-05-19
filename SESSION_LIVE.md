# SESSION_LIVE — Travail Claude Code en temps réel

> Synchronisé via git push vers `kira-bot` repo. Bot Telegram lit ce fichier toutes les 30 min via `loadSessionLiveContext()` (bot.js).
> Dernière maj: **2026-05-19 22:45 UTC** — Session bulletproof + market intelligence + CUA

---

## 🎯 Session 2026-05-19 — État actuel (HEAD: `693c614`)

### ✅ DÉPLOYÉS aujourd'hui (Render bot-assistant main):

| Commit | Sujet |
|---|---|
| `693c614` | Market intelligence — LLM Haiku extraction fallback robuste |
| `4e7dac1` | URL Banque Canada + filter OACIQ URLs |
| `d5a51fc` | Extracts intelligents APCIQ/OACIQ/Centris/RE-MAX + digest enrichi |
| `9a1e941` | Audit P1+P2+P3: auth helper / pendingDocs cap / Dropbox expiry / Browserless retry |
| `215f0c9` | Brevo sender fix + self-send detection (Gmail trap shawn@→shawn@) |
| `4ba0c80` | `/admin/brevo-send-raw` — bypass sendTest via SMTP |
| `a7551e7` | 15 sources QC + spot-check 3 sem + auto-inject system prompt |
| `a5e6992` | Pipeline scraping market_intelligence.js |
| `8dc9fc3` | **Audit P0**: Gmail Poller mutex + budget USD conversation + trackCost return |
| `27e0c22` | `/admin/brevo-replace` (find/replace subject+HTML campagne) |
| `5313c7c` | CUA MFA visual fallback + Telegram alert + Gmail query élargi |
| `f7a480b` | CUA login Centris autonome (UserCode + MFA Gmail) |
| `e3c4a66` | CUA URLs Centris 2026 (matrix.centris.ca) + cookie share |
| `a3598db` | CUA driver + Browserless externe |
| `a49fc6e` | Master template Dropbox sur 4 fonctions emails clients |
| `524581a` | Telegram trace OBLIGATOIRE chaque email envoyé client |

### 🆕 INFRASTRUCTURE ACTIVÉE
- **Browserless.io** signed up (1000 min/mois free) → env var `BROWSERLESS_WS` sur Render
- **CUA mode**: `browserless (remote)` confirmé via `/admin/state`
- **Market intelligence pipeline**: 16 sources QC scrapées via Firecrawl

### 🐛 BUGS CRITIQUES RÉSOLUS
1. **Preview #35 jamais reçu** × 4 tentatives → cause: sender=shawn@ → destinataire=shawn@ trap Gmail. Fix: `/admin/brevo-send-raw` auto-redirect vers icloud si self-send
2. **Campagne #35 contenait "avril"** × 8 occurrences → fix: `/admin/brevo-replace?id=35&from=avril&to=mai`
3. **`.env` ligne 14 corrompue** (GITHUB_WEBHOOK_SECRET + WEBHOOK_SECRET fusionnés sur 1 ligne)
4. **Gmail Poller overlap garanti à 30s** → mutex `_pollerInFlight`
5. **Tool loop Claude budget non-borné** ($3/conversation possible) → cap CONV_BUDGET_USD=$2.50
6. **Dropbox token sans expiry tracking** → pre-emptive refresh
7. **CUA Centris login** → form selectors mis à jour + MFA via Gmail + alert Telegram fallback

### 📊 MARKET INTELLIGENCE — 16 sources actives
**Économiques (refresh quotidien):** banque_canada, multipret, planipret
**Stats QC:** apciq, apciq_lanaudiere, oaciq
**Sites immo:** centris_public, duproprio, realtor, remax_qc, remax_marche, royal_lepage, sutton_qc, via_capitale, jlr, shq

**Cadence:** Full refresh dimanche matin OU snapshot > 21 jours. Fresh refresh quotidien sources économiques.

**Auto-injection:** `buildMarketDigest()` injecté dans `getSystemDynamic()` à chaque tour bot → bot voit taux + prix médians + variations + news sans demander.

### ⚠️ ENCORE À FINIR
- **Taux directeur BC** + **taux hypothèque** restent null malgré LLM fallback Haiku → URL bankofcanada peut-être JS-rendered, à investiguer
- **OACIQ articles** retournent "Cette page n'est plus accessible" → URL `/fr/articles` invalide, trouver bonne URL
- **Tests live Telegram** pour valider CUA Centris end-to-end (MFA Gmail polling)

### 📋 ENDPOINTS ADMIN (auth WEBHOOK_SECRET via `requireAdmin` timing-safe)
- `/admin/state` — uptime + health + costs + CUA + market status (no auth)
- `/admin/cua-test?num=N` — test CUA Centris listing
- `/admin/brevo-list` / `/admin/brevo-replace` / `/admin/brevo-send-raw` / `/admin/brevo-send-preview`
- `/admin/market-refresh` / `/admin/market-status` / `/admin/market-debug?source=X`
- `/admin/centris-mfa-code` (Gmail OAuth fetch code)
- `/admin/centris-cookies` (POST cookies from Mac/CUA)
- `/admin/pipedrive-cleanup` (5 catégories purge)

---

## 🧩 ARCHITECTURE EN PLACE (compte courtier SaaS-ready)

- **15 env vars** Render configurées + `BROWSERLESS_WS` nouvelle
- **Master template Dropbox** sur TOUS emails clients (4 fonctions refactor)
- **Telegram trace** sur CHAQUE envoi (Shawn voit tout)
- **Brevo safety net 4 couches** + Cc Shawn auto + filtre terrain-a-construire
- **CUA Computer Use Agent** Anthropic via Browserless (1000 min/mois)
- **Market intelligence 16 sources** auto-injecté dans system prompt bot
- **Audit P0-P3** 7 fixes systémiques (mutex, budget, expiry, retry)

---

## 🎬 PROCHAINES PRIORITÉS

1. Vérifier que Shawn a reçu preview #35 à icloud (sender fix appliqué)
2. Finir extraction taux directeur BC + taux hypothèque (LLM ou nouvelle URL)
3. Tester live commande Telegram "envoie fiche #22264330" (CUA end-to-end)
4. Documenter dans CLAUDE.md la nouvelle archi
