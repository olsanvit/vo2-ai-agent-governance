#!/bin/sh
# Přepne mcp-sportreal z roundnet na roli mcp_sr_usr jen pro čtení. PROVEDENO 2026-09-16.
# Spuštění: scp na QNAP do /share/Container/mcp-qnap/secrets/ a tam `sh <soubor>` (ne přes stdin —
# `docker exec -i` by spolklo zbytek skriptu). Kontrolní md5 compose platí jen pro stav z 2026-09-16.
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
CD=/share/Container/mcp-qnap; C=$CD/docker-compose.yml; ENVF=$CD/.env
TS=$(date +%Y%m%d-%H%M%S); BAK=$CD/docker-compose.yml.pre-srrole-$TS
umask 077
[ "$(md5sum < "$C" | cut -c1-12)" = "f2fe77aa5226" ] || { echo "❌ compose se změnil — stop"; exit 1; }
grep -q '^MCP_SR_DB_PASSWORD=' "$ENVF" && { echo "❌ MCP_SR_DB_PASSWORD už existuje — stop"; exit 1; }
q()  { $D exec pg16 psql -U roundnet -v ON_ERROR_STOP=1 -q "$@" </dev/null; }   # bez stdin
qi() { $D exec -i pg16 psql -U roundnet -v ON_ERROR_STOP=1 -q "$@"; }            # SQL ze stdin
[ "$(q -d postgres -tAc "SELECT count(*) FROM pg_roles WHERE rolname='mcp_sr_usr'")" = 0 ] || { echo "❌ role mcp_sr_usr existuje — stop"; exit 1; }
echo "✓ kontroly před změnou"

PW=$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-32)
[ ${#PW} -eq 32 ] || { echo "❌ generování hesla"; exit 1; }

drop_role() {
  q -d sportReal -c "ALTER DEFAULT PRIVILEGES FOR ROLE roundnet IN SCHEMA public REVOKE SELECT ON TABLES FROM mcp_sr_usr;" >/dev/null 2>&1 || true
  q -d sportReal -c "DROP OWNED BY mcp_sr_usr;" >/dev/null 2>&1 || true
  q -d postgres -c "DROP ROLE IF EXISTS mcp_sr_usr;" >/dev/null 2>&1 || true
}

printf "CREATE ROLE mcp_sr_usr LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '%s';\n" "$PW" | qi -d postgres
printf '%s\n' \
  'GRANT CONNECT ON DATABASE "sportReal" TO mcp_sr_usr;' \
  'GRANT USAGE ON SCHEMA public TO mcp_sr_usr;' \
  'GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_sr_usr;' \
  'ALTER DEFAULT PRIVILEGES FOR ROLE roundnet IN SCHEMA public GRANT SELECT ON TABLES TO mcp_sr_usr;' \
  'ALTER ROLE mcp_sr_usr SET default_transaction_read_only = on;' | qi -d sportReal || { echo "❌ GRANT"; drop_role; exit 1; }
echo "✓ role mcp_sr_usr (SELECT na sportReal, transakce jen pro čtení)"

n=$(printf '%s\n' "$PW" | $D exec -i pg16 sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U mcp_sr_usr -d sportReal -tAc "select count(*) from pg_tables where schemaname = current_schema()"' 2>/dev/null || true)
case "$n" in ''|*[!0-9]*) echo "❌ přihlášení mcp_sr_usr"; drop_role; exit 1;; esac
echo "✓ přihlášení mcp_sr_usr OK ($n tabulek viditelných)"
w=$(printf '%s\n' "$PW" | $D exec -i pg16 sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U mcp_sr_usr -d sportReal -tAc "create table zz_probe(x int)"' 2>&1 || true)
case "$w" in *"read-only"*|*"permission denied"*) echo "✓ zápis odmítnut";; *) echo "❌ zápis NEODMÍTNUT: ${w:0:80}"; q -d sportReal -c 'DROP TABLE IF EXISTS zz_probe' >/dev/null 2>&1 || true; drop_role; exit 1;; esac

undo() { cp "$BAK" "$C"; sed -i '/^MCP_SR_DB_PASSWORD=/d' "$ENVF"; (cd "$CD" && $D compose up -d --no-deps mcp-sportreal >/dev/null 2>&1 </dev/null) || true; drop_role; echo "↩ vráceno (compose, .env, role)"; }

cp "$C" "$BAK"; chmod 600 "$BAK"
printf 'MCP_SR_DB_PASSWORD=%s\n' "$PW" >> "$ENVF"; chmod 600 "$ENVF"
sed -i -E 's#postgresql://roundnet:[^@]*@(192\.168\.60\.221:5432/sportReal)#postgresql://mcp_sr_usr:${MCP_SR_DB_PASSWORD}@\1#' "$C"
[ "$(grep -c 'mcp_sr_usr:${MCP_SR_DB_PASSWORD}@' "$C")" = 1 ] && [ "$(grep -c 'roundnet' "$C")" = 0 ] || { echo "❌ úprava compose"; undo; exit 1; }
(cd "$CD" && $D compose config --services >/dev/null 2>&1 </dev/null) || { echo "❌ compose config"; undo; exit 1; }
(cd "$CD" && $D compose up -d --no-deps mcp-sportreal >/dev/null 2>&1 </dev/null) || { echo "❌ compose up"; undo; exit 1; }
echo "✓ mcp-sportreal znovu vytvořen"

ok=0; i=0
while [ $i -lt 12 ]; do
  case "$(curl -s --max-time 5 http://127.0.0.1:3008/health)" in *'"ok":true'*) ok=1; break;; esac
  i=$((i+1)); sleep 5
done
[ $ok = 1 ] && echo "✓ /health ok" || { echo "❌ /health"; undo; exit 1; }
u=$($D inspect mcp-sportreal --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's#^DATABASE_URL=postgresql://\([^:]*\):.*#\1#p')
echo "  DB uživatel kontejneru: $u"
TOK=$(sed -n 's/^MCP_AUTH_TOKEN=//p' "$ENVF"); cfg=$CD/secrets/.c.$$
printf 'header = "Authorization: Bearer %s"\n' "$TOK" > "$cfg"
res=$(curl -s --max-time 20 -K "$cfg" -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"sr_list_sports","arguments":{}}}' http://127.0.0.1:3008/mcp || true)
rm -f "$cfg"
case "$res" in
  *'"isError":true'*|*'"error"'*|'') echo "❌ sr_list_sports: ${res:0:160}"; undo; exit 1;;
  *) echo "✓ sr_list_sports odpověděl (${#res} bajtů)";;
esac
echo "  aktivní spojení mcp_sr_usr: $(q -d postgres -tAc "SELECT count(*) FROM pg_stat_activity WHERE usename='mcp_sr_usr'")"
echo "✅ mcp-sportreal už nepoužívá roundnet (záloha $(basename "$BAK"))"
