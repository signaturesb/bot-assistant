# AMÉLIORATION CONTINUE — Intelligence Signature SB

> **Fichier vivant.** Chaque session Claude Code ajoute ici ce qu'elle apprend.
> Consulté automatiquement au début de chaque session (via mémoire Claude Code).

---

## 🎯 Mission

Devenir les **#1 courtiers immobiliers** en Lanaudière, puis vendre le système comme SaaS à d'autres courtiers RE/MAX, puis possible vente à grande compagnie.

---

## 📊 Tableau de bord performance

### Métriques cibles vs actuelles (à maintenir)

| Métrique | Cible | Actuel | Notes |
|---|---|---|---|
| Leads/semaine | 10+ | — | Gmail Poller 5min actif |
| Temps lead → contact | < 5 min | — | J+0 auto-drafted par bot |
| Lead → visite | > 40% | — | Tracker dans Pipedrive |
| Visite → offre | > 30% | — | Tracker dans Pipedrive |
| Offre → close | > 70% | — | Tracker dans Pipedrive |
| Ventes/mois | 8+ | — | Tracker dans Pipedrive |

*À compléter après chaque mois.*

---

## 💡 Tactiques qui ont fonctionné (ajouter ici)

### Template
```
**Date:** YYYY-MM-DD
**Situation:** Description courte
**Tactique utilisée:** Quoi
**Résultat:** Quoi est arrivé
**Enseignement:** Ce qu'on garde
```

### Exemples à compléter

*Aucune tactique loggée encore — ajouter à chaque succès significatif.*

---

## ❌ Tactiques qui n'ont pas fonctionné

*À compléter pour éviter répétition d'erreurs.*

---

## 🔧 Optimisations techniques accumulées

### 2026-04-22 — Session majeure
- **Validation pre-commit** : hook `.githooks/pre-commit` bloque les commits avec tools invalides Opus 4.7
- **Pre-flight API** : 3s après boot, test Claude avec tous tools, alerte Telegram si rejet
- **formatAPIError intelligent** : parse tool index fautif depuis message d'erreur
- **Git push dual** : kira-bot + bot-assistant synchronisés automatiquement
- **Auto-diagnostic GitHub** : BOOT_REPORT.md + CRASH_REPORT.md écrits automatiquement
- **Circuit breakers** : 5 échecs consécutifs → service coupé 5min (évite cascade)
- **Rate limiter** : 15 req/min max côté bot (évite 429)
- **Webhook Telegram** au lieu de polling (production-grade)

### Règles absolues apprises
1. Opus 4.7: noms tools regex `[a-zA-Z0-9_-]` (aucun accent)
2. Opus 4.7: pas de temperature/top_p/top_k
3. Opus 4.7: last message doit être `role: user`
4. Render: `startCommand` doit pointer vers fichier réel
5. Render: `server.listen()` en PREMIER dans main() (health check)
6. Render: `PUT /env-vars` REMPLACE toutes les vars
7. Git: configurer push dual pour kira-bot + bot-assistant

---

## 🧠 Intelligence stratégique — À incorporer au bot

### Données marché à tenir à jour
- Prix médian unifamiliale Lanaudière: **515 000 $**
- Prix médian Rive-Nord: **570 000 $**
- Taux hypothécaire 5 ans effectif: **~4.44%** (BdC Valet API)
- Prix terrains clé en main: **180-240 $/pi²**
- Délai médian vente Lanaudière: **14 jours**

### Listings actifs typiques
- Rawdon: terrains 50-150k, maisons 300-500k
- Sainte-Julienne: terrains 40-100k, maisons 400-600k
- Chertsey: chalets + terrains lacs
- Saint-Didace: niche, peu de compétition

### Compétiteurs à surveiller
- Autres courtiers Lanaudière → comparer $/pi² sur Centris
- DuProprio → prix demandés vs vendus
- Constructeurs directs → argument "sans commission" vs service complet

---

## 🚀 Prochaines features stratégiques à implémenter

### High priority
- [ ] **Tracker conversions Pipedrive → Stats automatiques** (lead→visite→offre→close)
- [ ] **Alertes proactives** si deal stagnant > X jours (déjà implémenté: prospects_stagnants)
- [ ] **Rapport hebdo auto** envoyé à Shawn chaque lundi matin avec KPIs
- [ ] **Comparateur $/pi² par secteur** (base de données locale mise à jour hebdo)

### Medium priority
- [ ] **Script d'appel personnalisé** selon profil prospect (chaud/tiède/froid)
- [ ] **Génération post réseaux sociaux** automatique (LinkedIn, Facebook)
- [ ] **Mise à jour auto des comparables** dans les emails mailing-masse

### SaaS / Vente
- [ ] **Multi-tenant Pipedrive** (plusieurs courtiers sur même instance)
- [ ] **Onboarding 1h** pour nouveau courtier RE/MAX
- [ ] **Landing page signaturesb.com/pro** avec démo
- [ ] **Pricing $150-300/mois/agent**

---

## 📝 Protocole de session Claude Code

### Début de session
1. Lire `MEMORY.md` (chargé auto)
2. Lire `project_toolkit.md` si problème technique suspecté
3. Lire `LEÇONS.md` si debug complexe
4. Lire ce fichier pour contexte stratégique

### Pendant la session
- Ajouter toute nouvelle tactique qui fonctionne dans "Tactiques qui ont fonctionné"
- Ajouter tout piège technique rencontré dans "Optimisations techniques"
- Tenir `SESSION_LIVE.md` à jour pour reprise après crash

### Fin de session
- Commit tous les changements
- Update ce fichier si changements stratégiques
- Update `CLAUDE.md` si architecture change

---

## 🔄 Système d'amélioration auto

**Le bot track ses propres performances:**
- Chaque tool appelé → metrics
- Chaque erreur → metrics + byStatus
- Chaque email envoyé → compteur
- Chaque lead traité → compteur

**Voir en temps réel:**
- `/metrics` dans Telegram
- `GET /health` pour JSON complet
- `BOT_ACTIVITY.md` dans GitHub (actions récentes)

**Rapport quotidien (à construire):**
- Email Julie 8h avec KPIs jour précédent
- Identifier automatiquement les deals stagnants
- Suggérer actions prioritaires

---

## 💎 Philosophie d'exécution

1. **Vite et propre** — pas de perfectionnisme paralysant, mais pas de dette technique
2. **Mesurer puis optimiser** — jamais d'optimisation sans données
3. **Apprendre en boucle** — chaque bug devient une règle dans LEÇONS.md
4. **Automatiser l'ennui** — tout ce qui se répète devient tool ou cron
5. **Humain pour décisions** — bot prépare, Shawn approuve
6. **Stratégie > tactique** — toujours aligner sur "devenir #1 Lanaudière"

---

**Ce fichier est ton intelligence augmentée.** Consulte, mets à jour, grandit.

*Version 1.0 — 2026-04-22*
