#!/bin/sh
# QNAP Docker cleanup — mazání nepotřebných vrstev, logů a cachí
# Cron: 0 3 * * 0 /share/Container/mcp-qnap/qnap-cleanup.sh >> /share/Container/mcp-qnap/cleanup.log 2>&1
# (každou neděli ve 3:00 ráno)

DOCKER=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
NTFY_URL="http://192.168.60.221:8225/agent-runs"
LOG_PREFIX="[cleanup $(date '+%Y-%m-%d %H:%M:%S')]"

echo "$LOG_PREFIX START"

before=$(df /share/CACHEDEV1_DATA | awk 'NR==2{print $3}')

# Smazat zastavené kontejnery, nepouživané sítě, dangling images, build cache
$DOCKER system prune -f >> /dev/null 2>&1
echo "$LOG_PREFIX docker system prune OK"

# Smazat nepouživané image (ne jen dangling)
$DOCKER image prune -af >> /dev/null 2>&1
echo "$LOG_PREFIX docker image prune OK"

after=$(df /share/CACHEDEV1_DATA | awk 'NR==2{print $3}')
freed_kb=$((before - after))
freed_mb=$((freed_kb / 1024))

overlay_count=$($DOCKER system df 2>/dev/null | grep -c "." || echo "?")

echo "$LOG_PREFIX Uvolneno: ${freed_mb}MB"

wget -qO- --post-data="Docker cleanup OK | Uvolněno: ${freed_mb}MB | Overlay layers: $(ls /share/CACHEDEV1_DATA/.qpkg/container-station/var/lib/docker/overlay2/ 2>/dev/null | wc -l)" \
  --header="Title: 🧹 QNAP cleanup OK" \
  --header="Priority: low" \
  --header="Tags: broom" \
  --timeout=5 \
  "$NTFY_URL" > /dev/null 2>&1

echo "$LOG_PREFIX END"
