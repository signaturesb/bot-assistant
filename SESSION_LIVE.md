# SESSION LIVE - 2026-08-21 - ÉTAT VÉRIFIÉ

## Source de vérité

Avant toute action, utiliser cet ordre:

1. réponse production `/version`, `/healthz` et `/readyz`;
2. état et journaux Render;
3. dernier commit GitHub et contrôles CI;
4. `docs/CURRENT_STATE.md`;
5. ce résumé live.

Les anciennes conversations, anciens commits, Gist et handoffs ne doivent jamais écraser un état plus récent.

## Production actuelle

- Service: `signaturesb-bot`
- Repo: `signaturesb/bot-assistant`
- Branche Render: `audit/telegram-history-and-hardening`
- Commit applicatif déployé: `89190ac71559f40dbeb817ca0ff8ac907c05e934`
- Runtime: Node.js 22, une instance Render Starter, disque 1 Go sur `/data`
- Santé externe: `/healthz` = `OK`, `/readyz` = `READY`
- Prévol: 11/11 OK
- Pipedrive, Brevo, Dropbox, Anthropic et transcription: verts
- Build: 0 vulnérabilité npm
- Aucun journal applicatif `error` observé depuis le dernier déploiement

## Règles absolues

- EMAIL: préparer et afficher un aperçu; ne jamais envoyer sans commande exacte de Shawn pour CET envoi.
- Une confirmation email est one-shot et liée au canal, destinataire, sujet, contenu et pièces jointes.
- `ok`, `oui`, `go` et `parfait` n'autorisent jamais un email.
- Aucun fallback Gmail vers Brevo sans une nouvelle confirmation.
- PIPEDRIVE: lecture seule par défaut.
- Aucune personne, lead, deal, activité, note, modification, fusion ou suppression sans demande explicite de Shawn dans le message courant.
- Une activité ou visite planifiée doit d'abord produire un aperçu figé; seul un `confirme` séparé peut créer une fois.
- Une suppression ou fusion exige une confirmation distincte.
- BREVO: diagnostic/read-only par défaut; aucune campagne, mutation ou suppression sans autorisation explicite.
- Un email entrant, webhook, cron, poller, modèle IA ou déduction ne constitue jamais un consentement.
- Ne jamais créer un lead ou envoyer un courriel de test sans commande explicite de Shawn.
- Ne jamais exposer une clé API, un mot de passe, un cookie ou un code MFA.

## Dates et heures

- Fuseau: `America/Toronto`.
- Toujours calculer la vraie date du calendrier.
- Le lundi suivant le vendredi 21 août 2026 est le lundi 24 août 2026.
- Si jour et date se contredisent, bloquer et demander une précision.
- Si une heure est donnée, la conserver exactement.
- Si aucune heure n'est donnée, ne jamais en inventer une.

## Pipedrive

- L'erreur activities HTTP 400 causée par `person_id=0` est corrigée.
- Les filtres relationnels vides deviennent `null`; seuls les identifiants positifs sûrs sont acceptés.
- Les lectures d'activités utilisent l'API Pipedrive v2.
- Le garde d'écriture request-scoped et les tests de non-régression sont actifs.
- Aucun lead, deal, personne, note ou activité n'a été créé pendant le durcissement.

## Telegram et sécurité

- `node-telegram-bot-api` 1.2.0 est déployé.
- L'ancienne chaîne `request` vulnérable est retirée.
- Mauvais HMAC SMS: rejet HTTP 401.
- Admin sans Bearer valide: rejet HTTP 401.
- CI, Security, CodeQL, Semgrep et Dependency Review: verts.
- Les workflows ciblent maintenant la branche suivie par Render.
- PR #49 reste ouverte en brouillon; ne pas fusionner automatiquement.
- PR temporaire #51 est fermée et non fusionnée.

## Persistance et boucles

- `/data` est primaire; Gist est récupération seulement.
- Dernier shutdown: historique, pending, retry, dédup, poller et auto-envoi flushés.
- Snapshot local vérifié: 16 fichiers.
- Les boucles utilisent un garde anti-chevauchement et des timeouts bornés.
- Le disque impose une seule instance et une courte interruption lors d'un remplacement.
- Ne jamais retirer le disque sans migration et restauration testées.

## Centris / Matrix - correction importante

- L'ancienne affirmation de contournement du MFA Centris est invalide et ne doit plus être utilisée.
- Le parcours actuel atteint le défi SMS MFA Auth0 et s'arrête correctement.
- Le fallback form-based ne crée pas une session Matrix valide.
- Ne jamais contourner le MFA.
- Une intervention MFA autorisée de Shawn est requise avant le prochain test réel.
- Les anciens LaunchAgents Mac ne constituent pas une garantie server-side et ne doivent pas être considérés comme actifs sans vérification.

## White-label et documents

- Les anciens tests de template ou scraping ne donnent jamais une autorisation d'envoyer un email.
- Le bot peut préparer un template, récupérer des documents autorisés et produire un aperçu.
- L'envoi Gmail/Brevo réel demeure bloqué jusqu'à la confirmation one-shot de Shawn.
- Vérifier propriété, client, destinataire et pièces jointes avant chaque aperçu.

## Prochain test contrôlé

Seulement sur demande explicite de Shawn:

1. exécuter `/health`;
2. produire un aperçu d'activité avec date et heure exactes;
3. vérifier zéro mutation avant `confirme`;
4. créer ensuite un lead/activité de test désigné;
5. vérifier déduplication et absence d'email automatique.

Pour les détails complets et les risques restants, lire `docs/CURRENT_STATE.md`.
