# INSTRUCTIONS POUR CLAUDE CODE (Mac de Shawn)

**À LIRE EN PREMIER à chaque session.**

---

## 🎯 MISSION

Shawn t'a délégué l'exécution complète de `ROADMAP_OPTIMISATION.md`.
Tu travailles **en autonomie** — Shawn valide seulement les étapes critiques.

---

## ⚙️ RÈGLES D'EXÉCUTION

### 1. Toujours lire en premier
- `SESSION_LIVE.md` → état actuel
- `ROADMAP_OPTIMISATION.md` → plan global
- `ANTI_DOUBLONS.md` → règles CRM

### 2. Workflow phase par phase
- **Une phase à la fois**, dans l'ordre
- Chaque phase: branch Git → tests locaux → commit → push → deploy → valider /health
- **Si deploy fail** → rollback immédiat au commit précédent stable

### 3. Validation obligatoire de Shawn AVANT:
- ❌ Modifier le system prompt du bot
- ❌ Envoyer des emails/Telegram de masse aux prospects
- ❌ Changer credentials/tokens
- ❌ Modifier structure Pipedrive (étapes, champs custom)

### 4. Autonomie totale SUR:
- ✅ Fix bugs techniques
- ✅ Ajouter nouveaux outils au bot
- ✅ Refactorer code
- ✅ Améliorer prompts internes
- ✅ Ajouter health checks, logs, monitoring
- ✅ Créer fichiers de config

### 5. Communication avec Shawn
- Mettre à jour `SESSION_LIVE.md` après chaque action importante
- Si bloqué → écrire dans `SESSION_LIVE.md` section "BLOQUÉ — ATTENTE SHAWN"
- Le bot Telegram lit `SESSION_LIVE.md` automatiquement → Shawn verra

---

## 🛡️ SÉCURITÉ — NE JAMAIS

1. Push direct sur `main` sans tests locaux passants
2. Déployer vendredi après 15h (risque weekend cassé)
3. Toucher à la base Pipedrive prod sans backup
4. Envoyer des emails de test aux vrais prospects
5. Supprimer du code sans savoir à quoi il sert

---

## 📋 ORDRE D'EXÉCUTION

Suivre strictement `ROADMAP_OPTIMISATION.md`:

**Phase 1** (CRITIQUE) → fix deploy, débloquer 39 outils
**Phase 2** → intelligence proactive (réveil matinal, alertes)
**Phase 3** → auto-healing (tokens, crash reports)
**Phase 4** → rapports business
**Phase 5** → enrichissement leads
**Phase 6** → prédiction ML (plus tard)

---

## 🔄 APRÈS CHAQUE PHASE COMPLÉTÉE

1. Mettre à jour `SESSION_LIVE.md`:
   ```
   ## ✅ PHASE X COMPLÉTÉE — [date]
   - Ce qui a été fait
   - Résultat /health
   - Prochaine phase
   ```
2. Commit avec message clair: `[PHASE X] Description`
3. Attendre 24h de stabilité avant de passer à la phase suivante
4. Pinger Shawn via note dans `SESSION_LIVE.md` si validation requise

---

## 🧠 PRINCIPE DIRECTEUR

**"Logique et efficace, sans chambouler le processus actuel."**

- Changements incrémentaux, jamais de refonte massive
- Backward compatible — le bot doit continuer à tourner pendant les updates
- Tests avant deploy — toujours
- Si doute → demander à Shawn via `SESSION_LIVE.md`

---

**Dernière mise à jour:** 2026-04-22 par le bot Telegram suite demande Shawn.
