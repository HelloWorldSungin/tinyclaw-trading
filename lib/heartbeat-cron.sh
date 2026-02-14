#!/usr/bin/env bash
# Heartbeat — Per-agent interval heartbeats with script mode support
#
# Features:
# - Per-agent heartbeat_interval (from settings.json)
# - heartbeat_mode: "script" runs agent's heartbeat.sh directly (no Claude spawn)
# - heartbeat_mode: "claude" (default) queues message for Claude processing
# - Reads heartbeat.md from workspace/{agent_id}/heartbeat.md
# - Posts results to Discord via webhook
# - Tracks last heartbeat time per agent in .tinyclaw/heartbeat-state/

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$PROJECT_ROOT/.tinyclaw/settings.json" ]; then
    TINYCLAW_HOME="$PROJECT_ROOT/.tinyclaw"
else
    TINYCLAW_HOME="$HOME/.tinyclaw"
fi
LOG_FILE="$TINYCLAW_HOME/logs/heartbeat.log"
QUEUE_INCOMING="$TINYCLAW_HOME/queue/incoming"
QUEUE_OUTGOING="$TINYCLAW_HOME/queue/outgoing"
SETTINGS_FILE="$TINYCLAW_HOME/settings.json"
STATE_DIR="$TINYCLAW_HOME/heartbeat-state"
WORKSPACE_DIR="$PROJECT_ROOT/workspace"

# Read webhook URL from env
WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"

# Minimum tick interval (check all agents every 60s)
TICK_INTERVAL=60

mkdir -p "$(dirname "$LOG_FILE")" "$QUEUE_INCOMING" "$QUEUE_OUTGOING" "$STATE_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"
}

# Get the last heartbeat timestamp (epoch seconds) for an agent
get_last_heartbeat() {
    local agent_id="$1"
    local state_file="$STATE_DIR/${agent_id}.last"
    if [ -f "$state_file" ]; then
        cat "$state_file"
    else
        echo "0"
    fi
}

# Record current time as last heartbeat for an agent
set_last_heartbeat() {
    local agent_id="$1"
    date +%s > "$STATE_DIR/${agent_id}.last"
}

# Post a message to Discord webhook
post_webhook() {
    local content="$1"
    if [ -n "$WEBHOOK_URL" ]; then
        # Escape for JSON
        local escaped
        escaped=$(echo "$content" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo "\"$content\"")
        curl -sf -X POST "$WEBHOOK_URL" \
            -H "Content-Type: application/json" \
            -d "{\"content\": $escaped}" \
            > /dev/null 2>&1 || log "WARN: Failed to post to webhook"
    fi
}

log "Heartbeat started (tick: ${TICK_INTERVAL}s)"

if [ ! -f "$SETTINGS_FILE" ]; then
    log "ERROR: No settings file at $SETTINGS_FILE"
    exit 1
fi

if ! command -v jq &> /dev/null; then
    log "ERROR: jq is required but not installed"
    exit 1
fi

# Read global default interval
GLOBAL_INTERVAL=$(jq -r '.monitoring.heartbeat_interval // 3600' "$SETTINGS_FILE")
log "Global heartbeat interval: ${GLOBAL_INTERVAL}s"

# List agents with heartbeat configuration
jq -r '(.agents // {}) | to_entries[] | select(.value.heartbeat_interval != null) | .key' "$SETTINGS_FILE" | while read -r AGENT_ID; do
    INTERVAL=$(jq -r ".agents.\"${AGENT_ID}\".heartbeat_interval // ${GLOBAL_INTERVAL}" "$SETTINGS_FILE")
    MODE=$(jq -r ".agents.\"${AGENT_ID}\".heartbeat_mode // \"claude\"" "$SETTINGS_FILE")
    log "  Agent @${AGENT_ID}: interval=${INTERVAL}s, mode=${MODE}"
done

while true; do
    sleep "$TICK_INTERVAL"

    NOW=$(date +%s)

    # Get all agent IDs that have heartbeat_interval set
    AGENT_IDS=$(jq -r '(.agents // {}) | to_entries[] | select(.value.heartbeat_interval != null) | .key' "$SETTINGS_FILE" 2>/dev/null)

    if [ -z "$AGENT_IDS" ]; then
        continue
    fi

    for AGENT_ID in $AGENT_IDS; do
        # Read per-agent interval
        INTERVAL=$(jq -r ".agents.\"${AGENT_ID}\".heartbeat_interval // ${GLOBAL_INTERVAL}" "$SETTINGS_FILE")
        MODE=$(jq -r ".agents.\"${AGENT_ID}\".heartbeat_mode // \"claude\"" "$SETTINGS_FILE")

        # Check if heartbeat is due
        LAST=$(get_last_heartbeat "$AGENT_ID")
        ELAPSED=$((NOW - LAST))

        if [ "$ELAPSED" -lt "$INTERVAL" ]; then
            continue
        fi

        log "Heartbeat due for @${AGENT_ID} (elapsed: ${ELAPSED}s, interval: ${INTERVAL}s, mode: ${MODE})"

        if [ "$MODE" = "script" ]; then
            # Script mode — run heartbeat.sh directly, no Claude spawn
            HEARTBEAT_SCRIPT="$WORKSPACE_DIR/${AGENT_ID}/heartbeat.sh"
            if [ -x "$HEARTBEAT_SCRIPT" ]; then
                log "  Running script: $HEARTBEAT_SCRIPT"
                SCRIPT_OUTPUT=$("$HEARTBEAT_SCRIPT" 2>&1) || true
                log "  Script output: ${SCRIPT_OUTPUT:0:200}"

                # Post script output to webhook
                if [ -n "$SCRIPT_OUTPUT" ]; then
                    post_webhook "$SCRIPT_OUTPUT"
                fi
            else
                log "  WARN: No executable heartbeat.sh at $HEARTBEAT_SCRIPT"
            fi
        else
            # Claude mode — read heartbeat.md and queue for Claude processing
            HEARTBEAT_FILE="$WORKSPACE_DIR/${AGENT_ID}/heartbeat.md"
            if [ -f "$HEARTBEAT_FILE" ]; then
                PROMPT=$(cat "$HEARTBEAT_FILE")
                log "  Using heartbeat.md from workspace/${AGENT_ID}/"
            else
                PROMPT="Quick status check: Any pending tasks? Keep response brief."
                log "  Using default heartbeat prompt"
            fi

            # Generate unique message ID and queue
            MESSAGE_ID="heartbeat_${AGENT_ID}_$(date +%s)_$$"

            cat > "$QUEUE_INCOMING/${MESSAGE_ID}.json" << EOF
{
  "channel": "heartbeat",
  "sender": "System",
  "senderId": "heartbeat_${AGENT_ID}",
  "message": "${PROMPT//\"/\\\"}",
  "timestamp": ${NOW}000,
  "messageId": "$MESSAGE_ID",
  "agent": "${AGENT_ID}",
  "command": "heartbeat"
}
EOF

            log "  ✓ Queued heartbeat for @${AGENT_ID}: $MESSAGE_ID"

            # Wait briefly then check for response
            sleep 5

            for RESPONSE_FILE in "$QUEUE_OUTGOING"/${MESSAGE_ID}*.json; do
                if [ -f "$RESPONSE_FILE" ]; then
                    RESPONSE=$(jq -r '.message' "$RESPONSE_FILE" 2>/dev/null || echo "")
                    if [ -n "$RESPONSE" ]; then
                        log "  ← @${AGENT_ID}: ${RESPONSE:0:120}..."
                        post_webhook "**@${AGENT_ID} heartbeat:**\n${RESPONSE:0:1800}"
                        rm -f "$RESPONSE_FILE"
                    fi
                fi
            done
        fi

        set_last_heartbeat "$AGENT_ID"
    done
done
