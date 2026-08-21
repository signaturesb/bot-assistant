# SignatureSB / Kira - État central

Dernière mise à jour vérifiée: 2026-08-21

## Rôle et ordre de priorité

Ce fichier est la source de vérité technique partagée entre ChatGPT mobile, ChatGPT ordinateur, Kira/Telegram et GitHub.

En cas de divergence, l'ordre de priorité est:

1. code réellement déployé et réponse `/version`;
2. état Render, journaux et contrôles de santé;
3. dernier commit GitHub et contrôles CI;
4. ce fichier;
5. anciens PDF, `SESSION_LIVE.md`, Gist et conversations historiques.

Ne jamais considérer un ancien handoff comme plus récent que GitHub ou Render.

## Production vérifiée

- Service Render: `signaturesb-bot`
- Repo: `signaturesb/bot-assistant`
- Branche suivie par Render: `audit/telegram-history-and-hardening`
- Commit applicatif déployé: `89190ac71559f40dbeb817ca0ff8ac907c05e934`
- Commit GitHub de configuration CI le plus récent: `3832b07f0db7270b293822cd8e8842c43003b47d`
- Le commit CI porte `[skip render]`; il est donc normal que `/version` reste sur `89190ac` jusqu'au prochain changement applicatif.
- Runtime: Node.js 22, `node bot.js`, Starter, Oregon, une instance.
- Health check Render: `/health`
- Endpoints externes vérifiés: `/healthz` = `OK`, `/readyz` = `READY`.
- Prévol au démarrage: `11/11 OK`.
- Santé intégrations: Pipedrive, Brevo, Dropbox, Anthropic et transcription toutes vertes.
- Aucun journal applicatif de niveau `error` observé depuis le déploiement de `89190ac`.

## Déploiement et CI

- Auto-deploy Render: `After CI Checks Pass` (`checksPass`).
- Les workflows CI, Security, CodeQL et Semgrep écoutent maintenant la branche réellement suivie par Render.
- Dernière validation: CI, Security, CodeQL, Semgrep et Dependency Review réussis.
- Le commit de correction CI a été volontairement ignoré par Render pour éviter un deuxième redémarrage inutile.
- Le prochain changement applicatif doit suivre automatiquement: commit -> contrôles de branche -> déploiement seulement si les contrôles passent.
- PR principale: #49, ouverte en brouillon, non fusionnée.
- PR temporaire #51: fermée, non fusionnée, afin d'éviter un doublon actif.

## Règles non négociables

1. Aucun email client sans confirmation explicite pour CET envoi précis.
2. Une confirmation email est one-shot, liée au canal, destinataire, sujet, contenu et pièces jointes; elle autorise une seule tentative.
3. `ok`, `oui`, `go`, `parfait` et formulations vagues n'autorisent jamais un envoi.
4. Aucun fallback Gmail -> Brevo automatique après une tentative consommée.
5. Pipedrive est en lecture seule par défaut.
6. Aucune création, modification, activité, note, déplacement, fusion ou suppression Pipedrive sans demande explicite de Shawn dans le message courant.
7. Les suppressions et fusions exigent une confirmation distincte.
8. Un email entrant, webhook, cron, poller, modèle IA ou déduction n'autorise jamais une mutation CRM.
9. Brevo demeure diagnostic/read-only par défaut; toute mutation ou campagne exige une autorisation explicite.
10. Les actions sensibles échouent fermées si le contexte est incomplet ou ambigu.
11. Aucun secret, mot de passe ou clé API dans les conversations, journaux ou commits.
12. Aucun lead ou courriel réel de test sans commande explicite de Shawn.

## Garde-fous validés

- Email: garde central one-shot et tests de replay, expiration, changement de contenu, confirmation vague et tentative multiple.
- Pipedrive: garde central request-scoped devant les écritures.
- Activités/visites Pipedrive: premier appel = aperçu figé; seul un `confirme` séparé et exact peut créer une fois.
- Dates: normalisation déterministe dans `America/Toronto`; contradiction jour/date bloquée.
- Heures: heure fournie conservée exactement; aucune heure inventée si elle est absente.
- Exemple testé: le lundi suivant le vendredi 21 août 2026 est le lundi 24 août 2026.
- Brevo: diagnostics read-only vérifiés.
- HMAC SMS: mauvais jeton rejeté en HTTP 401 avant traitement.
- Admin: absence de Bearer valide rejetée en HTTP 401; aucun token accepté par query string.
- Crons/boucles: garde anti-chevauchement, timeouts bornés et état flushé au shutdown.
- Audit des surfaces dangereuses: inventaire Gmail/Brevo/Pipedrive conservé, aucune violation critique active détectée.

## Pipedrive

- L'ancien `HTTP 400` sur les activités provenait d'un filtre vide converti en `person_id=0`.
- Correctif: les identifiants vides, nuls, non numériques, négatifs ou non entiers deviennent `null`; seuls les entiers positifs sûrs sont acceptés.
- Lectures d'activités migrées vers l'API Pipedrive v2.
- Tests de non-régression ajoutés pour deal, personne et filtres vides.
- Le contrôle de santé Pipedrive est vert en production.
- Aucun lead, deal, personne, note ou activité n'a été créé pendant le durcissement.

## Telegram et dépendances

- `node-telegram-bot-api` est épinglé à `1.2.0`.
- Import CommonJS compatible avec l'export nommé `TelegramBot`.
- Anciennes options `disable_web_page_preview` remplacées par `link_preview_options`.
- Test transport simulé: un `sendMessage`, une requête mockée, aucun message Telegram réel.
- Ancienne chaîne `request` / `request-promise` retirée du lockfile.
- Build Render: 165 paquets audités, `0 vulnerabilities`.
- Un avertissement de dépréciation transitive `glob@7` peut subsister via un plugin Puppeteer; aucune vulnérabilité active n'est signalée. À traiter séparément, sans upgrade forcé.

## Persistance, sauvegardes et arrêt propre

- Disque Render actif: 1 Go, monté sur `/data`.
- `/data` est la source primaire; Gist est récupération seulement et ne doit pas écraser l'état local.
- Paramètres mémoire: `MAX_HIST=1200`, `SUMMARY_AT=600`, `SUMMARY_KEEP=300`.
- Lors du dernier remplacement, l'instance a reçu SIGTERM, puis a flushé historique, pending, retry, dédup, poller et auto-envoi.
- Snapshot local vérifié: 16 fichiers sous `/data/backups/runtime/...`.
- Arrêt propre complété en 9 ms selon les journaux.
- Le disque persistant impose une seule instance et empêche le vrai zéro-downtime.
- Fenêtre 502 observée pendant le remplacement: environ 43 secondes; aucune 500/502/503 après stabilisation.
- Pour supprimer cette fenêtre, il faudra migrer l'état vers PostgreSQL/Key Value puis utiliser plus d'une instance. Ne pas retirer le disque sans plan de migration, restauration testée et autorisation de Shawn.

## Performance observée

- Mémoire stabilisée autour de 62-64 Mo sur 512 Mo.
- CPU très faible, très loin de la limite.
- Une instance active et stable.
- Aucun besoin démontré d'augmenter le plan pour la charge actuelle.

## Dropbox, Gmail et Brevo

- Dropbox OAuth rafraîchi au démarrage; index observé: 106 dossiers, 634 fichiers, 93 numéros Centris.
- Le poller Gmail est actif pour lecture/analyse; nettoyage Gmail automatique désactivé.
- Le poller entrant doit rester read-only et ne jamais autoriser seul un email ou une écriture Pipedrive.
- Brevo est vert au contrôle de santé et reste read-only par défaut.
- Aucun courriel, campagne ou mutation Brevo n'a été envoyé pendant les tests.

## Centris / Matrix

- Point restant: le parcours OAuth atteint la page Auth0 de défi SMS MFA.
- Le fallback form-based ne produit pas une session Matrix valide.
- Ce n'est pas un problème à contourner: une intervention MFA autorisée de Shawn est requise.
- Ne jamais demander ni enregistrer le code MFA dans un commit ou un journal.
- Après MFA: tester un vrai parcours représentatif, expiration de session, retry borné, screenshot diagnostic et fallback manuel.

## Écarts corrigés par rapport au PDF de handoff

Le PDF `SignatureSB_Kira_Handoff_COMPLET_Ordinateur_2026-08-21(1).pdf` est historique. Les éléments suivants ne sont plus vrais:

- Security n'est plus rouge.
- Les tests email, Pipedrive et Brevo ne sont plus skipped.
- Les 4 vulnérabilités npm modérées liées à l'ancienne chaîne Telegram sont éliminées.
- Le service actif possède maintenant un disque `/data`.
- Le Pipedrive write guard est branché et l'erreur activities HTTP 400 est corrigée.
- L'admin auth par query string et le mauvais HMAC ne sont plus acceptés.
- La branche Render n'est pas `main`; elle est `audit/telegram-history-and-hardening`.
- Le SHA `f6e1a210...` du PDF est ancien.

## Points restant à traiter

1. MFA Centris autorisé et vrai test Matrix end-to-end.
2. Décision d'architecture pour supprimer l'interruption liée au disque: PostgreSQL/Key Value + stratégie de migration.
3. Vérifier et rafraîchir `SESSION_LIVE.md`, observé très ancien; ne jamais le laisser écraser l'état courant.
4. Nettoyer progressivement l'ancien repo/service `kira-bot` seulement après preuve qu'aucune dépendance active ne l'utilise.
5. Traiter la dépréciation Puppeteer/`glob@7` séparément avec tests.
6. Décider explicitement quand et comment fusionner la PR #49 vers `main` et réaligner ensuite la branche Render.

## Prochain test contrôlé

À faire seulement quand Shawn revient et le demande:

1. lancer `/health` dans Kira et comparer au contrôle Render;
2. demander un aperçu d'activité avec une date et une heure exactes;
3. vérifier qu'aucune mutation Pipedrive n'a lieu avant le `confirme` séparé;
4. seulement ensuite créer un lead/activité de test avec des données désignées par Shawn;
5. vérifier l'unicité dans Pipedrive et l'absence d'email automatique.

## Protocole de reprise ordinateur <-> mobile

- Utiliser le même compte ChatGPT et la même conversation lorsque possible.
- Avant toute modification, lire ce fichier, la PR #49, le dernier SHA GitHub et `/version`.
- Documenter cause racine, correction, tests, résultat, risque restant et état production.
- Ne jamais réexécuter une mutation parce qu'une autre conversation semble incomplète.
- Ne jamais déclarer un correctif terminé sans preuve de test et surveillance post-déploiement.
- Cycle permanent: améliorer -> tester -> surveiller -> détecter -> corriger -> empêcher la récidive.
