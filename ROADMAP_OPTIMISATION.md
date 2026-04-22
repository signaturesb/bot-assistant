# 🚀 ROADMAP OPTIMISATION COMPLÈTE — Kira Bot

**Date:** 2026-04-22
**Objectif:** Transformer Kira en assistant 10× plus puissant, proactif et auto-réparant.

---

## 📊 ÉTAT ACTUEL

- Bot: commit `2b815d27` en prod (28/39 outils)
- 5 derniers commits bloqués (polling crash)
- Aucune proactivité matinale
- Aucune auto-réparation tokens
- Aucun rapport hebdomadaire

---

## 🎯 PHASE 1 — DÉBLOQUER + STABILISER (Jour 1)

### 1.1 Fix polling crash
- Retirer `process.exit(1)` sur pollingErrors ≥ 10
- Backoff exponentiel: 1s → 2s → 4s → 8s → 16s → max 60s
- Reset compteur sur premier succès
- **Fichier:** `bot.js` ligne ~2986

### 1.2 Health check robuste
- Endpoint `/health` retourne JSON détaillé (uptime, tools_count, état chaque service)
- Monitoring externe (UptimeRobot gratuit) toutes les 5 min
- Si down → email + SMS à Shawn

### 1.3 CRASH_REPORT intelligent
- Try/catch global → log crash dans `CRASH_REPORT.md` GitHub
- Au boot: détecte si dernier arrêt = crash → notifie Telegram avec cause

---

## 🧠 PHASE 2 — INTELLIGENCE PROACTIVE (Jour 2-3)

### 2.1 Réveil matinal automatique (7h30)
**Cron:** `30 7 * * *`

Contenu:
- Visites du jour
- Prospects stagnants >3j
- Emails de la nuit
- 1 action prioritaire recommandée

### 2.2 Alerte leads chauds temps réel
Gmail Poller améliore:
- Détecter keywords: "visite", "acheter", "budget", "urgent"
- Scraping auto email+tel+propriété de la demande
- Brouillon J+0 pré-rédigé
- Notif Telegram immédiate

### 2.3 Détection deal qui refroidit
Cron toutes les 6h, scan Pipedrive:
- "En discussion" >7j sans activité
- "Visite faite" >2j sans suivi
- "Offre déposée" >5j sans réponse

### 2.4 Anti-doublons renforcé
Avant tout `creer_deal`:
1. Vérif email exact
2. Vérif téléphone normalisé
3. Fuzzy match nom
4. Si aucune info → Shawn appelle

Règle prompt: jamais de deal sans email OU tel.

---

## 🛡️ PHASE 3 — AUTO-RÉPARATION (Jour 4)

### 3.1 Token refresh auto (cron 6h)
- Gmail, Dropbox refresh automatique
- Alerte Telegram si échec avec lien réauth

### 3.2 Retry intelligent
- Timeout 10s sur tout appel externe
- 3 retries backoff exponentiel
- Fallback gracieux (pas de crash)

### 3.3 Circuit breaker
- Service échoue 5× en 10 min → désactivé 30 min
- Évite boucles de crash

---

## 📊 PHASE 4 — INTELLIGENCE BUSINESS (Semaine 2)

### 4.1 Rapport hebdo dimanche 18h
**Cron:** `0 18 * * 0`

Contenu:
- Deals gagnés/perdus/créés
- Sources leads + taux conversion
- Bottleneck identifié
- Recommandations semaine

### 4.2 Enrichissement auto leads
Lead incomplet → recherche auto:
- Contacts iPhone (Dropbox vcf)
- Registre foncier QC
- Pages Jaunes / LinkedIn

### 4.3 Scoring prospect (0-100)
Basé sur:
- Source (référence=+40, Centris=+25, Facebook=+15)
- Rapidité réponse (<1h = chaud +20)
- Mots-clés budget+délai (+15)
- Visite planifiée (+50)

### 4.4 Prédiction closing (dès 3 mois data)
Profil deals gagnés → alerte si prospect s'écarte.

---

## 🔧 PHASE 5 — QUALITÉ DE VIE (Semaine 3)

- `/stats` enrichi (pipeline visuel, valeur par étape)
- `/agenda` (semaine complète)
- Mode vacances (réponses auto + pas de ping)
- Export mensuel compta

---

## 🎨 PHASE 6 — PEAUFINAGE (Continu)

- Logs JSON structurés
- `/metrics` endpoint
- Tests automatiques

---

## 📋 CHECKLIST EXÉCUTION

**Jour 1 (aujourd'hui):**
- [ ] Fix polling crash + push
- [ ] /health détaillé
- [ ] CRASH_REPORT auto

**Jour 2:**
- [ ] Cron réveil matinal 7h30
- [ ] Anti-doublons renforcé
- [ ] Alerte leads chauds temps réel

**Jour 3:**
- [ ] Détection deals refroidissants
- [ ] Token refresh auto 6h

**Jour 4:**
- [ ] Retry + circuit breaker
- [ ] UptimeRobot configuré

**Semaine 2:**
- [ ] Rapport hebdo dimanche
- [ ] Enrichissement auto leads
- [ ] Scoring prospect

**Semaine 3:**
- [ ] Commandes /stats /agenda
- [ ] Mode vacances
- [ ] Export compta

---

## 🔐 VARIABLES D'ENV À AJOUTER

```
CRON_MORNING_TIME=07:30
UPTIME_ROBOT_KEY=xxx
SMS_TWILIO_SID=xxx
SMS_TWILIO_TOKEN=xxx
SHAWN_PHONE=+15149271340
```

---

## 📞 IMPLÉMENTATION

Via Claude Code sur Mac de Shawn.
Chaque phase = 1 commit distinct.
Tests avant déploiement Render.
