# 🚀 Onboarding Kira Bot — Setup pour un nouveau courtier

> Ce guide est destiné à un courtier immobilier qui souhaite déployer Kira Bot pour son propre usage. Setup complet en **30-45 minutes**, ensuite c'est automatique.

---

## 🎯 Ce que fait Kira

Un assistant Telegram qui:
- 📩 **Capture toutes les demandes Centris/RE-MAX/Realtor** automatiquement
- 📦 **Envoie les documents du terrain** au prospect en 30 secondes (cache photos, fiche, certificats)
- 🏢 **Crée les deals Pipedrive** + brouillons de réponse J+0
- 📞 **Te notifie** sur Telegram en temps réel
- 🛡️ **Self-healing** — retry automatique 3 niveaux, 4 canaux de fallback (Telegram/email/SMS)
- 🌐 **Scrape sites municipaux** (zonage, marges, permis) en temps réel

---

## 📋 Pré-requis

### Comptes requis
- ✅ **Render** (hosting) — Starter plan ~7$/mois — [render.com](https://render.com)
- ✅ **Anthropic** (Claude) — API key avec budget — [console.anthropic.com](https://console.anthropic.com)
- ✅ **Telegram** — un compte personnel pour recevoir les notifs
- ✅ **Pipedrive** — un CRM existant (free trial OK pour test)
- ✅ **Gmail** (Google Workspace ou personnel) — pour envoyer les courriels en ton nom
- ✅ **Dropbox** — pour les dossiers de propriétés/terrains
- ✅ **GitHub** (optionnel mais recommandé) — pour persistance backup

### Comptes optionnels (features avancées)
- 🟡 **Brevo** — fallback email + SMS si Telegram tombe
- 🟡 **Firecrawl** — scraping sites municipaux (500 scrapes/mois gratuit)
- 🟡 **Centris agent** — comparables vendus (compte courtier requis)
- 🟡 **OpenAI** — transcription messages vocaux Telegram (Whisper)

---

## 🛠 Setup étape par étape

### Étape 1 — Telegram bot (5 min)

1. Sur Telegram, parle à **@BotFather**
2. `/newbot` → choisis un nom (ex: "Kira Lanaudière") + username unique (ex: `@cour_xyz_bot`)
3. Copie le **token** (commence par `123456789:ABC...`)
4. Démarre une conversation avec ton bot, écris n'importe quoi
5. Dans un browser, visite `https://api.telegram.org/bot<TOKEN>/getUpdates`
6. Cherche `"chat":{"id":XXXXXXXXX}` → c'est ton **TELEGRAM_ALLOWED_USER_ID**

### Étape 2 — Anthropic API (2 min)

1. console.anthropic.com → Settings → API Keys → "Create Key"
2. Copie la clé (commence par `sk-ant-...`)
3. Vérifie ton budget initial sous "Plans & Billing"

### Étape 3 — Pipedrive API (3 min)

1. Login Pipedrive → Personal Preferences → API
2. Copie la **Personal API token**
3. Crée un pipeline pour les leads:
   - "Nouveaux leads" → "Contacté" → "Visite planifiée" → "Offre" → "Vendu"
4. Note l'**ID du pipeline** (URL: `/pipeline/X` → X = ID)

### Étape 4 — Gmail OAuth (10 min)

1. Va sur [console.cloud.google.com](https://console.cloud.google.com)
2. Crée un projet (ex: "Kira Bot — [Ton Nom]")
3. APIs & Services → Library → Active **Gmail API**
4. Credentials → "Create OAuth client ID" → Type "Web application"
5. Authorized redirect URIs: `https://developers.google.com/oauthplayground`
6. Copie **Client ID** et **Client Secret**
7. Va sur [developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
8. Settings → "Use your own OAuth credentials" → colle Client ID/Secret
9. Sélectionne ces scopes:
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/gmail.modify`
10. "Authorize APIs" → connecte avec ton Gmail
11. "Exchange authorization code for tokens" → copie le **Refresh Token**

### Étape 5 — Dropbox (5 min)

1. [dropbox.com/developers/apps](https://dropbox.com/developers/apps) → Create app
2. Type: **Scoped access** + **Full Dropbox** (ou App folder pour plus restreint)
3. Permissions: `files.content.read`, `files.metadata.read`, `files.content.write` (si tu veux écrire)
4. Onglet "Settings" → copie **App key** + **App secret**
5. Génère un **refresh token** via:
   ```
   https://www.dropbox.com/oauth2/authorize?client_id=APP_KEY&token_access_type=offline&response_type=code
   ```
   → autorise → copie le code → échange contre token via:
   ```
   curl -u APP_KEY:APP_SECRET -d "code=CODE&grant_type=authorization_code" \
     https://api.dropboxapi.com/oauth2/token
   ```

### Étape 6 — Structure Dropbox recommandée

Crée dans ton Dropbox:
- `/Terrain en ligne/` — un dossier par propriété active, format: `[CENTRIS#]_[adresse]/`
  - Ex: `26621771_Chemin du Lac, Rawdon/`
  - Photos en `/Photos/`, fiche en `Fiche_Detaillee_Client.pdf`
- `/Liste de contact/email_templates/` — master_template HTML pour emails brandés
- `/Inscription/` — propriétés en cours d'inscription
- `/Contacts/` — exports vCard si applicable

### Étape 7 — Brevo (optionnel, 3 min)

1. brevo.com → Settings → SMTP & API → API Keys → Create
2. Si tu veux SMS: Settings → Senders → Add sender → vérifier numéro
3. Tu auras 300 emails/jour gratuit + crédits SMS payants

### Étape 8 — Firecrawl (optionnel, 1 min)

1. firecrawl.dev → sign up → 500 scrapes/mois gratuit
2. Dashboard → API Keys → copie

### Étape 9 — Déployer sur Render (10 min)

1. Fork le repo `signaturesb/bot-assistant` (ou clone-le)
2. Render dashboard → New → Web Service → Connect repo
3. Configuration:
   - **Name**: `kira-[ton-nom]`
   - **Region**: Oregon (ou plus proche)
   - **Branch**: main
   - **Build command**: `npm install --production`
   - **Start command**: `node bot.js`
   - **Plan**: Starter ($7/mois)
4. **Environment variables** — ajoute toutes celles ci-dessous:

```env
# Bot identity
AGENT_NOM="Jean Tremblay"
AGENT_PRENOM="Jean"
AGENT_TITRE="Courtier immobilier"
AGENT_TEL="450-555-1234"
AGENT_SITE="jeantremblay.com"
AGENT_COMPAGNIE="RE/MAX Élite Joliette"
AGENT_REGION="Lanaudière"
AGENT_COULEUR="#0066cc"
AGENT_PLAN="solo"
AGENT_TENANT_ID="jean-tremblay"
SHAWN_EMAIL="jean@jeantremblay.com"
JULIE_EMAIL="assistante@jeantremblay.com"

# Telegram
TELEGRAM_BOT_TOKEN="123456:ABC..."
TELEGRAM_ALLOWED_USER_ID="987654321"
TELEGRAM_WEBHOOK_SECRET="<générer 32 chars random>"

# Anthropic
ANTHROPIC_API_KEY="sk-ant-..."

# Gmail
GMAIL_CLIENT_ID="..."
GMAIL_CLIENT_SECRET="..."
GMAIL_REFRESH_TOKEN="..."

# Dropbox
DROPBOX_APP_KEY="..."
DROPBOX_APP_SECRET="..."
DROPBOX_REFRESH_TOKEN="..."

# Pipedrive
PIPEDRIVE_API_KEY="..."
PD_PIPELINE_ID="7"
DBX_TERRAINS="/Terrain en ligne"

# Webhook secret (génère 32 chars random)
WEBHOOK_SECRET="<32 chars random>"

# Optionnel
BREVO_API_KEY="xkeysib-..."
FIRECRAWL_API_KEY="fc-..."
GITHUB_TOKEN="ghp_..."
OPENAI_API_KEY="sk-..."
```

5. Cliquez **Create Web Service** → Render build + déploie (~3 min)
6. Une fois live, visite `https://<ton-service>.onrender.com/health` → doit retourner JSON
7. Visite `https://<ton-service>.onrender.com/version` → confirme commit live

### Étape 10 — Premier test (2 min)

Sur Telegram, ouvre une conversation avec ton bot:
- Tape `/start` → confirmation bienvenue
- Tape `/diagnose` → 13 composants testés, ≥11 verts attendu
- Tape `/today` → ton dashboard du jour
- Tape `/firecrawl` → si configuré, montre quota
- Tape `/checkemail` → force scan Gmail (devrait dire "0 nouveau" si rien à traiter)

### Étape 11 — Configurer le webhook Centris (optionnel)

Si tu utilises **Make.com** pour router les emails Centris:
1. Make scenario → "Watch Email" → Filter "from: centris.ca OR remax.ca"
2. → HTTP request → POST vers `https://<ton-service>.onrender.com/webhook/centris`
3. Header: `X-Webhook-Secret: <ton WEBHOOK_SECRET>`
4. Body: JSON avec `{ from, subject, body, listingUrl }`

(Le bot scan aussi Gmail directement toutes les 30s, donc le webhook est juste un bonus de réactivité.)

---

## 🆘 Dépannage

### `/diagnose` montre du rouge sur Pipedrive
- Vérifie que `PIPEDRIVE_API_KEY` est correcte
- Test direct: `curl -H "Authorization: Bearer $KEY" https://api.pipedrive.com/v1/users/me`

### Le bot ne répond pas sur Telegram
- Webhook setup automatiquement par bot au boot
- Visite `/admin/diagnose?token=$WEBHOOK_SECRET` → doit montrer `telegramWebhook: true`
- Sinon, redémarre le service Render

### Gmail token errors
- Refresh token Gmail expire si tu révoques l'accès. Re-do l'étape 4

### Aucun lead détecté
- Vérifie que ton Gmail a vraiment des emails Centris dans la dernière journée
- `/checkemail` force un scan
- `/lead-audit <email>` après un test pour voir le parcours

---

## 💰 Coûts estimés (par courtier solo)

| Service | Plan | Coût/mois |
|---|---|---|
| Render Starter | Service web | 7$ |
| Anthropic | ~10K leads = $5-15 | 5-15$ |
| Pipedrive | Essential | 19$ |
| Gmail | Workspace Business | 0$ (perso) ou 6$/user |
| Dropbox | Plus | 12$ |
| Brevo | Free tier | 0$ |
| Firecrawl | Free tier | 0$ |
| **Total** | | **~50$/mois** |

(Plans Pro/Team de Pipedrive si plus de volume.)

---

## 📞 Support

- Bug? Ouvre une issue dans le repo: `signaturesb/bot-assistant`
- Question?: contacter l'équipe Signature SB

## 🛡 Sécurité

- ✅ WEBHOOK_SECRET protège les endpoints admin
- ✅ Tokens stockés uniquement dans Render env vars (chiffré at rest)
- ✅ Pas de clés en dur dans le code
- ✅ chmod 600 sur les fichiers locaux
- ✅ `node-fetch` natif Node 18+ (pas de deps tierces)

## 📊 Que peut faire le bot une fois actif

- 41 outils integrés (Pipedrive, Gmail, Dropbox, Brevo, Centris, GitHub, Firecrawl…)
- 24+ commandes Telegram
- 9 endpoints HTTP admin
- 3 niveaux de retry self-healing
- 4 niveaux de fallback notification
- Audit complet par lead
- Stats temps réel via `/today` et `/diagnose`

---

*Document maintenu par l'équipe. Dernière mise à jour: 2026-04-25.*
