# DEMANDES DE CHANGEMENT — Historique permanent

> **Fichier de suivi des demandes Shawn.** Chaque fois que Shawn demande une modification (email, template, UI, logique), on l'ajoute ici avec le statut.
> Consulté automatiquement au début de chaque session Claude Code.

---

## 📋 Protocole

Quand Shawn demande un changement:
1. Ajouter une entrée `## 🔴` dans la section "En cours"
2. Implémenter le fix
3. Vérifier que c'est VRAIMENT fait (tester la preview, pas juste commit)
4. Déplacer en "✅ Complétées" avec commit + date

**RÈGLE D'OR:** si Shawn dit "tu as pas fait ce que j'ai demandé", c'est qu'une demande n'a pas été correctement tracée ici ou vérifiée.

---

## 🔴 En cours

*(vide actuellement)*

---

## ✅ Complétées — Session 2026-04-22

### Email d'envoi de documents (`envoyerDocsProspect`)

**Demandé par Shawn:**
1. ✅ Utiliser master template Dropbox avec vrais logos (pas recréer)  
   → commit `cd8ad02`
2. ✅ Envoyer TOUS les PDFs du dossier (pas juste un)  
   → commit `cd8ad02`
3. ✅ Ajouter bloc programme référencement 500-1000$  
   → commit `cd8ad02` (mais doublonné, corrigé plus tard)
4. ✅ Retirer "Rawdon" à côté de RE/MAX PRESTIGE  
   → Render env var `AGENT_COMPAGNIE = "RE/MAX PRESTIGE"` (28 vars)
5. ✅ Retirer sections marketing vides (01 · Données, 02 · Stratégie, citation Centris Matrix)  
   → commit `286169e`
6. ✅ Remplacer "Données Centris Matrix" à côté du logo par "Spécialiste vente maison usagée, construction neuve et développement immobilier"  
   → commit à venir
7. ✅ **NE PAS doubler le bloc référencement** — le master template en a déjà un à la fin, retirer celui du contentHTML  
   → commit à venir

### Config Render

1. ✅ `startCommand: node bot.js` (avant: `node index.js` causait tous les deploys failed)  
   → commit `6a2fccb`
2. ✅ Ajout `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `CENTRIS_USER/PASS`
3. ✅ `AGENT_COMPAGNIE = "RE/MAX PRESTIGE"` (sans Rawdon)

### Système anti-bugs

1. ✅ Pre-commit hook `.githooks/pre-commit` → bloque commits avec erreurs Opus 4.7  
   → commit `17ca843`
2. ✅ Pre-flight API test 3s après boot → alerte Telegram si tool invalide  
   → commit `17ca843`
3. ✅ Webhook Telegram au lieu de polling (évite conflicts multi-instance)  
   → commit `5271a98`
4. ✅ Fix tool `créer_deal` → `creer_deal` (accents interdits Opus 4.7)  
   → commit `d50e129`

### Scripts diagnostiques

1. ✅ `diagnose.js` — check complet en 2s  
2. ✅ `fix.js` — commands auto-réparation (bot-status, deploy-force, etc.)  
3. ✅ `validate.js` — validation pre-commit

---

## 📚 Règles de travail avec Shawn (apprises)

1. **Les logos officiels sont DANS Dropbox** — ne jamais recréer, lire depuis `/Liste de contact/email_templates/master_template_signature_sb.html`

2. **Le master template a DÉJÀ beaucoup de blocs** — toujours vérifier ce qui y est avant d'ajouter quoi que ce soit (programme référence, sources, CTA sont déjà inclus)

3. **Quand Shawn demande de retirer quelque chose** — vérifier dans le rendu FINAL (preview HTML) que c'est bel et bien parti, pas juste commit

4. **Shawn veut du propre et professionnel** — pas de blocs marketing vides, pas de texte générique

5. **AGENT_COMPAGNIE = "RE/MAX PRESTIGE"** (sans Rawdon, retiré 2026-04-22)

6. **Spécialité Shawn** = "Spécialiste vente maison usagée, construction neuve et développement immobilier" (à côté du logo)

7. **Mémoriser chaque demande** — ce fichier évite les "tu as pas fait ce que j'ai demandé"

---

## 🔄 Mise à jour

Ce fichier est mis à jour:
- À chaque demande de Shawn (ajout "En cours")
- Après chaque commit qui répond à une demande (déplacement "Complétées")
- Revu en début de session Claude Code pour voir si quelque chose a été oublié

*Dernière mise à jour: 2026-04-22*
