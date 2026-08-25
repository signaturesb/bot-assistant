# Registre des capacités de Kira

Dernière vérification locale: 2026-08-24

Ce document est la mémoire opérationnelle des capacités. Il distingue ce que le bot Telegram peut réellement exécuter de ce qui existe seulement dans Codex, dans une feuille de route ou dans l'écosystème externe.

## Source de vérité

- Exécutable dans Telegram: uniquement un outil déclaré dans `TOOLS` de `bot.js` et accepté au préflight.
- Actif en production: outil présent dans le commit déployé, configuration requise disponible et test de santé réussi.
- Prêt mais inactif: code présent, mais configuration, permission ou test réel manquant.
- À évaluer: idée ou technologie non intégrée. Kira ne doit jamais la présenter comme disponible.
- Les skills et connecteurs de Codex aident au développement du bot; ils ne deviennent pas automatiquement des outils Telegram.

## Inventaire vérifié

Le code local déclare 65 outils, répartis ainsi:

- Pipedrive et ventes: pipeline, prospects, deals, personnes, notes, activités, visites, classement, fusion et suppression protégée.
- Courriel et contacts: lecture Gmail, conversation, aperçu et envoi confirmé, contacts Brevo.
- Centris/Matrix: vérification d'inscription, fiche officielle, documents additionnels, Zone, comparables, rapports et zonage.
- Dropbox et documents: navigation, lecture, recherche de listing et partage de fichiers.
- Web et recherche: recherche web, scraping municipal/général/avancé, PDF et documents.
- Développement contrôlé: lecture/écriture de fichiers autorisés et dépôts GitHub.
- Analyse d'affaires: statistiques, stagnation, historique, réponses rapides et résumés d'appels.

L'inventaire exact reste généré par `TOOLS`; ce document ne remplace jamais le code.

## Routage fiable

1. Comprendre le résultat demandé et ses critères de réussite.
2. Faire les lectures indépendantes en parallèle lorsque cela est sans effet externe.
3. Produire un aperçu lorsque l'action touche un client, un courriel ou un document.
4. Lier la confirmation au contenu exact: destinataire, sujet, corps et pièces jointes.
5. Exécuter une seule fois, puis vérifier la preuve de bout en bout.
6. Si une couche échoue, nommer cette couche et conserver le workflow demandé; aucun faux succès et aucun détour non demandé.

## Limites et sécurité

- Ne jamais mémoriser de secret, clé, jeton, mot de passe ou code MFA.
- Une confirmation expirée, ancienne ou liée à un autre aperçu ne peut jamais autoriser une action.
- Une prévisualisation Telegram échouée ne peut pas armer un envoi.
- Les suppressions, modifications externes et envois restent soumis aux gardes du code.
- Les technologies « dernier cri » passent d'abord par un test représentatif mesurant exactitude, fiabilité, latence et coût.

## Cycle d'amélioration

- Observer les erreurs réelles et les demandes répétées.
- Ajouter un test de non-régression avant toute nouvelle intégration.
- Comparer la nouvelle solution à la version active sur les mêmes cas.
- Déployer seulement si les critères de réussite passent.
- Surveiller le comportement réel et prévoir un retour arrière.

## Priorités actuelles

1. Finaliser et éprouver le téléchargement Matrix authentifié des PDF.
2. Garantir l'unicité aperçu → confirmation → envoi du courriel.
3. Aligner les tests de production et la branche réellement déployée.
4. Mettre à jour la veille technologique seulement avec des sources datées et vérifiables.
