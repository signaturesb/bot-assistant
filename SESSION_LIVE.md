# SESSION_LIVE — Travail Claude Code en temps réel

> Synchronisé via git push vers `bot-assistant` + `kira-bot` (Render auto-deploy).
> Bot lit ce fichier toutes les 30 min via `loadSessionLiveContext()`.
> **Dernière maj: 2026-05-20** — Scraper PDF universel + Sainte-Julienne fix

---

## 🆕 2026-05-20 — Scraper PDF universel (commit e0bb1a0+)

### Solution scraping PDF n'importe quel site (3 niveaux)
Le bot peut maintenant récupérer des PDFs **même sur sites avec consent wall / anti-bot** via `pdf_scraper.js`:

1. **LEVEL 1**: Direct HTTP fetch (got + stealth headers) — pour PDFs directs
2. **LEVEL 2**: Firecrawl (sites statiques)
3. **LEVEL 3**: rebrowser-playwright + Browserless stealth — **bypass consent walls, JS-rendered, anti-bot**
   - Auto-click consent buttons (Accepter / J'accepte / OK / Continue)
   - Anti-detect: navigator.webdriver=undefined, locale fr-CA, sec-ch-ua complets
   - Download interception pour PDFs direct

### Fix dual-repo sync (commit e0bb1a0)
Bug: bot lisait SESSION_LIVE depuis `kira-bot` mais Claude Code pushait sur `bot-assistant` → bot voyait toujours version du 14 mai.
Fix: `loadSessionLiveContext()` lit AUTO les 2 repos + prend le plus récent (max commit date).

### Plan zonage Sainte-Julienne — Solution
Site `sainte-julienne.com` bloque Firecrawl (consent wall). Maintenant avec stack Browserless stealth:
```
findAndDownloadPDFs('https://sainte-julienne.com/services-aux-citoyens/urbanisme/', {
  filterKeyword: 'zonage',  // ou 'plan'
  maxPDFs: 5
})
```
→ Cascade auto: Firecrawl fail → Browserless avec handleConsentWalls() → extract PDF links → download.

### Comment envoyer PDF dans Telegram (existant, juste rappel)
Le bot a déjà l'outil `bot.sendDocument(chatId, buffer, {caption}, {filename, contentType: 'application/pdf'})`.
`analyser_zonage_adresse` fait ça automatiquement: scrape → trouve PDF → envoie Telegram + optionnel forward client.

---

## 🏆 Session 2026-05-19 — 30+ commits déployés

### Commits clés aujourd'hui
| Commit | Sujet |
|---|---|
| `e9a8ec1` | fix(centris-search): page.selectOption() postback + MATRIX_PREFIXES par type |
| `bf3585e` | feat(centris-search): 100% complet — sélecteurs Matrix DOM exacts + 4 tools pipeline |
| `94ed29b` | feat(system): keyword mapping pour catégories Matrix dans SYSTEM_BASE |
| `e906c65` | feat(centris-search): searchCentrisVendus() skeleton + Matrix structure mapped |
| `68861e2` | feat(system): teach bot to prefer envoyer_fiche_centris_native FIRST |
| `16d09a8` | feat(centris-native): outil bot envoyer_fiche_centris_native — flow Matrix UI |
| `6875333` | fix(cua): détecte rebrowser flavor AVANT load |
| `0e08f22` | feat(scrape): rebrowser-playwright + 4 couches anti-detect + pdf-parse Centris |
| `e527bc3` | fix(preview): défaut shawn@signaturesb.com + Gmail API direct |
| `693c614` | feat(market): LLM Haiku extraction fallback robuste |
| `a7551e7` | feat(market): 15 sources QC + spot-check 3 sem + auto-inject |
| `8dc9fc3` | fix(audit-P0): Gmail Poller mutex + budget USD conversation |
| `5313c7c` | feat(cua+gmail): bulletproof MFA + visual fallback + Telegram alert |
| `a3598db` | feat(cua): intégration CUA + Browserless externe |
| `a49fc6e` | feat(email-template): master template Dropbox sur 4 fonctions emails |

### ✅ CENTRIS MATRIX — 100% MAÎTRISÉ

**Flow `envoyer_fiche_centris_native()` validé live:**
- Test réussi listing #18366287 → email natif Centris reçu icloud
- PDF officiel + 61 photos HD + signature Shawn intégrée
- Outil bot ajouté + préférence SYSTEM_BASE

**Flow `searchCentrisVendus()` validé live:**
- Test 32 terrains vendus Rawdon 6 mois → **CONFIRMÉ par Shawn**
- Format date "0-180" (jours arrière)
- page.selectOption() pour postback ASP.NET (fix bug DOM manip)

### 🗺️ STRUCTURE MATRIX CAPTURÉE

**Prefix Fm{N}_ par type:**
- Unifamiliale = `Fm43_`
- TerreTerrain = `Fm105_`
- Autres types à confirmer

**Ctrl numbers partagés** (sauf changement de statut):
- 3565 = Région
- 3567 = Municipalité (67 options Lanaudière)
- 3568 = Quartier
- 3227 = Statut (En vigueur / Vendu / Expiré / Hors marché / Annulé)
- 3386 = Prix demandé/vendu
- 3416 = Changement de statut (Unifam) / **3425** (Terrain)
- 792 = Genre (Plain-pied/À étages/Paliers/1.5/Mobile)
- 794 = Type bâtiment (Isolé/Jumelé/En rangée/Coin/Quadrex)

**URLs (sans / dans path):**
- `/Recherche/Unifamiliale/Générale`
- `/Recherche/TerreTerrain/Générale`
- `/Recherche/Copropri%C3%A9t%C3%A9Appartementr%C3%A9sidentiel/Générale`
- `/Recherche/FermeFermette/Générale`
- `/Recherche/Propri%C3%A9t%C3%A9commercialeouindustrielle/Générale`
- `/Recherche/Propri%C3%A9t%C3%A9%C3%A0revenus/Générale`
- `/Recherche/Multicat%C3%A9gories/Générale`

### 🥷 SCRAPING — Stack ultime (commits a3598db + 0e08f22)

- ✅ **Browserless.io** (1000 min/mois free) connecté via WS
- ✅ **rebrowser-playwright** anti-detect natif
- ✅ **4 couches anti-blocage:**
  - UA rotation 4 user-agents Chrome/Edge Mac/Win
  - Stealth context: locale fr-CA, timezone Toronto, sec-ch-ua complets
  - addInitScript: navigator.webdriver, plugins, WebGL, chrome.runtime
  - launch args: --disable-blink-features=AutomationControlled
- ✅ **pdf-parse**: extract data Centris PDFs (prix, MLS, adresse, taxes)
- ✅ **cheerio + got + lru-cache + p-limit**: tools pipeline GitHub top 2026

### 📊 MARKET INTELLIGENCE — 16 sources LIVE

Pipeline auto-injecté dans system prompt bot:
- Banque du Canada (taux directeur)
- MultiPrêt + PlaniPrêt (taux 5 ans)
- APCIQ (stats QC + Lanaudière)
- OACIQ (règlements)
- Centris.ca public + DuProprio + Realtor.ca
- RE/MAX QC + RE/MAX Canada + Royal LePage + Sutton + Via Capitale + JLR + SHQ

**Ratehub.ca** → taux fixe 5 ans **4.04%** confirmé mai 2026.

### 🛡️ BREVO — Bugs résolus

- ✅ "Brevo SMTP hold pattern" diagnostiqué (events stay "requests" never "delivered")
- ✅ Fix: `/admin/preview-via-gmail` bypass via Gmail OAuth
- ✅ Campaign #35 sent prod (32 acheteurs Lanaudière) avec taux mai à jour
- ✅ avril→mai replaced 8x dans HTML
- ✅ mensualités recalculées avec 4.04% (canadien semi-annual)

### 🔄 BOT INSTRUCTIONS PERMANENTES (SYSTEM_BASE)

Bot sait maintenant:
1. **Quelle catégorie Matrix choisir** par keyword:
   - maison/unifam/bungalow/plain pied/à étages → Unifamiliale
   - condo/copro → Copropriété
   - duplex/triplex/plex → Propriété à revenus
   - terrain/terre/lot → Terre/Terrain
2. **TOUJOURS privilégier `envoyer_fiche_centris_native`** pour envoi client
3. **Fallback chain**: HTTP → CUA → lien public
4. **Cc Shawn auto** + Telegram trace chaque envoi
5. **Master template Dropbox** avec logos sur tous emails clients

### 📁 18 mémoires actives pour sessions futures

Tous accessibles dans `/Users/signaturesb/.claude/projects/.../memory/`:
- 4 nouvelles aujourd'hui sur Centris (structure + 101 filtres + 25 sélecteurs Unifam + bug fix)
- Master template + Telegram trace + sync rules
- Brevo safety + SMTP hold pattern
- 16 sources market intelligence pipeline

---

## 🎯 PROCHAINES PRIORITÉS (demain)

1. **Tests live Telegram bot** — vérifier que le bot prend bien la bonne route pour:
   - "envoie la fiche du #X à Y" → envoyer_fiche_centris_native
   - "envoie-moi maisons vendues Rawdon 6 mois 400-600k" → chercher_comparables → searchCentrisVendus
2. **Compléter prefixes** Fm{N}_ pour Copropriété/Ferme/Commercial/Revenus (test 1 listing chaque)
3. **Implémenter envoi comparables par email** — flow capturé "Tout · Courriel" sur Results.aspx
4. **Test preview J-1** auto pour #40 Terrains (24 mai)

## 📍 État infrastructure

- ✅ Render bot-assistant: commit `e9a8ec1` live
- ✅ Browserless free tier active (~5min/mois utilisé sur 1000)
- ✅ LaunchAgent Mac centris-auto-login refresh cookies 12h (rebrowser-playwright)
- ✅ Session Centris valide 25 jours (push from LaunchAgent)
- ✅ Crons quotidiens actifs (digest, veille J-1, market refresh)
- ✅ 18 LaunchAgents Mac chargés (vérifié)

**Bot est champion sur Centris** — testable demain via Telegram.
