#!/bin/bash
# Mac External QNAP Monitor — záloha pro případ kdy QNAP OS sám nezvládne watchdog
# Spouštět jako Claude Code scheduled task každých 15 minut
#
# Co dělá:
#   1. Zkontroluje MCP health přes interní IP
#   2. Pokud nezdravý, zkusí SSH přes Tailscale a restartuje kontejner
#   3. Pokud SSH selže, pošle ntfy upozornění pro ruční zásah
#
# NASTAVENÍ:
#   Toto je voláno jako Claude Code scheduled task.
#   Viz: create-mac-monitor-task.sh pro registraci.

SSH_KEY="$HOME/.ssh/claude-qnap"
QNAP_LAN="192.168.60.221"
QNAP_VPN="100.99.239.94"   # Tailscale IP
DOCKER_BIN="/share/CACHEDEV1_DATA/.qpkg/container-station/usr/bin/docker"
CONTAINER="qnap-game-mcp"
NTFY_INT="http://192.168.60.221:8225/agent-maintenance"
NTFY_PUB="https://ntfy.vo2info.cz/agent-maintenance"

# --- Kontrola health ---
HEALTH=$(curl -s --max-time 8 "http://$QNAP_LAN:3000/health" 2>/dev/null)
if echo "$HEALTH" | grep -q '"ok":true'; then
  # Zdravý — ticho
  exit 0
fi

echo "[$(date)] MCP unhealthy — health response: ${HEALTH:-timeout}"

# --- Zkus SSH přes LAN ---
SSH_CMD="ssh -i $SSH_KEY -o ConnectTimeout=10 -o BatchMode=yes admin@$QNAP_LAN"
if $SSH_CMD "echo ok" > /dev/null 2>&1; then
  echo "[$(date)] SSH LAN OK — restarting container"
  $SSH_CMD "$DOCKER_BIN restart $CONTAINER"
  MSG="🔄 $CONTAINER restarted by Mac monitor (LAN SSH)"
  curl -s -X POST "$NTFY_INT" -H "Title: Mac Monitor" -d "$MSG" > /dev/null 2>&1
  exit 0
fi

# --- Zkus SSH přes Tailscale ---
SSH_VPN="ssh -i $SSH_KEY -o ConnectTimeout=10 -o BatchMode=yes admin@$QNAP_VPN"
if $SSH_VPN "echo ok" > /dev/null 2>&1; then
  echo "[$(date)] SSH Tailscale OK — restarting container"
  $SSH_VPN "$DOCKER_BIN restart $CONTAINER"
  MSG="🔄 $CONTAINER restarted by Mac monitor (Tailscale SSH)"
  curl -s -X POST "$NTFY_PUB" -H "Title: Mac Monitor" -d "$MSG" > /dev/null 2>&1
  exit 0
fi

# --- SSH selhal — QNAP OS zmrazený, potřeba ruční zásah ---
echo "[$(date)] SSH failed — QNAP OS may be frozen, manual restart needed"
MSG="🚨 QNAP OS zmrazený — MCP nezdravý a SSH selhalo. Potřeba ruční restart QNAP."
curl -s -X POST "$NTFY_PUB" -H "Title: QNAP ZMRAZENÝ" -H "Priority: urgent" -d "$MSG" > /dev/null 2>&1
exit 1
