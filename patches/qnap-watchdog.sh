#!/bin/sh
# QNAP Watchdog — spouštět přes QNAP Task Scheduler každých 15 minut
#
# QNAP NASTAVENÍ:
#   Control Panel → Task Scheduler → Create → Triggered Task
#   Trigger: Every 15 minutes (nebo: Time-based → every 15 min)
#   Command: sh /share/Container/mcp-qnap/watchdog.sh
#
# Co dělá:
#   1. Zkontroluje /health endpoint MCP serveru
#   2. Pokud neodpovídá → restart kontejneru
#   3. Odešle ntfy notifikaci o restartu

DOCKER="/share/CACHEDEV1_DATA/.qpkg/container-station/usr/bin/docker"
CONTAINER="qnap-game-mcp"
HEALTH_URL="http://localhost:3000/health"
NTFY_URL="http://localhost:8225/agent-maintenance"
LOG="/share/Container/mcp-qnap/watchdog.log"
MAX_LOG_LINES=500

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $1" >> "$LOG"
}

# Ořez logu
if [ -f "$LOG" ] && [ "$(wc -l < "$LOG")" -gt "$MAX_LOG_LINES" ]; then
  tail -n $((MAX_LOG_LINES / 2)) "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

# Zkontroluj health endpoint (timeout 8s)
HTTP_STATUS=$(wget -qO- --timeout=8 --server-response "$HEALTH_URL" 2>&1 | grep "HTTP/" | tail -1 | awk '{print $2}')

if [ "$HTTP_STATUS" = "200" ]; then
  # Zdravý — pouze log
  ACTIVE=$(wget -qO- --timeout=5 "$HEALTH_URL" 2>/dev/null | grep -o '"activeRequests":[0-9]*' | grep -o '[0-9]*')
  log "OK health=200 active=${ACTIVE:-?}"
  exit 0
fi

# Nezdravý — restart
log "UNHEALTHY health=${HTTP_STATUS:-timeout} → restarting $CONTAINER"

# Restart kontejneru
$DOCKER restart "$CONTAINER" >> "$LOG" 2>&1
RESTART_CODE=$?

if [ $RESTART_CODE -eq 0 ]; then
  log "RESTARTED $CONTAINER successfully"
  MSG="🔄 $CONTAINER restarted by watchdog (health=${HTTP_STATUS:-timeout})"
else
  log "RESTART FAILED code=$RESTART_CODE"
  MSG="🚨 $CONTAINER restart FAILED (health=${HTTP_STATUS:-timeout}, code=$RESTART_CODE)"
fi

# Ntfy notifikace
wget -qO- --timeout=5 \
  --header="Title: QNAP Watchdog" \
  --header="Priority: high" \
  --post-data="$MSG" \
  "$NTFY_URL" > /dev/null 2>&1

exit 0
