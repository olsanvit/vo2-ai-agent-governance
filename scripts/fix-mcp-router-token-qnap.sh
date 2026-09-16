#!/bin/sh
# mcp-router (nginx): v map $http_authorization nahradí starý token za MCP_AUTH_TOKEN z .env
# a z log_format odstraní hlavičku Authorization (logovala token v čitelné podobě). PROVEDENO 2026-09-16.
# Soubor je do kontejneru připojený jednotlivě → přepis na místě (stejný inode), jinak ho nginx neuvidí.
# Spuštění: scp do /share/Container/mcp-qnap/secrets/ a tam `sh <soubor>`.
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
CD=/share/Container/mcp-qnap; SEC=$CD/secrets
N=/share/Container/mcp-router/nginx.conf
TS=$(date +%Y%m%d-%H%M%S); BAK=$SEC/nginx.conf.pre-token-$TS
umask 077
old=$(sed -nE 's#^[[:space:]]*AUTH_TOKEN:[[:space:]]*"?([^"[:space:]]+)"?.*#\1#p' $CD/docker-compose.yml.bak-20260806091024 | head -1)
new=$(sed -n 's/^MCP_AUTH_TOKEN=//p' $CD/.env)
case "$old$new" in *[!A-Za-z0-9]*|'') echo "❌ tokeny nejsou alfanumerické — stop"; exit 1;; esac
[ "$(grep -cF "\"Bearer $old\" 1;" $N)" = 1 ] || { echo "❌ map neobsahuje právě jeden starý token — stop"; exit 1; }
[ "$(grep -c 'auth="$http_authorization"' $N)" = 1 ] || { echo "❌ log_format nemá očekávaný tvar — stop"; exit 1; }

code() { # $1 = cesta, $2 = token
  cfg=$SEC/.c.$$; printf 'header = "Authorization: Bearer %s"\n' "$2" > "$cfg"
  c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -K "$cfg" -X POST -H 'Content-Type: application/json' \
      -H 'Accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "http://127.0.0.1:3002$1" || true)
  rm -f "$cfg"; echo "$c"
}
echo "  před: /AI nový=$(code /AI "$new") starý=$(code /AI "$old")"

cp -p "$N" "$BAK"; chmod 600 "$BAK"
sed -e "s#\"Bearer $old\" 1;#\"Bearer $new\" 1;#" -e 's# auth="$http_authorization"##' "$BAK" > "$SEC/nginx.conf.new.$TS"
[ "$(grep -cF "$new" "$SEC/nginx.conf.new.$TS")" = 1 ] && [ "$(grep -cF "$old" "$SEC/nginx.conf.new.$TS")" = 0 ] \
  && [ "$(grep -c 'http_authorization"' "$SEC/nginx.conf.new.$TS")" = 0 ] || { echo "❌ příprava nového souboru"; rm -f "$SEC/nginx.conf.new.$TS"; exit 1; }
[ "$(wc -l < "$BAK")" = "$(wc -l < "$SEC/nginx.conf.new.$TS")" ] && [ "$(awk 'NR==FNR{a[FNR]=$0; next} a[FNR]!=$0{n++} END{print n+0}' "$BAK" "$SEC/nginx.conf.new.$TS")" = 2 ] || { echo "❌ změnilo by se víc než 2 řádky"; rm -f "$SEC/nginx.conf.new.$TS"; exit 1; }

restore() { cat "$BAK" > "$N"; $D exec mcp-router nginx -s reload </dev/null >/dev/null 2>&1 || true; echo "↩ nginx.conf vrácen a načten"; }
ino=$(stat -c %i "$N")
cat "$SEC/nginx.conf.new.$TS" > "$N"; rm -f "$SEC/nginx.conf.new.$TS"
chmod 600 "$N"
[ "$(stat -c %i "$N")" = "$ino" ] || { echo "❌ změnil se inode"; restore; exit 1; }
[ "$($D exec mcp-router grep -c "$new" /etc/nginx/nginx.conf </dev/null)" = 1 ] || { echo "❌ kontejner nevidí novou verzi"; restore; exit 1; }
$D exec mcp-router nginx -t </dev/null >/dev/null 2>&1 || { echo "❌ nginx -t"; restore; exit 1; }
$D exec mcp-router nginx -s reload </dev/null >/dev/null 2>&1 || { echo "❌ reload"; restore; exit 1; }
sleep 3
echo "✓ nginx.conf aktualizován (inode zachován, práva 600), nginx -t OK, reload OK"

fail=0
for r in AI TE USM MAB SR; do
  n=$(code /$r "$new"); o=$(code /$r "$old")
  echo "  /$r: nový=$n starý=$o"
  [ "$n" = 200 ] || fail=1
  [ "$o" = 401 ] || fail=1
done
[ $fail = 0 ] || { restore; exit 1; }
echo "✓ router přijímá nový token a odmítá starý"

# logy: nové řádky už hlavičku neobsahují → staré záznamy s tokeny odstranit
L=$($D inspect mcp-router --format '{{.LogPath}}' </dev/null)
before=$(tr -d '\000' < "$L" | tail -5 | grep -c 'auth=' || true)
: > "$L"; rm -f "$L.1" "$L.2"
echo "✓ logy routeru vyčištěny (aktuální zkrácen, .1 a .2 smazány)"
for f in /share/Container/mcp-router/nginx.conf.bak /share/Container/mcp-router/nginx.conf.bak-20260901; do
  [ -f "$f" ] && chmod 600 "$f" && echo "  $(basename "$f"): starý token $(grep -cF "$old" "$f")× → práva 600"
done
sleep 5
echo "  nové řádky logu s auth=: $(tr -d '\000' < "$L" | grep -c 'auth=' || true)"
echo "✅ HOTOVO (záloha $(basename "$BAK"))"
