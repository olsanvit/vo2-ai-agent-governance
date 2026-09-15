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
    # use_var tu nejde: DATABASE_URL je v compose dvakrát (i mcp-sportreal pod roundnet) a hodnota
    # je celá URL, ne jen heslo. Nahrazuje se proto jen heslo v URL uživatele AgentAI.
    sed -i.bak -E 's#(postgresql://AgentAI:)[^@]*@#\1${AGENT_DB_PASSWORD}@#' "$COMPOSE_DIR/docker-compose.yml"
    grep -c 'AgentAI:${AGENT_DB_PASSWORD}@' "$COMPOSE_DIR/docker-compose.yml" | grep -qx 1 \
      || { echo "❌ compose neobsahuje právě jednu URL AgentAI s \${AGENT_DB_PASSWORD} — stop, heslo v DB nezměněno"; exit 1; }
    (cd "$COMPOSE_DIR" && $DOCKER compose config >/dev/null) || { echo "❌ compose config selhal — stop"; exit 1; }
    # Role postgres v pg16 neexistuje — superuser clusteru je roundnet.
    $DOCKER exec -i pg16 psql -U roundnet -d postgres -v ON_ERROR_STOP=1 -c "ALTER USER \"AgentAI\" WITH PASSWORD '$NEW';"
    # Služba se v compose jmenuje "mcp" (kontejner qnap-game-mcp).
    (cd "$COMPOSE_DIR" && $DOCKER compose up -d mcp)
    # vin-importer je docker run bez compose — heslo nelze změnit za běhu, kontejner se musí
    # vytvořit znovu. Env jde do vlastního .env (chmod 600), aby heslo nebylo v docker inspect
    # parametrech skriptů ani v historii shellu. restart=unless-stopped: je to poller a
    # s původním restart=no zůstal po resetu QNAPu (exit 137) tiše vypnutý.
    VIN_DIR=/share/Container/vin-importer
    umask 077
    printf 'DB_CONN=%s\nVIN_IMPORT_DIR=/data/vin-imports\n' "postgresql://AgentAI:${NEW}@127.0.0.1:5432/AIData" > "$VIN_DIR/.env"
    chmod 600 "$VIN_DIR/.env"
    $DOCKER rm -f vin-importer
    $DOCKER run -d --name vin-importer --network host --restart unless-stopped \
      --env-file "$VIN_DIR/.env" \
      -v /share/CACHEDEV1_DATA/homes/admin/vin-imports:/data/vin-imports \
      vin-importer python importer.py import
    sleep 70
    $DOCKER logs --tail 3 vin-importer 2>&1 | cut -c1-200
    $DOCKER inspect vin-importer --format 'vin-importer: {{.State.Status}}'
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
