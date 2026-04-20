# ÉTAT DU SYSTÈME — Signature SB Bot

> Fichier de référence permanent. Mis à jour après chaque session de travail.
> Si une conversation Claude Code est interrompue, lire ce fichier pour reprendre.

**Dernière mise à jour:** 2026-04-19  
**Commit actuel:** 3111f20

---

## PRODUCTION

| Élément | Valeur |
|---|---|
| URL | signaturesb-bot-s272.onrender.com |
| Service Render | srv-d7fh9777f7vs73a15ddg |
| Render API Key | `REDACTED_RENDER_API_KEY` |
| Modèle IA | claude-opus-4-7 (défaut) |
| Outils actifs | 40 |
| Lignes de code | ~2500 |

---

## FLOWS — ÉTAT PARFAIT (commit 3111f20)

### ✅ Envoi email
- Gmail priorité → fallback Brevo automatique si Gmail fail
- Token Gmail null-safe (jamais crash)
- CONFIRM_REGEX: "envoie", "go", "parfait", "ok", "d'accord", "ça marche", "send"
- Brouillon conservé si les deux échouent

### ✅ Envoi documents Dropbox
- Lookup par Centris d'abord, puis nom
- Limite 24MB vérifiée avant envoi
- Note Pipedrive honnête (ajoutée / non créée)
- Timeout 20s sur envoi Gmail

### ✅ Création deal Pipedrive
- Cherche personne existante avant créer (évite doublons)
- Warning si person fail
- Note consolidée (note + tel + email + source)
- pipeline_id dynamique via AGENT.pipeline_id

---

## FONCTIONNALITÉS ACTIVES

| Feature | Status |
|---|---|
| Vision photos (propriétés, terrains, listings) | ✅ |
| Analyse PDFs (contrats, offres, rapports) | ✅ |
| Messages vocaux Whisper | ✅ |
| Pipedrive complet (14 outils) | ✅ |
| Gmail (envoi + lecture + conversation) | ✅ |
| Dropbox (listing, docs, envoi avec PJ) | ✅ |
| Webhooks intelligents (Centris/SMS/reply) | ✅ |
| Thinking mode (/penser) | ✅ |
| Sync BOT_STATUS.md GitHub 18h | ✅ |
| Rappel visites 7h | ✅ |
| Digest Julie 8h | ✅ |
| J+1/J+3/J+7 suivi | ⏸️ SUR GLACE |
| Comparables Centris | ❌ À implémenter |
| Registre foncier SIRF | ❌ À implémenter |
| DuProprio comparison | ❌ À implémenter |

---

## AGENT_CONFIG (SaaS)

Toutes les valeurs courtier dans env vars Render. Pour un autre courtier = changer les vars, rien d'autre.

Variables: `AGENT_NOM`, `AGENT_PRENOM`, `AGENT_TEL`, `AGENT_COMPAGNIE`, `AGENT_SITE`, `AGENT_ASSIST`, `AGENT_REGION`, `AGENT_COULEUR`, `DBX_TERRAINS`, `DBX_TEMPLATES`, `DBX_CONTACTS`, `PD_PIPELINE_ID`

---

## DROPBOX

- Token refresh: proactif au boot + toutes les 3h
- Structure: rechargée toutes les 30min
- Cache `dropboxTerrains[]`: {name, path, centris, adresse}
- Paths: `/Terrain en ligne/`, `/Liste de contact/email_templates/`, `/Contacts/`
- Master template: `/Liste de contact/email_templates/master_template_signature_sb.html`
- Brevo template ID 43 = version production

---

## PIPEDRIVE

Pipeline ID: 7 (via AGENT.pipeline_id)  
Étapes: 49→50→51→52→53→54→55

Champs custom:
- Type: `d8961ad7b8b9bf9866befa49ff2afae58f9a888e`
- Séquence: `17a20076566919bff80b59f06866251ed250fcab`
- Centris: `22d305edf31135fc455a032e81582b98afc80104`

---

## ENV VARS RENDER (22+)

```
TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID=5261213272
ANTHROPIC_API_KEY, OPENAI_API_KEY
PIPEDRIVE_API_KEY, BREVO_API_KEY
GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
DROPBOX_ACCESS_TOKEN, DROPBOX_REFRESH_TOKEN, DROPBOX_APP_KEY, DROPBOX_APP_SECRET
SHAWN_EMAIL, JULIE_EMAIL, GIST_ID, GITHUB_TOKEN
SIRF_USER=57K0426, SIRF_PASS=REDACTED_PASSWORD
```

**RÈGLE:** `PUT /services/{id}/env-vars` remplace TOUTES — toujours envoyer la liste complète.

---

## À FAIRE PROCHAINES SESSIONS

1. `chercher_comparables` — scraping Centris sold
2. `comparer_marche` — DuProprio + argument commercial
3. `registre_foncier` — SIRF + Infolot + APCIQ
4. Couverture géo 60+ municipalités
5. `PERPLEXITY_API_KEY` dans Render
6. Make.com: pointer /webhook/centris → signaturesb-bot-s272.onrender.com
7. Réactiver J+1/J+3/J+7 quand Shawn est prêt (décommenter cron ~ligne 2375)

---

## VISION SAAS

Louer à courtiers (~150-300$/mois) ou vendre à grande compagnie.  
Fondation: AGENT_CONFIG complet, system prompt dynamique, zéro valeur hardcodée.
