#!/bin/bash
# install-sms-bridge.sh — installe le pont iMessage Mac → Bot Render
# Usage: bash scripts/install-sms-bridge.sh
set -e

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST_NAME="com.signaturesb.sms-bridge.plist"
PLIST_TARGET="$LAUNCH_AGENTS/$PLIST_NAME"
SMS_BRIDGE_JS="$REPO_DIR/scripts/sms-bridge.js"

echo "═══ Installation SMS Bridge — Centris MFA auto ═══"
echo ""

# 1. Vérifier Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js manquant. Install: brew install node"
  exit 1
fi
NODE_PATH=$(which node)
echo "✅ Node.js trouvé: $NODE_PATH ($(node --version))"

# 2. Vérifier sqlite3 (built-in macOS)
if ! command -v sqlite3 &> /dev/null; then
  echo "❌ sqlite3 manquant (devrait être pré-installé sur macOS)"
  exit 1
fi
echo "✅ sqlite3 OK"

# 3. Vérifier accès chat.db
CHAT_DB="$HOME/Library/Messages/chat.db"
if [ ! -f "$CHAT_DB" ]; then
  echo "❌ chat.db introuvable. SMS Forwarding iPhone→Mac est-il activé?"
  echo "   → iPhone: Settings → Messages → Text Message Forwarding → ✓ ce Mac"
  exit 1
fi

# Test lecture (Full Disk Access requis)
if sqlite3 -readonly "$CHAT_DB" "SELECT COUNT(*) FROM message LIMIT 1;" &> /dev/null; then
  echo "✅ chat.db lisible"
else
  echo "⚠️  chat.db existe mais lecture refusée — Full Disk Access manquant"
  echo ""
  echo "   ACTION REQUISE:"
  echo "   1. Ouvre System Settings → Privacy & Security → Full Disk Access"
  echo "   2. Cliques + et ajoute:"
  echo "      - $NODE_PATH"
  echo "      - /usr/bin/sqlite3 (si pas déjà)"
  echo "      - Terminal.app (ou ton terminal préféré)"
  echo "   3. Re-run ce script"
  exit 2
fi

# 4. Créer logs dir
LOGS_DIR="$REPO_DIR/logs"
mkdir -p "$LOGS_DIR"
echo "✅ Logs dir: $LOGS_DIR"

# 5. Demander le secret HMAC
if [ -z "$SMS_BRIDGE_SECRET" ]; then
  if [ -f "$HOME/.claude-bot-secrets.env" ] && grep -q "SMS_BRIDGE_SECRET" "$HOME/.claude-bot-secrets.env"; then
    SMS_BRIDGE_SECRET=$(grep "SMS_BRIDGE_SECRET" "$HOME/.claude-bot-secrets.env" | cut -d'"' -f2)
  fi
fi
if [ -z "$SMS_BRIDGE_SECRET" ] || [ "$SMS_BRIDGE_SECRET" = "REPLACE_ME_WITH_SHARED_SECRET" ]; then
  # Génère un secret sécurisé
  GENERATED=$(openssl rand -hex 32)
  echo ""
  echo "🔑 Génération d'un nouveau secret HMAC:"
  echo "   $GENERATED"
  echo ""
  echo "   IMPORTANT — copie-le dans Render env vars:"
  echo "   SMS_BRIDGE_SECRET=$GENERATED"
  echo ""
  echo "   Et dans ~/.claude-bot-secrets.env:"
  echo "   export SMS_BRIDGE_SECRET=\"$GENERATED\""
  echo ""
  read -p "Une fois ajouté dans Render ET ~/.claude-bot-secrets.env, appuie ENTER pour continuer..."
  SMS_BRIDGE_SECRET="$GENERATED"
fi

# 6. Patcher le plist avec le secret + paths corrects
TMP_PLIST=$(mktemp)
sed "s|/usr/local/bin/node|$NODE_PATH|g" "$REPO_DIR/scripts/com.signaturesb.sms-bridge.plist" > "$TMP_PLIST"

# Ajouter le secret dans EnvironmentVariables (insertion avant </dict> du dict EnvironmentVariables)
python3 -c "
import plistlib, sys
with open('$TMP_PLIST', 'rb') as f:
    plist = plistlib.load(f)
plist['EnvironmentVariables']['SMS_BRIDGE_SECRET'] = '$SMS_BRIDGE_SECRET'
with open('$TMP_PLIST', 'wb') as f:
    plistlib.dump(plist, f)
"

# 7. Unload version précédente si existante
if launchctl list | grep -q com.signaturesb.sms-bridge; then
  echo "♻️  Unload version précédente..."
  launchctl unload "$PLIST_TARGET" 2>/dev/null || true
fi

# 8. Install nouveau plist
mkdir -p "$LAUNCH_AGENTS"
cp "$TMP_PLIST" "$PLIST_TARGET"
chmod 644 "$PLIST_TARGET"
rm "$TMP_PLIST"
echo "✅ Plist installé: $PLIST_TARGET"

# 9. Load le LaunchAgent
launchctl load "$PLIST_TARGET"
sleep 2

# 10. Vérifier qu'il tourne
if launchctl list | grep -q com.signaturesb.sms-bridge; then
  PID=$(launchctl list | grep com.signaturesb.sms-bridge | awk '{print $1}')
  if [ "$PID" != "-" ] && [ -n "$PID" ]; then
    echo "✅ SMS Bridge ACTIF (PID $PID)"
  else
    echo "⚠️  Plist chargé mais process pas démarré — check $LOGS_DIR/sms-bridge.stderr.log"
  fi
else
  echo "❌ LaunchAgent pas chargé"
  exit 3
fi

# 11. Affiche tail logs
echo ""
echo "═══ Logs (5 dernières secondes) ═══"
sleep 5
tail -20 "$LOGS_DIR/sms-bridge.log" 2>/dev/null || echo "(pas encore de logs)"
echo ""
echo "═══ INSTALLATION TERMINÉE ═══"
echo ""
echo "Prochaines étapes:"
echo "1. Vérifie que SMS_BRIDGE_SECRET est dans Render env vars"
echo "2. Quand tu fais /login_centris dans Telegram, le bot t'enverra le challenge"
echo "3. Le SMS Centris arrive sur ton iPhone + Mac (forwarding)"
echo "4. Le bridge le capte et forward au bot automatiquement"
echo "5. Bot complète le login en ~30 sec"
echo ""
echo "Logs en temps réel: tail -f $LOGS_DIR/sms-bridge.log"
echo "Désinstaller: launchctl unload $PLIST_TARGET && rm $PLIST_TARGET"
