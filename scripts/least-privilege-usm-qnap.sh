#!/bin/sh
# Přepne mcp-usm z roundnet na roli mcp_usm_usr (člen sportmanager_usr, vlastníka DB UniSportManager).
# NEPROVEDENO — spuštění zablokoval klasifikátor. Spuštění: scp na QNAP do
# /share/Container/mcp-qnap/secrets/ a tam `sh <soubor>` (ne přes stdin).
# Pozor: mcp-usm je i tak nefunkční — kód čeká tabulky Sm* ze staré DB sportManager.
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
CD=/share/Container/mcp-qnap; SEC=$CD/secrets; EF=$SEC/mcp-usm.env; ENVF=$CD/.env
TS=$(date +%Y%m%d-%H%M%S)
umask 077
q()  { $D exec pg16 psql -U roundnet -v ON_ERROR_STOP=1 -q "$@" </dev/null; }
qi() { $D exec -i pg16 psql -U roundnet -v ON_ERROR_STOP=1 -q "$@"; }

[ -f "$EF" ] || { echo "❌ $EF chybí — stop"; exit 1; }
[ "$(sed -n 's#^DATABASE_URL=postgresql://\([^:]*\):.*#\1#p' "$EF")" = roundnet ] || { echo "❌ env soubor už neukazuje na roundnet — stop"; exit 1; }
[ "$(q -d postgres -tAc "SELECT count(*) FROM pg_roles WHERE rolname='mcp_usm_usr'")" = 0 ] || { echo "❌ role mcp_usm_usr existuje — stop"; exit 1; }
$D inspect mcp-usm-prerot >/dev/null 2>&1 && { echo "❌ mcp-usm-prerot existuje — stop"; exit 1; }
echo "✓ kontroly před změnou"

PW=$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-32); [ ${#PW} -eq 32 ] || exit 1
drop_role() {
  q -d UniSportManager -c "REASSIGN OWNED BY mcp_usm_usr TO sportmanager_usr;" >/dev/null 2>&1 || true
  q -d UniSportManager -c "DROP OWNED BY mcp_usm_usr;" >/dev/null 2>&1 || true
  q -d postgres -c "DROP ROLE IF EXISTS mcp_usm_usr;" >/dev/null 2>&1 || true
}

# Role s vlastním heslem; práva vlastníka UniSportManager přes členství (INHERIT) — ALTER TABLE
# při startu mcp-usm vyžaduje vlastnictví, holé DML by server shodilo. SET TRUE: SET ROLE pro
# objekty vytvořené serverem, aby patřily vlastníkovi databáze.
printf "CREATE ROLE mcp_usm_usr LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD '%s';\n" "$PW" | qi -d postgres
q -d postgres -c 'GRANT sportmanager_usr TO mcp_usm_usr WITH INHERIT TRUE, SET TRUE;' || { drop_role; echo "❌ GRANT"; exit 1; }
q -d postgres -c 'ALTER ROLE mcp_usm_usr IN DATABASE "UniSportManager" SET role = sportmanager_usr;' || { drop_role; echo "❌ ALTER ROLE"; exit 1; }
echo "✓ role mcp_usm_usr (člen sportmanager_usr)"

chk=$(printf '%s\n' "$PW" | $D exec -i pg16 sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U mcp_usm_usr -d UniSportManager -tAc "select current_user||'"'"'|'"'"'||(select rolsuper from pg_roles where rolname=session_user)||'"'"'|'"'"'||(select count(*) from \"Teams\")"' 2>&1 || true)
case "$chk" in sportmanager_usr\|false\|[0-9]*|sportmanager_usr\|f\|[0-9]*) echo "✓ přihlášení: current_user=sportmanager_usr, superuser=ne";; *) echo "❌ přihlášení: ${chk:0:120}"; drop_role; exit 1;; esac
# DDL test vynechán: kód mcp-usm míří na tabulky Sm* ze staré DB sportManager, na živé
# UniSportManager by ADD COLUMN IF NOT EXISTS sloupec opravdu přidal.
other=$(printf '%s\n' "$PW" | $D exec -i pg16 sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U mcp_usm_usr -d AIData -tAc "select 1"' 2>&1 || true)
case "$other" in *"permission denied"*|*"not permitted"*|*FATAL*) echo "✓ přístup do cizí DB (AIData) odmítnut";; *) echo "⚠️ přístup do AIData: ${other:0:80} (CONNECT je nejspíš povolený PUBLIC)";; esac

# env soubor: nahradit jen uživatele a heslo v DATABASE_URL
cp "$EF" "$EF.pre-usmrole-$TS"
sed -i -E "s#^DATABASE_URL=postgresql://roundnet:[^@]*@#DATABASE_URL=postgresql://mcp_usm_usr:${PW}@#" "$EF"
[ "$(grep -c '^DATABASE_URL=postgresql://mcp_usm_usr:' "$EF")" = 1 ] || { cp "$EF.pre-usmrole-$TS" "$EF"; drop_role; echo "❌ úprava env"; exit 1; }
printf 'MCP_USM_DB_PASSWORD=%s\n' "$PW" >> "$ENVF"

ping_state() { # vrátí ok / chyba / nic — stačí porovnat stav před a po
  TOK=$(sed -n 's/^MCP_AUTH_TOKEN=//p' "$ENVF"); cfg=$SEC/.c.$$
  printf 'header = "Authorization: Bearer %s"\n' "$TOK" > "$cfg"
  r=$(curl -s --max-time 20 -K "$cfg" -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"db_ping","arguments":{}}}' http://127.0.0.1:3006/mcp || true)
  rm -f "$cfg"
  case "$r" in '') echo nic;; *'"isError":true'*|*'"error"'*) echo chyba;; *) echo ok;; esac
}
BEFORE=$(ping_state); echo "  db_ping před přepnutím: $BEFORE"
img=$($D inspect mcp-usm --format '{{.Image}}')
$D rename mcp-usm mcp-usm-prerot; $D stop mcp-usm-prerot >/dev/null </dev/null
undo() {
  $D rm -f mcp-usm >/dev/null 2>&1 || true
  $D rename mcp-usm-prerot mcp-usm && $D start mcp-usm >/dev/null </dev/null
  cp "$EF.pre-usmrole-$TS" "$EF"; sed -i '/^MCP_USM_DB_PASSWORD=/d' "$ENVF"; drop_role
  echo "↩ vráceno (kontejner, env, role)"
}
$D run -d --name mcp-usm --env-file "$EF" --network host --restart unless-stopped -w /app --entrypoint node \
  --log-driver json-file --log-opt max-file=10 --log-opt max-size=10m \
  -v /share/Container/mcp-image:/app "$img" mcp-usm.js >/dev/null </dev/null || { echo "❌ docker run"; undo; exit 1; }
ok=0; i=0
while [ $i -lt 12 ]; do
  case "$(curl -s --max-time 5 http://127.0.0.1:3006/health)" in *'"db":"ok"'*) ok=1; break;; esac
  i=$((i+1)); sleep 5
done
[ $ok = 1 ] || { echo "❌ /health"; undo; exit 1; }
echo "✓ mcp-usm /health db ok"
L=$($D inspect mcp-usm --format '{{.LogPath}}')
if tr -d '\000' < "$L" | grep -qiE 'must be owner|permission denied|password authentication|role .* does not exist'; then
  echo "❌ chyba v logu: $(tr -d '\000' < "$L" | grep -iE 'must be owner|permission denied|password authentication|role .* does not exist' | head -2 | cut -c1-150)"; undo; exit 1
fi
echo "✓ log bez chyb"
AFTER=$(ping_state); echo "  db_ping po přepnutí: $AFTER"
[ "$AFTER" = "$BEFORE" ] || { echo "❌ db_ping se změnil"; undo; exit 1; }
echo "  spojení mcp_usm_usr: $(q -d postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE usename='mcp_usm_usr'")"
$D rm -f mcp-usm-prerot >/dev/null && echo "  smazán mcp-usm-prerot (držel heslo roundnet)"
echo "✅ mcp-usm už nepoužívá roundnet"
