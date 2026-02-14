#!/usr/bin/env bash
# Watchdog heartbeat — health checks without Claude spawn
set -euo pipefail

WEBHOOK_URL="${DISCORD_WEBHOOK_URL:-}"
RESULTS=""
FAILURES=0

check_service() {
    local name="$1" url="$2"
    if curl -sf --max-time 5 "$url" > /dev/null 2>&1; then
        RESULTS="$RESULTS\n✅ $name: OK"
    else
        RESULTS="$RESULTS\n❌ $name: DOWN"
        FAILURES=$((FAILURES + 1))
    fi
}

# Check services
check_service "Inference API" "http://localhost:8811/health"
check_service "OHLCV Service" "http://localhost:8812/health"
check_service "Monitor" "http://localhost:8766/health"
check_service "HL Account API" "http://localhost:8769/health"

# Check DB
if pg_isready -h 192.168.68.120 -p 5433 -q 2>/dev/null; then
    RESULTS="$RESULTS\n✅ PostgreSQL: OK"
else
    RESULTS="$RESULTS\n❌ PostgreSQL: DOWN"
    FAILURES=$((FAILURES + 1))
fi

# Check regime freshness from DB (warn if older than 4 hours)
REGIME_AGE=$(PGPASSWORD=trading_app_2026 psql -h 192.168.68.120 -p 5433 -U trading_app -d trading -t -A -c \
  "SELECT EXTRACT(EPOCH FROM (NOW() - assessed_at))/3600 FROM strategist.regime_log ORDER BY assessed_at DESC LIMIT 1" 2>/dev/null || echo "")
if [ -z "$REGIME_AGE" ]; then
    RESULTS="$RESULTS\n⚠️ regime_log: no data"
elif [ "$(echo "$REGIME_AGE > 4" | bc -l 2>/dev/null || echo 0)" = "1" ]; then
    RESULTS="$RESULTS\n⚠️ regime_log: ${REGIME_AGE%.*}h old (stale)"
else
    RESULTS="$RESULTS\n✅ regime_log: ${REGIME_AGE%.*}h old"
fi

# Check performance state file freshness (still file-based)
STATE_DIR="$(dirname "$0")/../../state"
for f in performance-log.json; do
    if [ -f "$STATE_DIR/$f" ]; then
        AGE=$(( ($(date +%s) - $(stat -f %m "$STATE_DIR/$f" 2>/dev/null || stat -c %Y "$STATE_DIR/$f" 2>/dev/null)) / 3600 ))
        if [ "$AGE" -gt 4 ]; then
            RESULTS="$RESULTS\n⚠️ $f: ${AGE}h old (stale)"
        else
            RESULTS="$RESULTS\n✅ $f: ${AGE}h old"
        fi
    else
        RESULTS="$RESULTS\n⚠️ $f: missing"
    fi
done

# Output results
echo -e "🐕 **Watchdog Report**\n$RESULTS"

# Alert via webhook if any failures
if [ "$FAILURES" -gt 0 ] && [ -n "$WEBHOOK_URL" ]; then
    curl -sf -X POST "$WEBHOOK_URL" \
        -H "Content-Type: application/json" \
        -d "{\"content\": \"🚨 **Watchdog Alert** — $FAILURES service(s) down\n$(echo -e "$RESULTS")\"}" \
        > /dev/null 2>&1 || true
fi
