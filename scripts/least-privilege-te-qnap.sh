#!/bin/sh
# Přepne qnap-te-mcp z roundnet na vlastní roli mcp_te_usr (člen topeleven_usr, vlastníka DB TopEleven).
# PROČ převod vlastnictví: 17 tabulek + sekvenci v TopEleven vytvořil server pod roundnet; server
# při startu spouští DDL, které vyžaduje vlastnictví — bez převodu by nová role server shodila.
# Spuštění: scp do /share/Container/mcp-qnap/secrets/ a tam `sh <soubor>` (ne přes stdin).
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
CD=/share/Container/mcp-qnap; SEC=$CD/secrets; EF=$SEC/qnap-te-mcp.env; ENVF=$CD/.env
TS=$(date +%Y%m%d-%H%M%S); LIST=$SEC/te-owned-by-roundnet-$TS.txt
umask 077
q()  { $D exec pg16 psql -U roundnet -v ON_ERROR_STOP=1 -q "$@" </dev/null; }
qi() { $D exec -i pg16 psql -U roundnet -v ON_ERROR_STOP=1 -q "$@"; }

[ -f "$EF" ] || { echo "❌ $EF chybí"; exit 1; }
[ "$(sed -n 's#^DATABASE_URL=postgresql://\([^:]*\):.*#\1#p' "$EF")" = roundnet ] || { echo "❌ env už neukazuje na roundnet — stop"; exit 1; }
[ "$(q -d postgres -tAc "SELECT count(*) FROM pg_roles WHERE rolname='mcp_te_usr'")" = 0 ] || { echo "❌ role mcp_te_usr existuje"; exit 1; }
$D inspect qnap-te-mcp-prerot >/dev/null 2>&1 && { echo "❌ qnap-te-mcp-prerot existuje"; exit 1; }
echo "✓ kontroly před změnou"

ping_state() {
  cfg=$SEC/.c.$$; printf 'header = "Authorization: Bearer %s"\n' "$(sed -n 's/^MCP_AUTH_TOKEN=//p' "$ENVF")" > "$cfg"
  r=$(curl -s --max-time 20 -K "$cfg" -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"db_ping","arguments":{}}}' http://127.0.0.1:3003/mcp || true)
  rm -f "$cfg"
  case "$r" in '') echo nic;; *'"isError":true'*) echo chyba;; *) echo ok;; esac
}
BEFORE=$(ping_state); echo "  db_ping před: $BEFORE"

# 1) seznam objektů roundnet v TopEleven (pro vrácení) a převod na topeleven_usr
q -d TopEleven -tAc "SELECT c.relkind||' '||quote_ident(c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','S','v','m','p') AND pg_get_userbyid(c.relowner)='roundnet' ORDER BY 1" > "$LIST"
echo "  objektů k převodu: $(wc -l < "$LIST") (seznam $(basename "$LIST"))"
set_owner() { # $1 = nový vlastník
  while read -r k name; do
    [ -n "$name" ] || continue
    case "$k" in S) t=SEQUENCE;; v) t=VIEW;; m) t="MATERIALIZED VIEW";; *) t=TABLE;; esac
    echo "ALTER $t public.$name OWNER TO $1;"
  done < "$LIST" | qi -d TopEleven
}
set_owner topeleven_usr || { echo "❌ převod vlastnictví"; set_owner roundnet || true; exit 1; }
echo "✓ vlastnictví převedeno na topeleven_usr"

PW=$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-32); [ ${#PW} -eq 32 ] || exit 1
drop_role() {
  q -d TopEleven -c "REASSIGN OWNED BY mcp_te_usr TO topeleven_usr;" >/dev/null 2>&1 || true
  q -d TopEleven -c "DROP OWNED BY mcp_te_usr;" >/dev/null 2>&1 || true
  q -d postgres -c "DROP ROLE IF EXISTS mcp_te_usr;" >/dev/null 2>&1 || true
}
full_undo_db() { drop_role; set_owner roundnet >/dev/null 2>&1 || true; echo "↩ DB vrácena (role, vlastnictví)"; }

printf "CREATE ROLE mcp_te_usr LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT PASSWORD '%s';\n" "$PW" | qi -d postgres
q -d postgres -c 'GRANT topeleven_usr TO mcp_te_usr WITH INHERIT TRUE, SET TRUE;' || { full_undo_db; exit 1; }
q -d postgres -c 'ALTER ROLE mcp_te_usr IN DATABASE "TopEleven" SET role = topeleven_usr;' || { full_undo_db; exit 1; }
chk=$(printf '%s\n' "$PW" | $D exec -i pg16 sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U mcp_te_usr -d TopEleven -tAc "select current_user::text||chr(124)||(select rolsuper::text from pg_roles where rolname=session_user)||chr(124)||(select count(*) from \"AgentCatalog\")"' 2>&1 || true)
case "$chk" in topeleven_usr\|false\|[0-9]*) echo "✓ přihlášení mcp_te_usr → topeleven_usr, není superuser";; *) echo "❌ přihlášení: ${chk:0:120}"; full_undo_db; exit 1;; esac
ddl=$(printf '%s\n' "$PW" | $D exec -i pg16 sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U mcp_te_usr -d TopEleven -tAc "ALTER TABLE \"AgentCatalog\" OWNER TO topeleven_usr"' 2>&1 || true)
case "$ddl" in *ERROR*) echo "❌ DDL na agentní tabulce: ${ddl:0:120}"; full_undo_db; exit 1;; *) echo "✓ DDL na agentní tabulce projde (no-op změna vlastníka)";; esac

cp "$EF" "$EF.pre-terole-$TS"
sed -i -E "s#^DATABASE_URL=postgresql://roundnet:[^@]*@#DATABASE_URL=postgresql://mcp_te_usr:${PW}@#" "$EF"
[ "$(grep -c '^DATABASE_URL=postgresql://mcp_te_usr:' "$EF")" = 1 ] || { cp "$EF.pre-terole-$TS" "$EF"; full_undo_db; exit 1; }
printf 'MCP_TE_DB_PASSWORD=%s\n' "$PW" >> "$ENVF"

img=$($D inspect qnap-te-mcp --format '{{.Image}}')
$D rename qnap-te-mcp qnap-te-mcp-prerot; $D stop qnap-te-mcp-prerot >/dev/null </dev/null
undo() {
  $D rm -f qnap-te-mcp >/dev/null 2>&1 || true
  $D rename qnap-te-mcp-prerot qnap-te-mcp && $D start qnap-te-mcp >/dev/null </dev/null
  cp "$EF.pre-terole-$TS" "$EF"; sed -i '/^MCP_TE_DB_PASSWORD=/d' "$ENVF"; full_undo_db
  echo "↩ vráceno (kontejner, env)"
}
$D run -d --name qnap-te-mcp --env-file "$EF" --network host --restart unless-stopped -w /app --entrypoint docker-entrypoint.sh \
  --log-driver json-file --log-opt max-file=10 --log-opt max-size=10m \
  -v /share/Container/mcp-qnap/service-account.json:/app/service-account.json:ro \
  -v /share/Container/mcp-image/uploads-te:/app/uploads \
  --health-cmd 'wget -qO- http://localhost:${PORT}/ping || exit 1' \
  --health-interval 30s --health-timeout 5s --health-start-period 15s --health-retries 3 \
  "$img" node server.js >/dev/null </dev/null || { echo "❌ docker run"; undo; exit 1; }
ok=0; i=0
while [ $i -lt 12 ]; do
  case "$(curl -s --max-time 5 http://127.0.0.1:3003/health)" in *'"db":"ok"'*) ok=1; break;; esac
  i=$((i+1)); sleep 5
done
[ $ok = 1 ] || { echo "❌ /health"; undo; exit 1; }
sleep 10
L=$($D inspect qnap-te-mcp --format '{{.LogPath}}')
if tr -d '\000' < "$L" | grep -qiE 'must be owner|permission denied|password authentication'; then
  echo "❌ log: $(tr -d '\000' < "$L" | grep -iE 'must be owner|permission denied|password authentication' | head -2 | cut -c1-150)"; undo; exit 1
fi
AFTER=$(ping_state); echo "  db_ping po: $AFTER"
[ "$AFTER" = "$BEFORE" ] || { echo "❌ db_ping se změnil"; undo; exit 1; }
$D rm -f qnap-te-mcp-prerot >/dev/null && echo "  smazán qnap-te-mcp-prerot"
echo "✅ qnap-te-mcp běží pod mcp_te_usr (seznam převedených objektů: $LIST)"
