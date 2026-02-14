#!/usr/bin/env bash
# Deploy TinyClaw Trading to CT100
#
# Prerequisites:
#   - SSH access: ssh root@192.168.68.10 "pct exec 100 -- ..."
#   - Bun installed at /home/strategist/.bun/bin/bun
#   - Claude CLI at /home/strategist/.local/bin/claude
#   - .env configured at the working directory
#
# Usage:
#   bash daemon/deploy.sh
#
# This script:
#   1. Pushes code to origin
#   2. Pulls on CT100 via SSH
#   3. Installs dependencies
#   4. Stops old claude-strategist service (if running)
#   5. Installs and starts tinyclaw services
#   6. Verifies health

set -euo pipefail

SSH_CMD='ssh root@192.168.68.10 "pct exec 100 --'
REMOTE_DIR="/opt/ArkNode-AI/projects/trading-signal-ai/tinyclaw-trading"
SERVICE_USER="strategist"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

log "Step 1: Pull latest code on CT100"
ssh root@192.168.68.10 "pct exec 100 -- bash -c 'cd ${REMOTE_DIR} && su -s /bin/bash ${SERVICE_USER} -c \"git pull\"'"

log "Step 2: Install dependencies"
ssh root@192.168.68.10 "pct exec 100 -- bash -c 'cd ${REMOTE_DIR} && su -s /bin/bash ${SERVICE_USER} -c \"/home/${SERVICE_USER}/.bun/bin/bun install\"'"

log "Step 3: Stop old strategist service (if exists)"
ssh root@192.168.68.10 "pct exec 100 -- bash -c 'systemctl stop claude-strategist 2>/dev/null || true'"
ssh root@192.168.68.10 "pct exec 100 -- bash -c 'systemctl disable claude-strategist 2>/dev/null || true'"

log "Step 4: Install systemd services"
for svc in tinyclaw-trading tinyclaw-discord tinyclaw-heartbeat; do
    ssh root@192.168.68.10 "pct exec 100 -- bash -c 'cp ${REMOTE_DIR}/daemon/${svc}.service /etc/systemd/system/${svc}.service'"
done
ssh root@192.168.68.10 "pct exec 100 -- bash -c 'systemctl daemon-reload'"

log "Step 5: Enable and start services"
for svc in tinyclaw-trading tinyclaw-discord tinyclaw-heartbeat; do
    ssh root@192.168.68.10 "pct exec 100 -- bash -c 'systemctl enable ${svc} && systemctl start ${svc}'"
done

log "Step 6: Verify services"
sleep 3
for svc in tinyclaw-trading tinyclaw-discord tinyclaw-heartbeat; do
    STATUS=$(ssh root@192.168.68.10 "pct exec 100 -- bash -c 'systemctl is-active ${svc} 2>/dev/null'" || echo "inactive")
    if [ "$STATUS" = "active" ]; then
        log "  $svc: ACTIVE"
    else
        log "  $svc: FAILED ($STATUS)"
        log "  Check logs: ssh root@192.168.68.10 \"pct exec 100 -- journalctl -u ${svc} -n 20\""
    fi
done

log "Deployment complete!"
echo ""
echo "Monitor logs:"
echo "  ssh root@192.168.68.10 \"pct exec 100 -- journalctl -fu tinyclaw-trading\""
echo "  ssh root@192.168.68.10 \"pct exec 100 -- journalctl -fu tinyclaw-discord\""
echo "  ssh root@192.168.68.10 \"pct exec 100 -- journalctl -fu tinyclaw-heartbeat\""
