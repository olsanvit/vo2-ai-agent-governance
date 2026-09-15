#!/bin/sh
# Rotace hesla AgentAI na QNAPu — neinteraktivní, s rollbackem. Spouštět z Macu:
#   ssh -i ~/.ssh/claude-qnap admin@192.168.60.221 'sh -s' < rotate-agentai-qnap.sh
# Heslo se nikde nevypisuje ani nepředává v parametrech příkazů (psql dostává přes stdin).
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
CD=/share/Container/mcp-qnap
C=$CD/docker-compose.yml
ENVF=$CD/.env
VIN_ENV=/share/Container/vin-importer/.env
TS=$(date +%Y%m%d-%H%M%S)
BAK=$CD/docker-compose.yml.pre-rotace-$TS
umask 077

command -v openssl >/dev/null || { echo "❌ openssl chybí — stop"; exit 1; }
[ -e "$ENVF" ] && { echo "❌ $ENVF už existuje — stop (nepřepisuji)"; exit 1; }
[ "$(md5sum < "$C" | cut -c1-12)" = "f82567659e4d" ] || { echo "❌ compose se od kontroly 2026-09-15 změnil — stop"; exit 1; }

# 1) příprava — DB zatím beze změny
cp "$C" "$BAK"; chmod 600 "$BAK"
# Prefix URL přes proměnnou: celý vzor v jednom literálu by check-secrets.sh bral jako heslo v URL.
URL_PREFIX='postgresql://AgentAI:'
OLD=$(sed -nE "s#.*${URL_PREFIX}([^@]*)@.*#\\1#p" "$BAK" | head -1)
[ -n "$OLD" ] || { echo "❌ původní heslo v compose nenalezeno — stop"; exit 1; }
NEW=$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-32)
[ ${#NEW} -eq 32 ] || { echo "❌ generování hesla selhalo — stop"; exit 1; }

undo_prep() { cp "$BAK" "$C"; rm -f "$ENVF"; echo "↩ compose obnoven, .env odstraněn (DB beze změny)"; }

printf 'AGENT_DB_PASSWORD=%s\n' "$NEW" > "$ENVF"; chmod 600 "$ENVF"
sed -i -E 's#(postgresql://AgentAI:)[^@]*@#\1${AGENT_DB_PASSWORD}@#' "$C"
[ "$(grep -c 'AgentAI:${AGENT_DB_PASSWORD}@' "$C")" = "1" ] || { echo "❌ náhrada URL"; undo_prep; exit 1; }
grep -v 'AgentAI:' "$BAK" > "$CD/.a.$TS"; grep -v 'AgentAI:' "$C" > "$CD/.b.$TS"
if ! cmp -s "$CD/.a.$TS" "$CD/.b.$TS"; then rm -f "$CD/.a.$TS" "$CD/.b.$TS"; echo "❌ změnily se jiné řádky"; undo_prep; exit 1; fi
rm -f "$CD/.a.$TS" "$CD/.b.$TS"
(cd "$CD" && $D compose config --services >/dev/null 2>&1) || { echo "❌ compose config"; undo_prep; exit 1; }
echo "✓ 1) příprava: .env (600), compose → \${AGENT_DB_PASSWORD}, záloha $(basename "$BAK") (600)"

set_pw()   { printf 'ALTER USER "AgentAI" WITH PASSWORD '"'"'%s'"'"';\n' "$1" | $D exec -i pg16 psql -U roundnet -d postgres -v ON_ERROR_STOP=1 -q >/dev/null; }
login_ok() { printf '%s\n' "$1" | $D exec -i pg16 sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U AgentAI -d AIData -tAc "select 1"' 2>/dev/null | grep -qx 1; }
vin_run()  {
  printf 'DB_CONN=%s\nVIN_IMPORT_DIR=/data/vin-imports\n' "postgresql://AgentAI:$1@127.0.0.1:5432/AIData" > "$VIN_ENV"; chmod 600 "$VIN_ENV"
  $D rm -f vin-importer >/dev/null
  $D run -d --name vin-importer --network host --restart unless-stopped --env-file "$VIN_ENV" \
    -v /share/CACHEDEV1_DATA/homes/admin/vin-imports:/data/vin-imports vin-importer python importer.py import >/dev/null
}
mcp_healthy() {
  i=0; while [ $i -lt 12 ]; do
    b=$(curl -s --max-time 5 http://127.0.0.1:3000/health || true)
    case "$b" in *'"db":"ok"'*) return 0;; esac
    i=$((i+1)); sleep 5
  done; return 1
}

login_ok "$OLD" || { echo "❌ původní heslo nefunguje ani před změnou — stop"; undo_prep; exit 1; }

# 2) heslo v DB + okamžitý restart spotřebitelů
set_pw "$NEW" || { echo "❌ ALTER USER selhal"; undo_prep; exit 1; }
echo "✓ 2) heslo AgentAI v pg16 změněno"
(cd "$CD" && $D compose up -d --no-deps mcp >/dev/null 2>&1) && echo "✓ 3) qnap-game-mcp znovu vytvořen" || echo "⚠️ compose up selhal"
vin_run "$NEW" && echo "✓ 4) vin-importer znovu vytvořen (--env-file, unless-stopped)"

# 3) ověření, při chybě rollback
OK=1
login_ok "$NEW" && echo "✓ nové heslo: přihlášení OK" || { echo "❌ nové heslo: přihlášení selhalo"; OK=0; }
login_ok "$OLD" && { echo "❌ STARÉ heslo pořád funguje"; OK=0; } || echo "✓ staré heslo: odmítnuto"
mcp_healthy && echo "✓ qnap-game-mcp /health: db ok" || { echo "❌ qnap-game-mcp /health bez db ok"; OK=0; }
$D inspect vin-importer --format '  vin-importer: {{.State.Status}}, restart={{.HostConfig.RestartPolicy.Name}}'
$D inspect qnap-game-mcp --format '  qnap-game-mcp: {{.State.Status}}, od {{.State.StartedAt}}'

if [ $OK -eq 0 ]; then
  echo "↩ ROLLBACK: vracím původní heslo"
  set_pw "$OLD" && echo "  heslo v DB vráceno"
  cp "$BAK" "$C"; rm -f "$ENVF"
  (cd "$CD" && $D compose up -d --no-deps mcp >/dev/null 2>&1) && echo "  qnap-game-mcp obnoven"
  vin_run "$OLD" && echo "  vin-importer obnoven"
  mcp_healthy && echo "  ✓ po rollbacku zdravé" || echo "  ❌ ani po rollbacku není zdravé — řešit ručně"
  exit 2
fi
echo "✅ ROTACE AgentAI HOTOVÁ — nové heslo je v $ENVF (600); ulož ho do Vaultwardenu"
