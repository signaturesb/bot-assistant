# SIGNATURE SB — Contexte Maître pour Claude Code

> Chargé automatiquement à chaque session Claude Code.
> Reprendre ici sans avoir besoin de context supplémentaire.

---

## IDENTITÉ

**Shawn Barrette** — Courtier immobilier agréé  
RE/MAX PRESTIGE Rawdon · signatureSB.com · 514-927-1340  
Email: shawn@signaturesb.com | iCloud: shawnbarrette@icloud.com | Assistante: Julie (julie@signaturesb.com)

## RÔLE DE CLAUDE CODE

Architecte système senior + développeur principal du bot Telegram.  
Priorité: stabilité, performance, ROI. Toujours en français. Tutoiement avec Shawn.

---

## BOT TELEGRAM — ÉTAT ACTUEL (2026-04-19)

**Fichier principal:** `/Users/signaturesb/Documents/github/Claude, code Telegram/bot.js`  
**Service Render:** srv-d7fh9777f7vs73a15ddg  
**URL production:** signaturesb-bot-s272.onrender.com  
**Repo GitHub:** signaturesb/bot-assistant  
**Render API Key:** `REDACTED_RENDER_API_KEY`  
**Dernier commit:** 3111f20

### Modèle
- **Défaut: `claude-opus-4-7`** (Anthropic, avril 2026)
- `/opus` → 4.7 | `/sonnet` → Sonnet 4.6 | `/haiku` → Haiku 4.5 | `/penser` → thinking mode

### 40 Outils actifs
**Pipedrive (12):** voir_pipeline, chercher_prospect, voir_prospect_complet, marquer_perdu, ajouter_note, stats_business, créer_deal, planifier_visite, voir_visites, changer_etape, voir_activites, modifier_deal, creer_activite, prospects_stagnants  
**Gmail (3):** voir_emails_recents, voir_conversation, envoyer_email  
**Dropbox (5):** list_dropbox_folder, read_dropbox_file, send_dropbox_file, chercher_listing_dropbox, envoyer_docs_prospect  
**GitHub (4):** list_github_repos, list_github_files, read_github_file, write_github_file  
**Contacts/Mobile (3):** chercher_contact, historique_contact, repondre_vite  
**Brevo (1):** ajouter_brevo  
**Recherche (1):** rechercher_web  
**Bot files (2):** read_bot_file, write_bot_file  
**Diagnostics (2):** tester_dropbox, voir_template_dropbox  

### Capacités complètes
- Vision: photos propriétés/terrains/contrats → Opus 4.7 analyse directement
- PDFs: offres, rapports, certificats → extraction clés automatique
- Vocaux: Whisper transcription → action
- Webhooks intelligents: Centris/SMS/email → deal auto-créé + brouillon J+0 prêt
- Email: Gmail (priorité) + fallback Brevo automatique, branded AGENT_CONFIG
- Docs Dropbox: trouve par Centris/nom, télécharge, envoie par email avec pièce jointe
- Deals: cherche personne existante avant créer, note consolidée, warning si orphelin
- Pipeline mobile: /stagnants, /relances (sur glace), /lead [info], /stats avec alertes

### Tâches cron
- 7h → Rappel visites du jour
- 8h → Digest Julie (Brevo)
- 18h → BOT_STATUS.md → GitHub (pour sync Claude Code)
- (9h Suivi J+1/J+3/J+7 — SUR GLACE, décommenter quand prêt)

### J+1/J+3/J+7 — SUR GLACE
Désactivé par Shawn le 2026-04-19. Code intact, cron commenté.  
Pour réactiver: décommenter ligne ~2375 dans bot.js.

### AGENT_CONFIG (SaaS multi-courtier)
Toutes les valeurs courtier en env vars Render: AGENT_NOM, AGENT_TEL, AGENT_COMPAGNIE, etc.  
Zero valeur hardcodée. Pour onboarder un autre courtier: changer les env vars.

### Dropbox
- Structure chargée au boot + rechargée toutes les 30min
- Token refresh proactif au boot + toutes les 3h
- Cache `dropboxTerrains[]` → lookup par Centris O(1)
- Paths: /Terrain en ligne/, /Liste de contact/email_templates/, /Contacts/

### Connexion bot ↔ Claude Code
Bot écrit `BOT_STATUS.md` dans repo signaturesb/bot-assistant chaque soir à 18h.  
Pour voir état runtime: `read_github_file(repo='bot-assistant', path='BOT_STATUS.md')`

### Env vars Render (22+)
TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID=5261213272, ANTHROPIC_API_KEY, OPENAI_API_KEY,  
PIPEDRIVE_API_KEY, BREVO_API_KEY, GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN,  
DROPBOX_ACCESS_TOKEN/REFRESH_TOKEN/APP_KEY/APP_SECRET,  
SHAWN_EMAIL, JULIE_EMAIL, GIST_ID, GITHUB_TOKEN,  
SIRF_USER=57K0426, SIRF_PASS=REDACTED_PASSWORD

**RÈGLE CRITIQUE Render API:** `PUT /services/{id}/env-vars` REMPLACE TOUTES les vars — toujours envoyer la liste complète.

---

## STACK TECHNOLOGIQUE

| Outil | Rôle | Statut |
|---|---|---|
| Bot Telegram (bot.js) | Assistant IA 24/7 — 40 outils | ✅ Production |
| Pipedrive | CRM prospects | ✅ Actif (pipeline ID: 7) |
| Brevo | Email masse + fallback email | ✅ Actif |
| Dropbox | Documents propriétés + templates | ✅ Actif (refresh auto) |
| Gmail | Email principal (avec pièces jointes) | ✅ Actif |
| Claude API (Opus 4.7) | Cerveau du bot | ✅ Actif |
| GitHub | Code + BOT_STATUS.md | ✅ Actif |
| Whisper (OpenAI) | Transcription vocaux | ✅ Actif |
| Make.com | Orchestration webhooks | ⏳ À pointer vers bot |
| mailing-masse/ | Campagnes Brevo (node launch.js) | ✅ Opérationnel |
| Perplexity API | Recherche web enrichie | ⏳ Clé à configurer |

---

## PIPEDRIVE — Pipeline (ID: 7)

Étapes: Nouveau Lead(49) → Contacté(50) → En discussion(51) → Visite prévue(52) → Visite faite(53) → Offre déposée(54) → Gagné(55)

Champs custom:
- Type propriété: `d8961ad7b8b9bf9866befa49ff2afae58f9a888e` (T=37, CN=38, MN=39, MU=40, P=41)
- Séquence active: `17a20076566919bff80b59f06866251ed250fcab` (Oui=42, Non=43)
- N° Centris: `22d305edf31135fc455a032e81582b98afc80104`
- Suivi J+1: `f4d00fafcf7b73ff51fdc767049b3cbd939fc0de`
- Suivi J+3: `a5ec34bcc22f2e82d2f528a88104c61c860e303e`
- Suivi J+7: `1d2861c540b698fce3e5638112d0af51d000d648`

---

## MAILING-MASSE

**Dossier:** `/Users/signaturesb/Documents/github/mailing-masse/`  
**Lancer:** `node launch.js` (menu interactif)

5 campagnes: VENDEURS (L3-7 ~1029), ACHETEURS (L5), PROSPECTS (L4), TERRAINS (L8 104 entrepreneurs), RÉFÉRENCEMENT (L3,6,7)

Master template: `~/Dropbox/Liste de contact/email_templates/master_template_signature_sb.html`  
Brevo template ID 43 = version production bot  
**JAMAIS modifier les logos base64** dans le template.

---

## VISION SAAS (objectif stratégique)

Louer le système à d'autres courtiers (~150-300$/mois) ou vendre à grande compagnie.  
Fondation déjà en place: AGENT_CONFIG (toutes valeurs en env vars), system prompt dynamique.  
Voir `memory/project_saas_vision.md` pour le plan complet.

---

## RÈGLES ABSOLUES

1. Ne jamais modifier logos base64 dans master template Brevo
2. Toujours tester emails à shawn@signaturesb.com avant envoi masse
3. Cause perdue = `PUT status:lost`, jamais DELETE dans Pipedrive
4. CONFIRM_REGEX email: "envoie", "go", "parfait", "ok", "d'accord", "ça marche"
5. Render API: PUT env-vars = remplace TOUT — toujours envoyer liste complète
6. node --check bot.js avant tout commit
7. Vérifier syntaxe, commiter avec message descriptif

---

## À FAIRE (prochaines sessions)

- [ ] Implémenter comparables Centris (`chercher_comparables` tool)
- [ ] Implémenter DuProprio comparison (`comparer_marche` tool)  
- [ ] Implémenter Registre Foncier SIRF (`registre_foncier` tool)
- [ ] Couverture géo 60+ muns (Lanaudière + Montréal + Laval)
- [ ] Configurer PERPLEXITY_API_KEY dans Render
- [ ] Pointer Make.com webhook Centris → signaturesb-bot-s272.onrender.com
- [ ] Réactiver J+1/J+3/J+7 quand Shawn est prêt
