#!/bin/sh
# QNAP Watchdog — kontroluje zdraví kontejnerů a posílá ntfy alerty
# Cron: */5 * * * * /share/Container/mcp-qnap/watchdog.sh >> /share/Container/mcp-qnap/watchdog.log 2>&1

DOCKER=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
NTFY_URL="http://192.168.60.221:8225/agent-errors"
LOG_PREFIX="[watchdog $(date '+%Y-%m-%d %H:%M:%S')]"

ntfy_alert() {
  title="$1"
  msg="$2"
  priority="${3:-high}"
  wget -qO- --post-data="$msg" \
    --header="Title: $title" \
    --header="Priority: $priority" \
    --header="Tags: warning" \
    --timeout=5 \
    "$NTFY_URL" > /dev/null 2>&1
}

check_http() {
  url="$1"
  code=$(wget -qO- --timeout=8 --server-response "$url" 2>&1 | grep "HTTP/" | tail -1 | awk '{print $2}')
  [ "$code" = "200" ] && return 0 || return 1
}

echo "$LOG_PREFIX START"

# === 1. Docker daemon check ===
if ! $DOCKER info > /dev/null 2>&1; then
  echo "$LOG_PREFIX WARN: Docker daemon neodpovida"
  ntfy_alert "🚨 QNAP Docker daemon down" "Docker daemon neodpovídá — nutný ruční restart Container Station" "urgent"
  exit 1
fi

# === 2. Kontejner: qnap-game-mcp (port 3000) ===
if ! check_http "http://localhost:3000/liveness"; then
  echo "$LOG_PREFIX WARN: qnap-game-mcp nereaguje — restartuji"
  $DOCKER restart qnap-game-mcp > /dev/null 2>&1
  sleep 10
  if check_http "http://localhost:3000/liveness"; then
    echo "$LOG_PREFIX OK: qnap-game-mcp obnoven"
    ntfy_alert "⚠️ QNAP mcp restart" "qnap-game-mcp byl restarován watchdogem — nyní OK" "default"
  else
    echo "$LOG_PREFIX ERROR: qnap-game-mcp stale nereaguje po restartu"
    ntfy_alert "🚨 QNAP mcp DOWN" "qnap-game-mcp nereaguje ani po restartu — vyžaduje pozornost" "urgent"
  fi
else
  echo "$LOG_PREFIX OK: qnap-game-mcp"
fi

# === 3. Kontejner: mcp-sportreal (port 3002) ===
if $DOCKER ps --format '{{.Names}}' | grep -q "mcp-sportreal"; then
  if ! check_http "http://localhost:3002/health"; then
    echo "$LOG_PREFIX WARN: mcp-sportreal nereaguje — restartuji"
    $DOCKER restart mcp-sportreal > /dev/null 2>&1
    sleep 8
    if check_http "http://localhost:3002/health"; then
      echo "$LOG_PREFIX OK: mcp-sportreal obnoven"
      ntfy_alert "⚠️ QNAP mcp-sportreal restart" "mcp-sportreal restarován watchdogem — nyní OK" "default"
    else
      echo "$LOG_PREFIX ERROR: mcp-sportreal stale nereaguje"
      ntfy_alert "🚨 QNAP mcp-sportreal DOWN" "mcp-sportreal nereaguje ani po restartu" "urgent"
    fi
  else
    echo "$LOG_PREFIX OK: mcp-sportreal"
  fi
fi

# === 4. PostgreSQL pg16 (port 5433) ===
if $DOCKER ps --format '{{.Names}}' | grep -q "pg16"; then
  if ! $DOCKER exec pg16 pg_isready -q > /dev/null 2>&1; then
    echo "$LOG_PREFIX WARN: pg16 nereaguje — restartuji"
    $DOCKER restart pg16 > /dev/null 2>&1
    sleep 15
    if $DOCKER exec pg16 pg_isready -q > /dev/null 2>&1; then
      echo "$LOG_PREFIX OK: pg16 obnoven"
      ntfy_alert "⚠️ QNAP pg16 restart" "pg16 restarován watchdogem — nyní OK" "default"
    else
      echo "$LOG_PREFIX ERROR: pg16 stale nereaguje"
      ntfy_alert "🚨 QNAP pg16 DOWN" "pg16 nereaguje ani po restartu — nutná kontrola" "urgent"
    fi
  else
    echo "$LOG_PREFIX OK: pg16"
  fi
fi

# === 5. Memory check — varovat pokud volná RAM < 512 MB ===
free_mb=$(free -m | awk '/Mem:/{print $4}')
if [ "$free_mb" -lt 512 ]; then
  echo "$LOG_PREFIX WARN: volna RAM jen ${free_mb}MB"
  ntfy_alert "⚠️ QNAP low RAM" "Volná RAM: ${free_mb}MB — hrozí OOM, zvážit restart kontejnerů" "high"
fi

# === 6. Disk check — varovat pokud /share < 10% volné ===
disk_pct=$(df /share/CACHEDEV1_DATA | awk 'NR==2{print $5}' | tr -d '%')
if [ "$disk_pct" -gt 90 ]; then
  echo "$LOG_PREFIX WARN: disk /share ${disk_pct}% plný"
  ntfy_alert "⚠️ QNAP disk plný" "Disk /share: ${disk_pct}% obsazeno — spustit docker system prune" "high"
fi

echo "$LOG_PREFIX END (RAM: ${free_mb}MB volné, disk: ${disk_pct}%)"
