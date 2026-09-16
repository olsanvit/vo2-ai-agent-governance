#!/bin/sh
# Rotace hesla superuživatele roundnet (hodnota byla přístupná MCP serverům s veřejným endpointem).
# PODMÍNKA: žádný MCP kontejner už roundnet nepoužívá (least-privilege-usm/te nejdřív).
# Dotčené aplikace: BlazorSimulateReal (simulatereal), BlazorSportManager (unisportmanager),
# BlazorSimulateBackup (bez kontejneru, port 5433). Admin přístup `docker exec pg16 psql -U roundnet`
# jde přes lokální socket bez hesla — rotace ho nezablokuje.
# Spuštění: scp do /share/Container/mcp-qnap/secrets/ a tam `sh <soubor>` (ne přes stdin).
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
SEC=/share/Container/mcp-qnap/secrets
TS=$(date +%Y%m%d-%H%M%S)
FILES="/share/Public/BlazorSimulateReal/publish/appsettings.Production.json
/share/Public/BlazorSportManager/publish/appsettings.Production.json
/share/Public/BlazorSimulateBackup/publish/appsettings.Production.json"
APPS="simulatereal unisportmanager"
umask 077
q() { $D exec pg16 psql -U roundnet -v ON_ERROR_STOP=1 -q "$@" </dev/null; }

# 1) podmínky
for c in $($D ps -q); do
  n=$($D inspect "$c" --format '{{.Name}}'); [ "$n" = /pg16 ] && continue
  $D inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -q 'roundnet' && { echo "❌ $n má roundnet v env — nejdřív least-privilege skripty"; exit 1; }
done
old=""
for f in $FILES; do
  [ -f "$f" ] || { echo "❌ chybí $f"; exit 1; }
  v=$(sed -n 's/.*Username=roundnet;Password=\([^;"]*\).*/\1/p' "$f" | sort -u)
  [ "$(printf '%s\n' "$v" | grep -c .)" = 1 ] || { echo "❌ $f: očekáván právě jeden tvar Username=roundnet;Password=…"; exit 1; }
  if [ -z "$old" ]; then old=$v; elif [ "$old" != "$v" ]; then echo "  ⚠️ $f má jiné (staré) heslo — přepíše se také"; fi
done
case "$old" in *[\#\&\\]*) echo "❌ staré heslo obsahuje znaky nevhodné pro sed — stop"; exit 1;; esac
echo "✓ kontroly před změnou"

NEW=$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-32); [ ${#NEW} -eq 32 ] || exit 1

# 2) zálohy, nové heslo do souborů (spolu s DB, ať je výpadek co nejkratší)
for f in $FILES; do cp -p "$f" "$f.pre-rotace-$TS"; chmod 600 "$f.pre-rotace-$TS"; done
restore_files() { for f in $FILES; do cp -p "$f.pre-rotace-$TS" "$f"; done; }
login() { printf '%s\n' "$1" | $D exec -i pg16 sh -c 'read -r PGPASSWORD; export PGPASSWORD; psql -h 127.0.0.1 -U roundnet -d postgres -tAc "select 1"' 2>/dev/null | grep -qx 1; }
login "$old" || { echo "❌ současné heslo z konfigurace nefunguje ani teď — stop"; exit 1; }

printf "ALTER USER roundnet WITH PASSWORD '%s';\n" "$NEW" | $D exec -i pg16 psql -U roundnet -v ON_ERROR_STOP=1 -q -d postgres
for f in $FILES; do
  sed -i "s#Username=roundnet;Password=[^;\"]*#Username=roundnet;Password=$NEW#g" "$f"
  # konfigurace s heslem nemá být zapisovatelná pro všechny (BlazorSimulateBackup měl 666)
  chmod o-w,g-w "$f"
done
printf '%s\n' "$NEW" > "$SEC/roundnet.pw"; chmod 600 "$SEC/roundnet.pw"
echo "✓ heslo změněno v DB a ve 3 konfiguracích (nové heslo: $SEC/roundnet.pw → Vaultwarden)"

rollback() {
  printf "ALTER USER roundnet WITH PASSWORD '%s';\n" "$old" | $D exec -i pg16 psql -U roundnet -q -d postgres >/dev/null 2>&1 || true
  restore_files; for a in $APPS; do $D restart "$a" >/dev/null 2>&1 </dev/null || true; done
  rm -f "$SEC/roundnet.pw"; echo "↩ ROLLBACK: původní heslo a konfigurace vráceny, aplikace restartovány"
}
login "$NEW" || { echo "❌ nové heslo nefunguje"; rollback; exit 1; }
login "$old" && { echo "❌ staré heslo pořád funguje"; rollback; exit 1; }
echo "✓ nové heslo platí, staré odmítnuto"

# 3) restart aplikací a kontrola přihlášení
START=$(date -u +%Y-%m-%dT%H:%M:%S)
for a in $APPS; do $D restart "$a" >/dev/null </dev/null && echo "  restart $a"; done
sleep 45
fail=0
for a in $APPS; do
  st=$($D inspect "$a" --format '{{.State.Status}} restarty={{.RestartCount}}')
  L=$($D inspect "$a" --format '{{.LogPath}}')
  bad=$(tr -d '\000' < "$L" | awk -v s="$START" 'index($0,"\"time\":\"")>0 { t=substr($0, index($0,"\"time\":\"")+8, 19); if (t>=s) print }' | grep -ciE 'password authentication failed|28P01' || true)
  echo "  $a: $st, chyb autentizace po restartu: $bad"
  case "$st" in running*) ;; *) fail=1;; esac
  [ "$bad" = 0 ] || fail=1
done
echo "  spojení roundnet teď: $(q -d postgres -tAc "SELECT coalesce(string_agg(datname||'('||client_addr::text||')', ', '),'žádná') FROM pg_stat_activity WHERE usename='roundnet' AND client_addr IS NOT NULL")"
[ $fail = 0 ] || { rollback; exit 1; }
echo "✅ ROTACE roundnet HOTOVÁ — zálohy *.pre-rotace-$TS (obsahují staré heslo, po ověření smazat)"
