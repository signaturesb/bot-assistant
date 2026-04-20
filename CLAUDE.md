# SIGNATURE SB — Contexte Maître pour Claude Code

> Chargé automatiquement à chaque session. Reprendre ici sans contexte supplémentaire.
> Dernier commit: 3b10a9e | bot.js: 2996 lignes | 40 outils actifs

---

## IDENTITÉ

**Shawn Barrette** — Courtier immobilier RE/MAX PRESTIGE Rawdon  
514-927-1340 · shawn@signaturesb.com · signatureSB.com  
Assistante: Julie (julie@signaturesb.com)

## RÔLE DE CLAUDE CODE

Architecte + développeur principal du bot Telegram. Tutoiement. Français. Toujours commiter après chaque modification. `node --check bot.js` avant tout commit.

---

## BOT TELEGRAM — PRODUCTION

| Élément | Valeur |
|---|---|
| Fichier | `/Users/signaturesb/Documents/github/Claude, code Telegram/bot.js` |
| Render | srv-d7fh9777f7vs73a15ddg |
| URL | signaturesb-bot-s272.onrender.com |
| Render API Key | `REDACTED_RENDER_API_KEY` |
| Repo GitHub | signaturesb/bot-assistant |
| Modèle | claude-opus-4-7 (défaut) |
| Outils | 40 actifs |
| Lignes | 2996 |

---

## FONCTIONNALITÉS ACTIVES

### Gmail Lead Poller (NOUVEAU — commit 3b10a9e)
- Scan toutes les **5 minutes** : Centris.ca, RE/MAX Québec, Realtor.ca, DuProprio, demandes directes
- `parseLeadEmail()` : extrait nom, tel, email, Centris#, adresse, type — tous formats
- `traiterNouveauLead()` : deal Pipedrive + docs Dropbox + brouillon J+0 → notif Telegram
- État persisté : `/data/gmail_poller.json` (lastRun, processed[], totalLeads)
- Démarrage : 8s après boot (scan 6h arrière) + interval 5min
- `/checkemail` : force scan 48h
- `/poller` : statut + stats

### 40 Outils Pipedrive (14)
`voir_pipeline` `chercher_prospect` `voir_prospect_complet` `marquer_perdu` `ajouter_note` `stats_business` `créer_deal` `planifier_visite` `voir_visites` `changer_etape` `voir_activites` `modifier_deal` `creer_activite` `prospects_stagnants`

### Gmail (3)
`voir_emails_recents` `voir_conversation` `envoyer_email`

### Dropbox (5)
`list_dropbox_folder` `read_dropbox_file` `send_dropbox_file` `chercher_listing_dropbox` `envoyer_docs_prospect`

### Mobile/Contacts (3)
`chercher_contact` `historique_contact` `repondre_vite`

### Autres (15)
GitHub(4) · Brevo(1) · Recherche(1) · Bot files(2) · Diagnostics(2) · `voir_visites`(1) · `voir_activites`(1) + 3

### Vision + Audio
Photos (propriétés/terrains/contrats) · PDFs (offres/rapports) · Vocaux Whisper

### Webhooks intelligents
`/webhook/centris` `/webhook/sms` `/webhook/reply` — auto-créent deals + brouillons

### Crons quotidiens
- 7h: rappelVisitesMatin → Telegram
- 8h: runDigestJulie → Brevo → julie@signaturesb.com
- 18h: syncStatusGitHub → BOT_STATUS.md → repo bot-assistant
- (9h: J+1/J+3/J+7 — SUR GLACE)
- 5min: Gmail Lead Poller (continu)
- 30min: reload structure Dropbox
- 3h: refresh token Dropbox

---

## FLOWS CRITIQUES — ÉTAT PARFAIT

### Email (Gmail → fallback Brevo automatique)
1. `envoyer_email` → stocke dans `pendingEmails`
2. CONFIRM_REGEX: `envoie` `go` `parfait` `ok` `d'accord` `ça marche` `send`
3. Essaie Gmail (token null-safe) → si fail: Brevo auto
4. Supprime pendingEmails SEULEMENT après succès

### Docs Dropbox
1. Cherche deal → Centris → dossier `/Terrain en ligne/`
2. Vérifie taille ≤ 24MB
3. Gmail avec PJ + note Pipedrive honnête

### Création deal
1. Cherche personne existante avant créer
2. Note consolidée (tel + email + source)
3. Warning si person fail

---

## ARCHITECTURE TECHNIQUE

### Prompt caching (optimisé)
- `SYSTEM_BASE` (statique ~3500 chars) : toujours caché
- `getSystemDynamic()` (Dropbox + mémoire) : jamais caché
- Réduit cache misses ~80%

### Sécurité
- `WEBHOOK_SECRET` : validé sur tous les webhooks
- `isDuplicate()` : Map FIFO (max 2000 entrées)
- `executeToolSafe()` : timeout 30s par outil

### `AGENT_CONFIG` — SaaS multi-courtier
Toutes valeurs courtier en env vars Render. Zero hardcodé.
`AGENT_NOM` `AGENT_TEL` `AGENT_COMPAGNIE` `AGENT_REGION` `AGENT_COULEUR` `DBX_TERRAINS` etc.

### Dropbox
- Token refresh: boot + 3h
- Structure: boot + 30min
- Cache `dropboxTerrains[]`: {name, path, centris, adresse}

### Gmail
- Token null-safe (retourne null, jamais throw)
- `gmailRefreshInProgress` mutex
- Fallback Brevo auto si Gmail fail

---

## PIPEDRIVE — Pipeline ID: 7

Étapes: 49→50→51→52→53→54→55

Champs custom:
- Type: `d8961ad7b8b9bf9866befa49ff2afae58f9a888e` (T=37,CN=38,MN=39,MU=40,P=41)
- Séquence: `17a20076566919bff80b59f06866251ed250fcab` (Oui=42,Non=43)
- Centris: `22d305edf31135fc455a032e81582b98afc80104`
- Suivi J+1/J+3/J+7: fields (SUR GLACE)

---

## MAILING-MASSE

`/Users/signaturesb/Documents/github/mailing-masse/` → `node launch.js`  
5 campagnes: VENDEURS(L3-7) ACHETEURS(L5) PROSPECTS(L4) TERRAINS(L8) RÉFÉRENCEMENT(L3,6,7)  
Template local: `~/Dropbox/Liste de contact/email_templates/master_template_signature_sb.html`  
Brevo template ID 43 = version bot. **JAMAIS modifier logos base64.**

---

## ENV VARS RENDER (22+)

```
TELEGRAM_BOT_TOKEN  TELEGRAM_ALLOWED_USER_ID=5261213272
ANTHROPIC_API_KEY   OPENAI_API_KEY
PIPEDRIVE_API_KEY   BREVO_API_KEY
GMAIL_CLIENT_ID     GMAIL_CLIENT_SECRET    GMAIL_REFRESH_TOKEN
DROPBOX_ACCESS_TOKEN DROPBOX_REFRESH_TOKEN DROPBOX_APP_KEY DROPBOX_APP_SECRET
SHAWN_EMAIL  JULIE_EMAIL  GIST_ID  GITHUB_TOKEN  WEBHOOK_SECRET
SIRF_USER=57K0426  SIRF_PASS=REDACTED_PASSWORD
```

**RÈGLE CRITIQUE :** `PUT /services/{id}/env-vars` remplace TOUTES — toujours envoyer la liste complète.

---

## RÈGLES ABSOLUES

1. `node --check bot.js` avant tout commit
2. Ne jamais modifier logos base64 dans le master template Brevo
3. Toujours tester emails à shawn@signaturesb.com avant envoi masse
4. Cause perdue = `PUT status:lost`, jamais DELETE
5. Render PUT env-vars = remplace tout → envoyer liste complète
6. J+1/J+3/J+7 SUR GLACE (décommenter cron ~ligne 2425 pour réactiver)

---

## CONNEXION BOT ↔ CLAUDE CODE

- Bot écrit `BOT_STATUS.md` → GitHub repo `signaturesb/bot-assistant` chaque soir 18h
- Lire: `read_github_file(repo='bot-assistant', path='BOT_STATUS.md')`
- Gmail Poller écrit `gmail_poller.json` → `/data/` sur Render

---

## À IMPLÉMENTER (prochaines sessions)

- [ ] `chercher_comparables` — scraping Centris sold (code dans project_sessions_recentes.md)
- [ ] `comparer_marche` — DuProprio + argument commercial
- [ ] `registre_foncier` — SIRF + Infolot + APCIQ
- [ ] Couverture géo 60+ muns (Lanaudière + Montréal + Laval)
- [ ] `PERPLEXITY_API_KEY` dans Render (recherche web enrichie)
- [ ] Make.com: pointer webhooks Centris/reply → signaturesb-bot-s272.onrender.com
- [ ] Réactiver J+1/J+3/J+7 quand Shawn est prêt

---

## VISION SAAS

Louer à courtiers (~150-300$/mois) ou vendre à grande compagnie.  
`AGENT_CONFIG` complet: zero valeur hardcodée, tout en env vars.
