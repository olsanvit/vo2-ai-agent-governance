#!/bin/sh
# Přepojí mcp-sportreal z prázdné DB sportReal na SportReal (data aplikace simulatereal);
# role mcp_sr_usr dostane SELECT i tam. Kontrola úspěchu: sr_list_sports vrací neprázdný seznam.
# Spuštění: scp do /share/Container/mcp-qnap/secrets/ a tam `sh <soubor>` (ne přes stdin).
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
CD=/share/Container/mcp-qnap; C=$CD/docker-compose.yml; ENVF=$CD/.env; SEC=$CD/secrets
TS=$(date +%Y%m%d-%H%M%S); BAK=$CD/docker-compose.yml.pre-srdb-$TS
umask 077
LINE='postgresql://mcp_sr_usr:${MCP_SR_DB_PASSWORD}@192.168.60.221:5432/sportReal'
[ "$(grep -cF "$LINE" "$C")" = 1 ] || { echo "❌ compose neobsahuje očekávaný řádek — stop"; exit 1; }
echo "✓ kontroly před změnou"

sr_count() {
  cfg=$SEC/.c.$$; printf 'header = "Authorization: Bearer %s"\n' "$(sed -n 's/^MCP_AUTH_TOKEN=//p' "$ENVF")" > "$cfg"
  r=$(curl -s --max-time 20 -K "$cfg" -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"sr_list_sports","arguments":{}}}' http://127.0.0.1:3008/mcp || true)
  rm -f "$cfg"
  printf '%s' "$r" | tr -d '\n' | sed -n 's/.*\\"count\\": *\([0-9]*\).*/\1/p'
}
echo "  sportů před změnou: $(sr_count)"

printf '%s\n' \
  'GRANT CONNECT ON DATABASE "SportReal" TO mcp_sr_usr;' \
  'GRANT USAGE ON SCHEMA public TO mcp_sr_usr;' \
  'GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_sr_usr;' \
  'ALTER DEFAULT PRIVILEGES FOR ROLE roundnet IN SCHEMA public GRANT SELECT ON TABLES TO mcp_sr_usr;' \
  | $D exec -i pg16 psql -U roundnet -v ON_ERROR_STOP=1 -q -d SportReal
echo "✓ SELECT na SportReal pro mcp_sr_usr"
revoke() { printf '%s\n' 'ALTER DEFAULT PRIVILEGES FOR ROLE roundnet IN SCHEMA public REVOKE SELECT ON TABLES FROM mcp_sr_usr;' 'REVOKE SELECT ON ALL TABLES IN SCHEMA public FROM mcp_sr_usr;' 'REVOKE USAGE ON SCHEMA public FROM mcp_sr_usr;' 'REVOKE CONNECT ON DATABASE "SportReal" FROM mcp_sr_usr;' | $D exec -i pg16 psql -U roundnet -q -d SportReal >/dev/null 2>&1 || true; }

PW=$(sed -n 's/^MCP_SR_DB_PASSWORD=//p' "$ENVF")
n=$(printf '%s\n' "$PW" | $D exec -i pg16 sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U mcp_sr_usr -d SportReal -tAc "select count(*) from \"Sports\""' 2>&1 || true)
case "$n" in ''|*[!0-9]*) echo "❌ čtení SportReal: ${n:0:100}"; revoke; exit 1;; esac
echo "✓ mcp_sr_usr čte SportReal (Sports: $n)"

cp "$C" "$BAK"; chmod 600 "$BAK"
undo() { cp "$BAK" "$C"; (cd "$CD" && $D compose up -d --no-deps mcp-sportreal >/dev/null 2>&1 </dev/null) || true; revoke; echo "↩ vráceno (compose, práva)"; }
sed -i 's#\(mcp_sr_usr:${MCP_SR_DB_PASSWORD}@192\.168\.60\.221:5432/\)sportReal#\1SportReal#' "$C"
[ "$(grep -c '5432/SportReal' "$C")" = 1 ] && [ "$(grep -c '5432/sportReal' "$C")" = 0 ] || { echo "❌ úprava compose"; undo; exit 1; }
(cd "$CD" && $D compose config --services >/dev/null 2>&1 </dev/null) || { echo "❌ compose config"; undo; exit 1; }
(cd "$CD" && $D compose up -d --no-deps mcp-sportreal >/dev/null 2>&1 </dev/null) || { echo "❌ compose up"; undo; exit 1; }
echo "✓ mcp-sportreal znovu vytvořen"
ok=0; i=0
while [ $i -lt 12 ]; do
  case "$(curl -s --max-time 5 http://127.0.0.1:3008/health)" in *'"ok":true'*) ok=1; break;; esac
  i=$((i+1)); sleep 5
done
[ $ok = 1 ] || { echo "❌ /health"; undo; exit 1; }
after=$(sr_count)
case "$after" in ''|0) echo "❌ sr_list_sports po změně: '${after}'"; undo; exit 1;; esac
echo "✓ sr_list_sports vrací $after sportů"
echo "✅ mcp-sportreal čte SportReal (záloha $(basename "$BAK"))"
