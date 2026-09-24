#!/bin/sh
# Fáze 1 odstranění trust z pg_hba: pro každou roli pravidlo md5 (Docker sítě + IP QNAPu) a ověření
# všech hesel, která pro roli existují v konfiguracích. Pravidlo zůstane jen když projdou všechna.
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
CD=/share/Container/mcp-qnap; SEC=$CD/secrets
HBA=/share/Container/postgres/data/pg_hba.conf
TS=$(date +%Y%m%d-%H%M%S); umask 077
W=$SEC/hba-work-$TS; mkdir "$W"; trap 'rm -rf "$W"' EXIT
q() { $D exec pg16 psql -U roundnet -d postgres -v ON_ERROR_STOP=1 -tA -c "$1" </dev/null; }
cp -p "$HBA" "$SEC/pg_hba.conf.pre-md5-$TS"; chmod 600 "$SEC/pg_hba.conf.pre-md5-$TS"
reload() {
  q "SELECT pg_reload_conf()" >/dev/null; sleep 1
  [ "$(q "SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL")" = 0 ] || {
    echo "❌ chyba v pg_hba — obnovuji zálohu"; cat "$SEC/pg_hba.conf.pre-md5-$TS" > "$HBA"; q "SELECT pg_reload_conf()" >/dev/null; exit 1; }
}
C=$W/creds
# heslo v URL může být zakódované procentovým zápisem — pro test přihlášení je nutné ho dekódovat
urldec() { awk -v s="$1" 'BEGIN{ for(i=1;i<=length(s);i++){ ch=substr(s,i,1);
  if (ch=="%" && i+2<=length(s)) { printf "%c", hex(substr(s,i+1,2)); i+=2 } else printf "%s", ch } }
  function hex(h,  n,i2,c,v){ n=0; for(i2=1;i2<=2;i2++){ c=toupper(substr(h,i2,1)); v=index("0123456789ABCDEF",c)-1; n=n*16+v } return n }'; }
url() {
  line=$(printf '%s\n' "$2" | sed -nE "s#^postgres(ql)?://([^:]+):([^@]*)@[^/]+/([^?]+).*#\2|\4|\3#p")
  [ -n "$line" ] || return 0
  u=${line%%|*}; r=${line#*|}; db=${r%%|*}; pw=${r#*|}
  printf '%s|%s|%s|%s\n' "$u" "$db" "$1" "$(urldec "$pw")"
}
envv() { sed -n "s/^$2=//p" "$1" | head -1; }
printf 'AgentAI|AIData|.env|%s\n' "$(envv $CD/.env AGENT_DB_PASSWORD)" >> "$C"
printf 'mcp_sr_usr|SportReal|.env|%s\n' "$(envv $CD/.env MCP_SR_DB_PASSWORD)" >> "$C"
url mcp-usm.env "$(envv $SEC/mcp-usm.env DATABASE_URL)" >> "$C"
url qnap-te-mcp.env "$(envv $SEC/qnap-te-mcp.env DATABASE_URL)" >> "$C"
url mcp-mab.env "$(envv $SEC/mcp-mab.env DATABASE_URL)" >> "$C"
url mcp-mab.env:MON "$(envv $SEC/mcp-mab.env AGENT_MONITOR_URL)" >> "$C"
url mcp-usm.env:MON "$(envv $SEC/mcp-usm.env AGENT_MONITOR_URL)" >> "$C"
printf 'roundnet|postgres|roundnet.pw|%s\n' "$(head -1 $SEC/roundnet.pw)" >> "$C"
printf 'n8nuser|n8n|n8nuser.pw|%s\n' "$(head -1 $SEC/n8nuser.pw)" >> "$C"
for f in /share/Public/*/publish/appsettings.Production.json /share/Public/*/appsettings.Production.json; do
  [ -f "$f" ] || continue
  app=$(echo "$f" | cut -d/ -f4)
  grep -oE '"[A-Za-z0-9]+": *"Host=[^"]*"' "$f" | cut -d'"' -f4 | while IFS= read -r v; do
    h=$(echo "$v" | grep -oiE 'Host=[^;]*' | cut -d= -f2)
    case "$h" in pg16|192.168.60.221|127.0.0.1|localhost) ;; *) continue;; esac
    u=$(echo "$v" | grep -oiE '(Username|User Id)=[^;]*' | cut -d= -f2)
    d=$(echo "$v" | grep -oiE 'Database=[^;]*' | cut -d= -f2)
    p=$(echo "$v" | grep -oiE 'Password=[^;]*' | cut -d= -f2-)
    printf '%s|%s|%s|%s\n' "$u" "$d" "$app" "$p"
  done >> "$C"
done
sort -u "$C" -o "$C"
echo "✓ nasbíráno $(wc -l < "$C") kombinací role/DB/zdroj"
test_login() {
  printf 'PGPASSWORD=%s\nPGCONNECT_TIMEOUT=8\n' "$3" > "$W/pgenv"
  r=$($D run --rm --network appnet --env-file "$W/pgenv" postgres:16 psql -h pg16 -U "$1" -d "$2" -tAc 'select 1' </dev/null 2>&1 || true)
  rm -f "$W/pgenv"; [ "$r" = 1 ]
}
add_rule() {
  awk -v r="$1" 'BEGIN{d=0} /^host/ && !d { print "host all " r " 172.16.0.0/12 md5 # gov-md5"; print "host all " r " 192.168.60.221/32 md5 # gov-md5"; d=1 } { print }' "$HBA" > "$W/hba"
  cat "$W/hba" > "$HBA"; reload
}
del_rule() {
  grep -vE "^host all $1 (172\.16\.0\.0/12|192\.168\.60\.221/32) md5 # gov-md5$" "$HBA" > "$W/hba" || true
  cat "$W/hba" > "$HBA"; reload
}
echo "=== výsledky ==="
for role in $(cut -d'|' -f1 "$C" | sort -u); do
  [ -n "$role" ] || continue
  [ "$(q "SELECT count(*) FROM pg_roles WHERE rolname='$role'")" = 1 ] || { echo "  ⚠️ $role: role neexistuje"; continue; }
  grep -q "^host all $role 172.16.0.0/12 md5 # gov-md5" "$HBA" && { echo "  = $role: pravidlo už existuje"; continue; }
  add_rule "$role"
  ok=1; detail=""
  while IFS='|' read -r r db src pw; do
    [ "$r" = "$role" ] || continue
    if test_login "$r" "$db" "$pw"; then detail="$detail ✓$src/$db"; else detail="$detail ✗$src/$db"; ok=0; fi
  done < "$C"
  if [ $ok = 1 ]; then echo "  ✅ $role:$detail"; else del_rule "$role"; echo "  ❌ $role: pravidlo odebráno —$detail"; fi
done
echo "=== pravidel gov-md5: $(grep -c '# gov-md5' "$HBA") (záloha pg_hba.conf.pre-md5-$TS) ==="
