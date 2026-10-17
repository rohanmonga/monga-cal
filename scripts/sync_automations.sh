#!/usr/bin/env bash
set -e

# Sync automations.yaml to Home Assistant on Raspberry Pi and reload automations
HA_HOST="${HA_HOST:-192.168.86.32}"
HA_USER="${HA_USER:-rohan}"
HA_PORT="${HA_PORT:-8123}"
WEBHOOK_ID="reload_monga_automations"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOCAL_AUTOMATIONS="$SCRIPT_DIR/automations.yaml"

if [ ! -f "$LOCAL_AUTOMATIONS" ]; then
    echo "❌ Local file not found: $LOCAL_AUTOMATIONS"
    exit 1
fi

echo "=================================================="
echo "🚀 Deploying automations.yaml to $HA_USER@$HA_HOST"
echo "=================================================="

# 1. Copy to Home Assistant config directory
echo "📤 Uploading to /home/$HA_USER/homeassistant/automations.yaml..."
scp "$LOCAL_AUTOMATIONS" "$HA_USER@$HA_HOST:/home/$HA_USER/homeassistant/automations.yaml"

# 2. Also keep /home/rohan/monga-cal/scripts/automations.yaml in sync
ssh "$HA_USER@$HA_HOST" "cp /home/$HA_USER/homeassistant/automations.yaml /home/$HA_USER/monga-cal/scripts/automations.yaml 2>/dev/null || true"

# 3. Validate Home Assistant configuration
echo "🔍 Validating Home Assistant config..."
ssh "$HA_USER@$HA_HOST" "docker exec homeassistant hass --script check_config -c /config"

# 4. Trigger reload via webhook (zero downtime, no restart)
RELOAD_RESP=$(curl -s -o /dev/null -w "%{http_code}" -X POST "http://$HA_HOST:$HA_PORT/api/webhook/$WEBHOOK_ID" || echo "000")

if [ "$RELOAD_RESP" = "200" ]; then
    echo "✅ Automations successfully reloaded via webhook!"
else
    echo "⚠️ Webhook returned HTTP $RELOAD_RESP (first time setup). Restarting Home Assistant container to load new webhook..."
    ssh "$HA_USER@$HA_HOST" "docker restart homeassistant"
    echo "⏳ Waiting for Home Assistant to start..."
    sleep 5
fi

# 5. Display active tablet automation states
echo ""
echo "📊 Current Tablet Automation States in Home Assistant:"
ssh "$HA_USER@$HA_HOST" 'psql "postgresql://pi:4475a9dc291aa4ec27@127.0.0.1:5432/homeassistant" -t -A -F " | " -c "
SELECT sm.entity_id, s.state
FROM states_meta sm
JOIN states s ON sm.metadata_id = s.metadata_id
WHERE sm.entity_id LIKE '\''automation.tablet_%'\''
AND s.state_id IN (SELECT MAX(s2.state_id) FROM states s2 WHERE s2.metadata_id = sm.metadata_id)
ORDER BY sm.entity_id;
" | awk -F" \\| " '\''{printf "  • %-48s [%s]\n", $1, $2}'\'''

echo "=================================================="
echo "🎉 Deployment complete!"
echo "=================================================="
