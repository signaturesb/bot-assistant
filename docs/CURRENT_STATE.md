# SignatureSB / Kira — État central

Dernière mise à jour: 2026-08-21

## Rôle
Ce fichier est la source de vérité technique partagée entre ChatGPT mobile, ChatGPT desktop/ordinateur, Kira/Telegram et les travaux GitHub. Avant toute modification importante, relire ce fichier et la PR d’audit courante.

## Production actuelle
- Service Render actif: `signaturesb-bot`
- Repo production: `signaturesb/bot-assistant`
- Branche production: `main`
- Health check: `/health`
- Auto-deploy: activé sur `main`
- Ancien service `kira-bot`: suspendu
- Ancien repo `signaturesb/kira-bot`: ne doit plus être utilisé comme source de vérité

## Branche de travail / audit
- Branche: `audit/telegram-history-and-hardening`
- PR: #49 — `Audit mémoire, persistance et fiabilité Kira`
- Statut: DRAFT, NON MERGÉE
- Règle: ne pas fusionner tant que Security et tous les tests critiques ne sont pas verts et que les décisions de persistance ne sont pas validées.

## Règles non négociables
1. Aucun email client sans confirmation explicite pour CET envoi précis.
2. Une confirmation email = une seule tentative, un seul canal, contenu exact lié à l’autorisation.
3. Aucun fallback Gmail → Brevo automatique après un échec.
4. Aucune création, modification, déplacement ou suppression Pipedrive sans demande explicite de Shawn dans le message courant.
5. Les suppressions/fusions restent bloquées tant qu’une double confirmation dédiée n’est pas en place.
6. Un lead entrant, email, webhook ou cron n’autorise jamais une écriture Pipedrive ni un email client.
7. Les actions sensibles doivent échouer fermées (fail-closed) si le contexte ou l’autorisation est ambigu.
8. Aucun secret/API key/mot de passe ne doit être collé dans les conversations ou commits.
9. Aucun changement production tant que la branche d’audit n’est pas validée.
10. Tout correctif critique doit avoir un test de non-régression.

## Mémoire / persistance
- Paramètres mémoire corrigés sur la branche d’audit: `MAX_HIST=1200`, `SUMMARY_AT=600`, `SUMMARY_KEEP=300`.
- Problème ouvert critique: le service Render actif `signaturesb-bot` n’a pas de disque persistant `/data` attaché.
- L’ancien service suspendu `kira-bot` possède un disque `kira-data` monté sur `/data`.
- Le code peut actuellement retomber sur `/tmp`; `/tmp` est éphémère.
- L’historique Telegram utilise encore GitHub Gist; ce n’est pas le stockage business permanent cible.

## Sécurité / CI — état connu
Verts récemment:
- CI principal
- CodeQL
- Semgrep
- Dependency Review
- Gitleaks
- npm audit high/critical

Rouge récemment:
- Security / Dangerous surface audit

Causes encore détectées dans le vrai `bot.js` au dernier audit:
- plusieurs `shawnConsent: true` codés en dur
- plusieurs `_shawnConsent: true` codés en dur
- anciens chemins bulk/reusable consent (`flush`, admin implicite, AUTO_SAFE/retries)
- guard Pipedrive pas encore appliqué devant toutes les écritures réelles
- crash reporting référençant encore l’ancien repo `kira-bot`
- admin token encore accepté dans query string
- plusieurs surfaces Gmail directes
- nombreuses surfaces Brevo à classifier/centraliser

## Email — architecture cible
Flux unique cible:
`préparer → afficher exactement le contenu → confirmation explicite → token one-shot → une tentative → audit → fin`

Le token doit être lié à:
- canal
- TO
- CC
- BCC
- sujet
- body
- pièces jointes
- expiration courte

## Pipedrive — architecture cible
- Lecture libre pour analyse.
- Toute écriture doit passer par un guard central request-scoped.
- Le guard doit recevoir le message utilisateur Telegram courant; le modèle/tool input n’est jamais une preuve d’autorisation.
- Poller Gmail/lead entrant = analyse/notification seulement, jamais mutation CRM automatique.

## Render — état connu
- Service actif: `signaturesb-bot` (starter, 1 instance, Oregon)
- Ressources CPU/mémoire: confortables; pas de besoin identifié de payer plus de puissance actuellement.
- Quelques réponses HTTP 401 et quelques 503 observées; cause à corréler aux routes/logs.
- Problème persistance `/data` prioritaire.

## Priorités de correction
P0:
1. Faire passer Security entièrement au vert.
2. Fermer tous les anciens consentements email hardcodés/bulk.
3. Brancher réellement le Pipedrive write guard dans le vrai orchestrateur et fermer les chemins parallèles.
4. Régler la persistance durable du service actif et tester restauration.

P1:
5. Corréler/corriger 401 et 503 Render.
6. Crons, timeouts, retries, idempotence, anti-chevauchement.
7. HMAC SMS/webhooks.
8. Gmail poller/read-only et déduplication.
9. Brevo: centraliser les écritures, diagnostic read-only, bounces/quotas/webhooks.
10. Centris/Matrix/Playwright: session, MFA autorisé, cookies, téléchargements, tests end-to-end.

P2:
11. Backups/restauration automatisés et testés.
12. Monitoring, readiness/liveness, coûts, alertes dédupliquées.
13. Nettoyage dépendances modérées/dépréciées sans `--force` aveugle.
14. Nettoyage ancien repo/service/code mort.
15. Réduction progressive de `bot.js` en modules testables.

## Contexte business unifié
Le projet Kira/SignatureSB doit être traité comme un seul système avec le contexte immobilier existant: terrains, construction neuve/GCR/autoconstruction, acheteurs, vendeurs/maisons usagées, suivis Pipedrive, Centris, Dropbox, email, scripts et automatisations.

Objectif d’architecture: zéro lead perdu, aucun envoi non autorisé, aucun doublon CRM, suivi fiable, erreurs visibles, restauration possible, coûts proportionnels au ROI.

## Protocole de synchronisation ordinateur ↔ mobile
- Travailler avec le même compte ChatGPT et, idéalement, la même conversation quand possible.
- Quand un changement technique est fait depuis l’ordinateur, le consigner dans ce fichier ou dans la PR #49 avant de passer à une autre tâche.
- Avant de reprendre un chantier depuis un autre appareil, relire `docs/CURRENT_STATE.md` et l’état des checks de la PR #49.
- Ne jamais considérer une modification comme « faite » si elle n’est pas commitée/testée ou explicitement documentée ici.
- En cas de divergence entre une ancienne conversation, SESSIONLIVE.md, Claude ou ce fichier: le code réel + les checks GitHub + ce fichier d’état actuel priment.
