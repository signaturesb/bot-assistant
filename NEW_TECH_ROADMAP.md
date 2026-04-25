# 🚀 Roadmap Tech — Veille proactive pour Kira

> Maintenu par Claude Code. Liste des outils/programmes que je suis pour pinger Shawn quand un nouveau sort ou qu'une intégration devient pertinente.

**Légende:**
- 🟢 **Implémenté** — actif en prod
- 🟡 **Prêt à activer** — code écrit ou config disponible, attend déclencheur
- 🔵 **Watching** — j'observe, je ping si nouveau ou pertinent
- ⚪ **Considéré, pas urgent**

---

## 🤖 IA / Modèles

### 🟢 Anthropic Claude (Sonnet 4.6 + Opus 4.7 + Haiku 4.5)
- Sonnet default + routing auto Opus sur mots-clés complexes
- Prompt caching activé (system + tools)
- Haiku pour healthcheck (cheap)
- **À watcher:** Claude 5.x, nouvelles features (tool use parallel, computer use)

### 🟡 OpenAI Whisper (transcription vocaux)
- Code prêt, env var `OPENAI_API_KEY` à ajouter dans Render
- Coût: ~0.006$/min audio (~120 min/$1)
- Activation: setup OPENAI_API_KEY → Whisper auto activé pour vocaux Telegram

### 🔵 Perplexity Sonar (recherche web temps réel)
- API: api.perplexity.ai
- Cas d'usage: tendances marché Lanaudière, taux hypothécaires actuels, nouvelles règles immobilier QC
- Coût: ~$0.0002/req (très bon marché)
- **À implémenter quand:** Shawn donne le go (ajout simple, ~30 min)

### ⚪ Vapi.ai (AI voice phone calls)
- Bot téléphonique IA qui répond aux appels prospects en absence Shawn
- ÉNORME différenciateur courtier
- Coût: ~$0.05-0.10/min appel
- **Décision:** plan Pro+ uniquement (volume justifié)

---

## 🏠 Données immobilières

### 🟡 Centris agent — comparables vendus
- Code 110509 (env `CENTRIS_USER`/`PASS`)
- Authentication intégrée, mais outil `chercher_comparables` pas encore créé
- **À implémenter:** scraper comparables vendus 12 derniers mois pour rapport email vendeur

### ⚪ Registre foncier (SIRF)
- Données officielles propriété, taxes, transactions
- Authentication par courtier (compte payant Québec)
- Mentionné dans plan Pro

### ⚪ APCIQ — données marché QC
- Statistiques marché immobilier officielles
- Public mais demande scraping

### ⚪ JLR.ca / Centris Matrix
- Comparables vendus + en vigueur
- Compte payant courtier

### ⚪ DuProprio API
- Listings FSBO (sans courtier)
- Public, pas d'API officielle, scraping requis

---

## 📞 Communication

### 🟡 Brevo (email + SMS) — déjà actif
- Email transactionnel + campagnes
- SMS fallback (uniquement catégories critiques)
- Sender SMS: "KiraBot"

### ⚪ Twilio (SMS bidirectionnel pro)
- Alternative à Brevo SMS
- Permettrait bot SMS bidirectionnel (prospect texte → bot répond)
- Coût: ~$0.0075/SMS sortant

### ⚪ WhatsApp Business API
- Communication via WhatsApp avec prospects
- Approuvée Meta requise (longue procédure)

---

## 📊 Productivité / CRM

### 🟢 Pipedrive — déjà actif
- Pipeline 7, custom fields configurés
- Auto-création deals + notes

### 🟢 Dropbox — déjà actif
- Index complet `/Inscription` + `/Terrain en ligne`
- Auto-refresh token 3h

### 🟢 Gmail OAuth — déjà actif
- Scope readonly + send + modify
- Token preemptive refresh

### ⚪ Notion API
- Base de connaissances clients/propriétés
- Pas urgent (Pipedrive couvre + Dropbox)

### ⚪ Linear (gestion projet)
- Pour suivre tâches dev du bot
- Pas urgent (Telegram + GitHub Issues suffisent)

---

## 🛡️ Monitoring / Sécurité

### 🟢 Render hosting — actif
- Plan Starter ~7$/mois
- Auto-deploy sur push GitHub
- ENV vars chiffrées at rest

### 🟢 Bot self-monitoring
- /diagnose, /admin/audit, /admin/diagnose
- Anomaly detection (cron 30min)
- Memory monitoring
- Email outbox audit (cron 1h)

### 🟡 Sentry — error tracking pro
- @sentry/node, free 5k errors/mois
- À installer prochainement (gain ÉNORME pour debug)

### ⚪ UptimeRobot
- Ping externe /health
- Free 50 monitors
- Setup: signup → add monitor

### ⚪ Datadog / Grafana Cloud
- Observability avancée
- Pas urgent (notre /diagnose suffit pour solo courtier)

### ⚪ Cloudflare WAF + CDN
- Protection DDoS niveau pro
- Pas urgent (rate limiting interne suffit)

---

## 🌐 Web / Scraping

### 🟢 Firecrawl — actif
- 8 municipalités Lanaudière pré-configurées
- Cache 30j, quota 500/mois
- Circuit breaker activé

### 🔵 Browserless / Playwright Cloud
- Pour scraping JS-heavy sites
- Alternative si Firecrawl rate-limited
- Coût: ~$5-30/mois selon volume

---

## 🔄 Workflows / Automation

### 🟢 Make.com (Integromat) — partiellement
- Webhooks Centris configurés
- À étendre: SMS, email reply, calendar

### ⚪ Zapier / n8n
- Alternative à Make
- n8n auto-hébergé = $0 (plus de contrôle)

---

## 📅 Calendrier / Visites

### ⚪ Google Calendar API
- Sync visites Pipedrive ↔ Google Cal
- iCal export possible aussi
- **À implémenter:** outil `creer_visite_calendrier` qui sync

### ⚪ Apple Calendar (iCloud) sync
- Sync 2-way avec Mac/iPhone Shawn
- Plus complexe (CalDAV)

---

## 💳 Paiements (Shawn gère)

⚠️ Hors scope Claude (décision Shawn). Pour info:

### ⚪ Stripe
- Standard de facto SaaS
- 2.9% + 0.30$/transaction

### ⚪ Lemon Squeezy
- Plus simple (handles taxes mondiales)
- 5% + 0.50$/transaction

### ⚪ Paddle
- Similaire à Lemon Squeezy

---

## 🔥 Pour commencer (mes 3 prochaines suggestions)

Si Shawn donne carte blanche:

1. **Sentry** (free) — détection bugs prod avant qu'il s'en aperçoive (~30 min setup)
2. **Perplexity tool** — `recherche_web` pour stats marché temps réel (~30 min setup)
3. **OpenAI Whisper** — vocaux Telegram (juste ajouter env var, code prêt)

---

## 📝 Procédure mise à jour

Chaque session, Claude:
1. Check ce fichier
2. Ajoute outils sortis recently (en 🔵 watching)
3. Ping Shawn si quelque chose justifie un upgrade
4. Marque les implémentés en 🟢

Dernière maj: 2026-04-25
