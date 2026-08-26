# Matrix → PDF → courriel — mise en production et retour arrière

Ce guide protège le flux où Shawn écrit un numéro Centris et un courriel dans
Telegram, reçoit tous les PDF et l'aperçu, puis répond une seule fois `envoie`.
Un test technique ne doit jamais envoyer de courriel réel.

## Contrat fonctionnel obligatoire

- Une commande courte comme `10709767 à client@example.com` ouvre l'aperçu.
- Le numéro Centris et le destinataire sont uniques et exacts; aucune
  substitution de numéro ou de courriel n'est permise.
- La recherche se fait dans Matrix Zone courtier authentifié, y compris pour
  une inscription d'un autre courtier lorsque le compte de Shawn y a accès.
- Le nombre de documents est découvert à chaque inscription. Il n'est jamais
  fixé globalement à 9, 10, 11 ou 20.
- La fiche détaillée avec photos et toutes les annexes visibles sont validées.
  Un seul échec, doublon, PDF corrompu ou inventaire modifié bloque le courriel.
- La fiche détaillée PDF portant le numéro Centris exact est la preuve finale
  de l'adresse complète. Le DOM Matrix ne sert que d'aide de navigation ou de
  lecture de la rue. Une adresse ambiguë bloque l'aperçu.
- Le prix est extrait d'une ligne monétaire proche du numéro Centris exact;
  un montant lié à une autre fiche ou une taxe ne doit jamais gagner.
- L'aperçu Telegram montre l'adresse, le destinataire, le Cc visible, l'objet,
  le corps complet et le manifeste de chaque PDF.
- Pour un destinataire externe, `shawn@signaturesb.com` est toujours en Cc
  visible. Si Shawn est lui-même le destinataire, aucune copie artificielle
  n'est ajoutée.
- Une seule confirmation exacte `envoie` peut consommer la transaction. Un
  second clic ou un second message est refusé.
- Un succès exige l'identifiant de message retourné par Gmail. Un délai réseau
  ambigu produit `état incertain` et interdit toute relance automatique.

## Contrôles avant publication

1. Vérifier que le dépôt est propre à l'exception du correctif attendu.
2. Exécuter les vérifications de syntaxe de `bot.js`, `cua_driver.js` et des
   modules Matrix.
3. Exécuter la suite complète avec `npm test`; toutes les suites doivent être
   vertes et aucune ne doit joindre Gmail, Telegram ou Matrix en production.
4. Exécuter le prévol local. Toute alerte de sécurité, cache, MIME, Cc,
   confirmation, PDF ou inventaire est bloquante.
5. Vérifier que `SENTRY_DSN` est configuré dans Render seulement si le projet
   Sentry privé existe. Sans DSN, la surveillance est désactivée proprement et
   le workflow reste fonctionnel. Ne jamais écrire la valeur du DSN dans Git.
6. Faire relire le diff final et noter le commit candidat ainsi que le commit
   de retour arrière.

## Publication contrôlée

La publication exige une autorisation explicite distincte. Avant cette phrase,
il est interdit de pousser, déployer ou envoyer un courriel réel.

Phrase attendue :

`Je confirme la publication du commit <COMMIT> sur GitHub et son déploiement en production sur le service Render srv-d7fh9777f7vs73a15ddg. Aucun courriel réel pendant le déploiement.`

Après autorisation :

1. Pousser uniquement le commit candidat vérifié sur la branche convenue.
2. Déployer ce hash exact; ne jamais déployer un état de travail non committé.
3. Attendre la fin du déploiement et vérifier le démarrage, la santé HTTP et
   l'absence d'erreur Matrix/Sentry dans les journaux.
4. Confirmer que le hash actif dans Render est exactement le hash autorisé.
5. Exécuter seulement les tests sans envoi. Le test réel nécessite encore une
   demande séparée contenant le numéro Centris et le courriel de test.

## Retour arrière

Commit stable de référence avant ce lot : `0a7b94c`.

Déclencheurs de retour arrière : démarrage impossible, connexion Matrix brisée,
inventaire incomplet déclaré à tort, adresse d'une autre fiche, absence du Cc,
confirmation réutilisable, faux succès Gmail ou hausse anormale des erreurs.

1. Suspendre le test réel et ne relancer aucun courriel.
2. Dans Render, redéployer le commit stable exact `0a7b94c` à l'aide de la
   fonction de retour arrière/redeploy. Ne pas réécrire l'historique Git.
3. Attendre le statut `Live`, puis vérifier le hash actif, la santé HTTP et le
   démarrage Telegram.
4. Exécuter les tests locaux sans envoi contre le commit stable.
5. Conserver les identifiants de corrélation Sentry et les reçus techniques,
   sans copier de courriel, adresse, téléphone ou contenu PDF.
6. Documenter l'incident, corriger sur une branche séparée et refaire toutes
   les vérifications avant une nouvelle autorisation de déploiement.

## Test réel après déploiement

Le premier test réel se fait uniquement vers l'adresse indiquée explicitement
par Shawn dans la commande. Le bot remet d'abord les PDF et l'aperçu dans
Telegram. Shawn vérifie le numéro, l'adresse, le destinataire, le Cc, le contenu
et le nombre de pièces, puis répond exactement `envoie`. Le résultat est valide
seulement si Gmail retourne un identifiant et si toutes les pièces du manifeste
sont présentes dans le courriel reçu.
