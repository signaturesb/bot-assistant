# SECURITY — Bot Signature SB

Architecture de protection + playbook rotation. **Ce fichier remplace les credentials en clair** dans les anciens docs.

**Historique git nettoyé:** toutes les occurrences de secrets compromis ont été retirées de l'historique des 2 repos via `git filter-repo` (commit `71decda+`). Les secrets restent néanmoins à révoquer sur les services car leur contenu est peut-être déjà archivé hors-site.

---

## 🛡️ Défense en profondeur — 9 couches automatiques

| # | Couche | Fichier | Quand ça tourne | Ce que ça protège |
|---|---|---|---|---|
| 1 | **Pre-commit local** | `.githooks/pre-commit` → `validate.js` | À chaque `git commit` | Secrets staged, syntaxe bot.js, tool names Opus 4.7 |
| 2 | **Gitleaks CI** | `.github/workflows/security.yml` | Push + PR + lundi 9h | Fuites dans tout l'historique |
| 3 | **npm audit CI** | `.github/workflows/security.yml` | Push + PR | Vulnérabilités high/critical dans deps |
| 4 | **GitHub Push Protection** | `scripts/enable-github-security.js` | Côté serveur GitHub | Push de secrets reconnus |
| 5 | **CodeQL SAST** | `.github/workflows/codeql.yml` | Push + PR + lundi 6h | Failles sécurité dans le code JS (injection, XSS, etc.) |
| 6 | **Dependency Review** | `.github/workflows/dependency-review.yml` | Chaque PR | Deps introduites par PR avec CVE ≥ moderate |
| 7 | **OSSF Scorecard** | `.github/workflows/scorecard.yml` | Lundi 8h | Benchmark global best practices sécurité |
| 8 | **Dependabot** | `.github/dependabot.yml` + script | Continu + lundi 9h | Auto-PR patchs CVE, groupé minor/patch |
| 9 | **Private Vuln Reporting** | activé via script | Continu | Canal sécurisé pour signalements externes |

**Zero config à maintenir** — tout tourne tout seul.

---

## 🔄 Rotation d'un secret — procédure standard (5 min)

1. **Révoquer l'ancien** sur le service (URLs ci-dessous)
2. **Générer le nouveau** sur le service
3. **Mettre à jour `.env`** local avec la nouvelle valeur
4. **`node scripts/sync-env-render.js`** → pousse vers Render env vars → redéploie le bot auto
5. Vérifier `/health` → tous les `subsystems: true`

Le script est idempotent: si tu changes juste 1 valeur dans `.env`, il fait un diff et ne touche que ce qui a changé. Use `--dry-run` pour voir avant.

---

## 🔑 URLs de rotation par service

| Service | URL révocation/rotation | Env var |
|---|---|---|
| GitHub token | https://github.com/settings/tokens | `GITHUB_TOKEN` |
| Render API | https://dashboard.render.com/u/settings/api-keys | `RENDER_API_KEY` |
| Pipedrive API | `https://app.pipedrive.com/settings/personal/api` | `PIPEDRIVE_API_KEY` |
| Brevo API | https://app.brevo.com/settings/keys/api | `BREVO_API_KEY` |
| Anthropic API | https://console.anthropic.com/settings/keys | `ANTHROPIC_API_KEY` |
| OpenAI API | https://platform.openai.com/api-keys | `OPENAI_API_KEY` |
| Telegram bot | `@BotFather` → `/revoke` puis `/token` | `TELEGRAM_BOT_TOKEN` |
| Gmail OAuth | https://console.cloud.google.com/apis/credentials | `GMAIL_CLIENT_*` |
| Dropbox OAuth | https://www.dropbox.com/developers/apps | `DROPBOX_APP_*` |
| Centris | zone courtier → paramètres compte | `CENTRIS_USER` + `CENTRIS_PASS` |
| SIRF | sirf.registrefoncier.gouv.qc.ca → compte | `SIRF_USER` + `SIRF_PASS` |

---

## 🚨 Checklist incident (secret exposé)

1. **Révoquer immédiatement** sur le service
2. Regénérer
3. Update `.env` + `node scripts/sync-env-render.js`
4. `/health` bot → confirme subsystems OK
5. Si secret était en clair dans un commit → GitHub va déjà avoir bloqué les push subséquents (couche 3). Pour débloquer un repo bloqué: `https://github.com/signaturesb/<repo>/security/secret-scanning` → allowlist le secret révoqué
6. (Optionnel) Réécrire l'historique avec `git filter-repo` si le secret reste très sensible — voir section ci-dessous

---

## 🧹 Nettoyer l'historique d'un secret (radical, rare)

À faire **seulement** si un secret critique (ex. clé signée, cert) a été commité ET ne peut pas être simplement révoqué.

```bash
# 1. Installer git-filter-repo
brew install git-filter-repo

# 2. Depuis une copie fraîche du repo, retirer les occurrences
git filter-repo --replace-text <(echo 'SECRET_VALUE==>REDACTED')

# 3. Force-push vers TOUS les remotes — tous les clones distants deviennent invalides
git push --force --all origin
git push --force --all bot-assistant
```

**Coûts:** tous les clones existants (y compris Render build cache) sont cassés → redéployer à la main. Éviter sauf nécessité absolue.

---

## 📐 Architecture multi-repo

```
local (Mac Shawn)
  │
  ├─ push ──► origin = kira-bot (dev, peut être resynché)
  └─ push ──► bot-assistant (prod — Render fetch → deploy auto)

Règles:
  - bot-assistant/main = vérité prod. Fast-forward only. JAMAIS force-push.
  - origin/main (kira-bot) = dev + logs auto du bot Telegram. Peut être force-push après Shawn valide.
  - Le bot Telegram écrit sur origin (BOT_STATUS.md, BOT_ACTIVITY.md, etc.).
```

---

## ⚙️ Setup initial (à faire 1 fois)

```bash
# 1. Hooks Git activés localement
git config core.hooksPath .githooks

# 2. Installer dépendances
npm install

# 3. Créer .env depuis template
cp .env.example .env
# → remplir les valeurs

# 4. Activer sécurité côté GitHub (nécessite GITHUB_TOKEN scope repo + admin:repo_hook)
npm run enable-security

# 5. Synchroniser Render
npm run sync-env:dry     # vérifier le diff
npm run sync-env         # push pour de vrai
```

Après ça: plus jamais de manipulation manuelle récurrente. Les 9 couches tournent seules.

---

## 📜 npm scripts disponibles

| Commande | Action |
|---|---|
| `npm start` | Démarre le bot (prod = Render) |
| `npm run validate` | Syntax + 6 checks (secrets, tools, params Opus 4.7, etc.) |
| `npm run diagnose` | Diagnostic système complet (Bot, Render, GitHub, etc.) |
| `npm run fix` | Auto-réparation problèmes courants |
| `npm run sync-env` | Push `.env` local → Render env vars (redéploie auto) |
| `npm run sync-env:dry` | Preview du diff sans modifier |
| `npm run enable-security` | One-shot: active les couches GitHub (2, 3, 4, 5, 6, 7, 8, 9) |
| `npm run test-parser` | Valide que `parseLeadEmail()` extrait correctement (8 tests) |
| `bash scripts/audit-history.sh` | Scan profond historique git (gitleaks via Docker) |

---

## 📋 Ce qui est 100% automatique vs manuel

**Automatique (zéro intervention):**
- Détection fuite avant commit (pre-commit hook)
- Scan hebdomadaire historique (GitHub Actions lundi 9h)
- Bloquage push de secrets (GitHub Push Protection)
- PRs auto pour CVE dépendances (Dependabot)
- Alerts email GitHub si vulnérabilité détectée
- Render redéploie auto à chaque push sur bot-assistant/main

**Manuel (one-shot, 30 secondes chacun):**
- Révoquer + regénérer une clé compromise (pas automatisable — les UIs des services l'imposent)
- Copier la nouvelle valeur dans `.env` local
- Rouler `node scripts/sync-env-render.js` (1 commande, pousse tout)

**Manuel (one-shot à vie):**
- Activer sécurité GitHub: `node scripts/enable-github-security.js` avec un token frais
- `git config core.hooksPath .githooks` sur chaque nouvelle machine
