#!/bin/bash
# configure-render-env.sh — ajoute auto les env vars Centris + SMS_BRIDGE_SECRET à Render
# Usage: bash scripts/configure-render-env.sh
# Tu dois fournir ta RENDER_API_KEY (récupère sur dashboard.render.com → Account Settings → API Keys)
set -e

SECRETS_FILE="$HOME/.claude-bot-secrets.env"
SERVICE_ID="srv-d7fh9777f7vs73a15ddg"

# Source secrets si existe
[ -f "$SECRETS_FILE" ] && source "$SECRETS_FILE"

echo "═══ Configuration Render env vars (one-time setup) ═══"
echo ""

# 1. Vérifier RENDER_API_KEY
if [ -z "$RENDER_API_KEY" ] || [ "$RENDER_API_KEY" = "REPLACE_ME_WITH_RENDER_API_KEY" ]; then
  echo "🔑 RENDER_API_KEY manquante."
  echo ""
  echo "Pour la créer (1 min):"
  echo "1. dashboard.render.com → click ton avatar (haut-droit)"
  echo "2. Account Settings → API Keys"
  echo "3. Create API Key → nom: 'claude-code' → Create"
  echo "4. Copie la clé qui s'affiche (commence par 'rnd_')"
  echo ""
  read -r -s -p "Colle ta RENDER_API_KEY ici (rien ne s'affichera): " RENDER_API_KEY
  echo ""
  if [ -z "$RENDER_API_KEY" ]; then echo "❌ Pas de clé fournie"; exit 1; fi

  # Save dans secrets file
  if grep -q "^export RENDER_API_KEY=" "$SECRETS_FILE" 2>/dev/null; then
    sed -i '' "s|^export RENDER_API_KEY=.*|export RENDER_API_KEY=\"$RENDER_API_KEY\"|" "$SECRETS_FILE"
  else
    echo "export RENDER_API_KEY=\"$RENDER_API_KEY\"" >> "$SECRETS_FILE"
  fi
  echo "✅ RENDER_API_KEY saved dans $SECRETS_FILE"
fi

# 2. Vérifier SMS_BRIDGE_SECRET
if [ -z "$SMS_BRIDGE_SECRET" ]; then
  echo "❌ SMS_BRIDGE_SECRET pas trouvé dans secrets file"
  exit 1
fi

# 3. Test API access
echo ""
echo "🔍 Test accès Render API..."
TEST=$(curl -s -H "Authorization: Bearer $RENDER_API_KEY" "https://api.render.com/v1/services/$SERVICE_ID")
if echo "$TEST" | grep -q '"id"'; then
  SERVICE_NAME=$(echo "$TEST" | python3 -c "import sys, json; print(json.load(sys.stdin).get('service', json.load(sys.stdin) if isinstance(json.load(sys.stdin), dict) else {}).get('name', '?'))" 2>/dev/null || echo "$TEST" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "✅ Connected to service: $SERVICE_NAME"
else
  echo "❌ API access échoué. Réponse: $(echo "$TEST" | head -c 200)"
  exit 1
fi

# 4. Ajout des env vars
echo ""
echo "📝 Ajout des 3 env vars à Render..."

add_env_var() {
  local key="$1"
  local value="$2"
  echo "  → $key..."
  RESPONSE=$(curl -s -X PUT \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"value\": \"$value\"}" \
    "https://api.render.com/v1/services/$SERVICE_ID/env-vars/$key")
  if echo "$RESPONSE" | grep -q "\"key\":\"$key\""; then
    echo "    ✅ $key configuré"
  else
    echo "    ⚠️ Réponse: $(echo $RESPONSE | head -c 150)"
  fi
}

# Lit les credentials depuis env vars ou stdin (jamais hardcoded dans le script)
if [ -z "$CENTRIS_USER" ]; then
  read -r -p "CENTRIS_USER (code courtier): " CENTRIS_USER
fi
if [ -z "$CENTRIS_PASS" ]; then
  read -r -s -p "CENTRIS_PASS (mot de passe Centris): " CENTRIS_PASS
  echo
fi

add_env_var "CENTRIS_USER" "$CENTRIS_USER"
add_env_var "CENTRIS_PASS" "$CENTRIS_PASS"
add_env_var "SMS_BRIDGE_SECRET" "$SMS_BRIDGE_SECRET"

echo ""
echo "🚀 Déclenchement redeploy..."
curl -s -X POST \
  -H "Authorization: Bearer $RENDER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"clearCache": "do_not_clear"}' \
  "https://api.render.com/v1/services/$SERVICE_ID/deploys" | head -c 200
echo ""
echo ""
echo "═══ TERMINÉ ═══"
echo ""
echo "Render redéploie maintenant (~90s). Quand fini:"
echo "1. Tape /login_centris dans Telegram"
echo "2. SMS arrive sur ton iPhone → bridge → bot → login complet"
echo "3. Puis /fiche <#> <email> marche pour n'importe quel listing"
