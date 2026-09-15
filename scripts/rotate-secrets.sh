#!/usr/bin/env bash
# Rotace uniklých hodnot na QNAPu. SPOUŠTĚT NA QNAPu, ne na Macu.
#
# PROČ skript: hodnoty byly ve veřejném repu (historie přepsána 2026-09-15, repo private),
# takže je nutné je vyměnit. Ruční postup má moc kroků a mezera mezi změnou hesla a restartem
# kontejneru = doba, po kterou agenti padají. Skript ji zkracuje na minimum.
#
# POŘADÍ JE ZÁMĚRNÉ: nejdřív .env a compose (příprava), pak heslo v DB, hned nato restart.
#
# Použití:
#   bash rotate-secrets.sh agentai     # heslo AgentAI  (qnap-game-mcp, vin-importer)
#   bash rotate-secrets.sh gitea       # GITEA_TOKEN    (qnap-game-mcp)
#   bash rotate-secrets.sh mcptoken    # AUTH_TOKEN     (6 kontejnerů + ntfy admin + VŠECHNY konektory!)
set -euo pipefail

DOCKER=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
COMPOSE_DIR=/share/Container/mcp-qnap
ENV_FILE="$COMPOSE_DIR/.env"
WHAT="${1:-}"

gen() { openssl rand -base64 30 | tr -d '/+=' | head -c 32; }

# Zapíše KEY=hodnota do .env (nahradí existující řádek) a nechá soubor jen pro roota
set_env() {
  touch "$ENV_FILE"; chmod 600 "$ENV_FILE"
  grep -v "^$1=" "$ENV_FILE" > "$ENV_FILE.tmp" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE.tmp"
  mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
}

# V compose nahradí inline hodnotu odkazem na proměnnou (idempotentní)
use_var() { # $1=klíč v compose, $2=název proměnné
  sed -i.bak -E "s#^([[:space:]]*$1:[[:space:]]*).*#\1\${$2}#" "$COMPOSE_DIR/docker-compose.yml"
}

# /health se ověřuje TĚLEM odpovědi, ne HTTP kódem — router vrací 200 i na neexistující endpoint
check_health() { # $1=port
  local body; body=$(curl -s --max-time 10 "http://localhost:$1/health" || true)
  case "$body" in *protocolVersion*|*serverInfo*|*ok*) echo "  ✓ :$1 zdravé";; *) echo "  ⚠️ :$1 neodpovídá zdravě: ${body:0:80}"; return 1;; esac
}

case "$WHAT" in
  agentai)
    NEW=$(gen)
    set_env AGENT_DB_PASSWORD "$NEW"
    use_var "DATABASE_URL" AGENT_DB_PASSWORD 2>/dev/null || true
    echo "!! V $COMPOSE_DIR/docker-compose.yml zkontroluj, že DATABASE_URL zní:"
    echo "   postgresql://AgentAI:\${AGENT_DB_PASSWORD}@192.168.60.221:5432/AIData"
    read -r -p "Upraveno? [enter pro pokračování]" _
    $DOCKER exec -i pg16 psql -U postgres -v ON_ERROR_STOP=1 -c "ALTER USER \"AgentAI\" WITH PASSWORD '$NEW';"
    (cd "$COMPOSE_DIR" && $DOCKER compose up -d qnap-game-mcp)
    echo "!! vin-importer má vlastní compose — najdi ho a nastav stejné heslo:"
    $DOCKER inspect vin-importer --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true
    check_health 3000 || true
    echo "Ulož nové heslo do Vaultwarden (AgentAI / AIData)."
    ;;
  gitea)
    echo "1) V Gitei vytvoř nový token (Settings → Applications) a starý zruš."
    read -r -s -p "Vlož nový GITEA_TOKEN: " NEW; echo
    set_env GITEA_TOKEN "$NEW"
    use_var "GITEA_TOKEN" GITEA_TOKEN
    (cd "$COMPOSE_DIR" && $DOCKER compose up -d qnap-game-mcp)
    check_health 3000 || true
    echo "Ulož do Vaultwarden (GITEA_TOKEN)."
    ;;
  mcptoken)
    cat <<'WARN'
!! POZOR — největší dopad ze všech rotací:
   AUTH_TOKEN sdílí 6 kontejnerů (qnap-game-mcp, mcp-mab, mcp-usm, qnap-te-mcp,
   mcp-sportreal, mcp-oauth) a je ZÁROVEŇ heslo admina ntfy.
   Po výměně vrací 401 všechny konektory, dokud je nepřenastavíš:
     - 5 konektorů v ~/.claude.json na Macu
     - ChatGPT Custom GPT konektory (ručně, web)
     - Claude Cloud Routines
   Pokračuj jen když máš čas je hned projít.
WARN
    read -r -p "Pokračovat? [ano/ne] " a; [ "$a" = "ano" ] || exit 1
    NEW=$(gen)
    set_env MCP_AUTH_TOKEN "$NEW"
    echo "!! V compose nastav u VŠECH MCP služeb: AUTH_TOKEN: \${MCP_AUTH_TOKEN}"
    read -r -p "Upraveno? [enter]" _
    (cd "$COMPOSE_DIR" && $DOCKER compose up -d)
    echo "2) ntfy — stejné heslo pro admina:"
    echo "   $DOCKER exec -it ntfy ntfy user change-pass admin"
    for p in 3000 3001 3002; do check_health "$p" || true; done
    echo "3) mcp-router loguje token do *-json.log — po rotaci smaž staré logy:"
    echo "   $DOCKER inspect mcp-router --format '{{.LogPath}}'"
    echo "Ulož nový token do Vaultwarden (MCP AUTH_TOKEN + ntfy admin)."
    ;;
  *)
    echo "Použití: $0 {agentai|gitea|mcptoken}"; exit 1;;
esac
