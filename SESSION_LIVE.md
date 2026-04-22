# SESSION LIVE — 2026-04-21 23:26

## 🚨 BUG CRITIQUE TROUVÉ

**Render deploy failed 5× de suite** — cause identifiée via run local:

```
[POLL] #1-10: ETELEGRAM: 404 Not Found
[POLL] Restart forcé... → process.exit(1)
```

**Root cause:** Code ligne ~2986 de bot.js:
```javascript
if (pollingErrors >= 10) { log('WARN', 'POLL', 'Restart forcé...'); process.exit(1); }
```

Quand Render déploie: 2 instances (vieille + nouvelle) partagent TELEGRAM_BOT_TOKEN.
Telegram ne permet qu'une instance à polling → 404 sur la plus récente.
Après 10 erreurs → `process.exit(1)` → Render marque deploy failed.

**Fix à appliquer:**
- RETIRER le `process.exit(1)` sur polling errors
- Backoff exponentiel au lieu de crash
- Reset `pollingErrors` sur premier succès

## 🐛 BUG #2: Comparables Centris

Shawn voit dans la preview HTML des numéros Centris fictifs. Le scraping Centris actuel peut retourner peu/pas de vrais résultats car:
- Centris.ca utilise React/SSR
- Les données viennent d'appels API internes
- Le scraping HTML direct capture peu d'info

**Solution à implémenter:** reverse-engineer l'API Centris interne (utilisée par leur JS) ou utiliser Matrix Centris (système agent).

## 📊 État des deploys

| Commit | Deploy | Status |
|---|---|---|
| c5241958 | dep-d7k3nfbrjlhs73botbo0 | failed (polling crash) |
| 776e3f39 | dep-d7k3d0f41pts73en8tpg | failed |
| a8348e57 | dep-d7k3amn41pts73en869g | failed |
| ec30aacb | dep-d7k31vaqqhas73cg65rg | failed |
| c209c9ea | dep-d7k2qpf41pts73en2ba0 | failed |
| 2b815d27 | dep-d7k2m4cm0tmc73aa9gtg | **LIVE** (ancien, 28 tools) |

Actuellement en production: `2b815d27` (ancien code, 28 tools).
Les 5 derniers commits contiennent toutes les features mais ne sont pas déployés.

## ⚡ PLAN IMMÉDIAT

1. Fix `pollingErrors → process.exit(1)` → backoff doux
2. Commit + push → Render va enfin pouvoir déployer
3. Vérifier /health ensuite
4. Puis aborder le Centris scraping amélioré

## 🗂️ Commits à venir

- Fix polling crash (priorité 1)
- Amélioration scraping Centris (priorité 2)
- Plus de mémoire automatique

## 🔐 Tout est mémorisé

Fichiers persistants garantis:
- Git: tous les commits (sur les 2 remotes: kira-bot + bot-assistant)
- SESSION_LIVE.md (ce fichier, dans le repo)
- CLAUDE.md (dans le repo)
- ÉTAT_SYSTÈME.md (dans le repo)
- Mémoires Claude Code: `project_session_live.md`, etc.
- BOT_STATUS.md (bot l'écrit chaque heure — quand il tournera)

**Pour reprendre après crash:** ouvrir un nouveau Claude Code, lire ce fichier, continuer.
