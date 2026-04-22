#!/bin/bash
# ─── scripts/audit-history.sh ───────────────────────────────────────────────
# Scan complet de l'historique git pour secrets résiduels.
# Usage: bash scripts/audit-history.sh
#
# Utilise gitleaks via Docker (zéro install) pour un scan indépendant de
# validate.js. À rouler après filter-repo ou avant un push sensible.

set -e
cd "$(git rev-parse --show-toplevel)"

echo "🔍 Scan historique git avec gitleaks (via Docker)..."
if ! command -v docker >/dev/null; then
  echo "⚠️ Docker absent — fallback: grep maison"
  PATTERNS='gho_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|rnd_[A-Za-z0-9]{25,}|sk-ant-api[0-9]{2}-[A-Za-z0-9_-]{20,}|xkeysib-[a-f0-9]{20,}|AKIA[0-9A-Z]{16}'
  if git log --all -p | grep -E "$PATTERNS" --color=always | head -20; then
    echo "❌ Secrets potentiels trouvés dans l'historique — voir output ci-dessus"
    exit 1
  else
    echo "✅ Aucun secret détecté dans l'historique (grep maison)"
    exit 0
  fi
fi

docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:latest \
  detect --source=/repo --no-banner --exit-code 1 \
  && echo "✅ Gitleaks: aucun secret détecté dans l'historique" \
  || { echo "❌ Gitleaks a détecté des secrets — résoudre avant push"; exit 1; }
