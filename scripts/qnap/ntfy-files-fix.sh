#!/bin/sh
# Nahradí starou hodnotu v souborech na QNAPu: AUTH_TOKEN → MCP_AUTH_TOKEN, ntfy → publisher. PROVEDENO 2026-09-16.
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
CD=/share/Container/mcp-qnap; SEC=$CD/secrets
TS=$(date +%Y%m%d-%H%M%S); B=$SEC/files-backup-$TS; umask 077; mkdir "$B"
old=$(sed -nE 's#^[[:space:]]*AUTH_TOKEN:[[:space:]]*"?([^"[:space:]]+)"?.*#\1#p' $CD/docker-compose.yml.bak-20260806091024 | head -1)
newtok=$(sed -n 's/^MCP_AUTH_TOKEN=//p' $CD/.env)
pub=$(sed -n 's/^NTFY_PASS=//p' $SEC/ntfy-publisher.env)
ptok=$(sed -n 's/^NTFY_TOKEN=//p' $SEC/ntfy-publisher.env)
b_old=$(printf 'admin:%s' "$old" | base64 | tr -d '\n')
b_new=$(printf 'publisher:%s' "$pub" | base64 | tr -d '\n')
for v in "$old" "$newtok" "$pub" "$ptok"; do case "$v" in ''|*[!A-Za-z0-9_]*) echo "❌ neočekávaný formát hodnoty — stop"; exit 1;; esac; done

FILES="/share/Container/deploy/deploy.sh
/share/Container/mcp-image/deploy-image-mcps.sh
/share/Container/mcp-image/mcp-health-check.sh
/share/Container/mcp-oauth/docker-compose.yml
/share/Container/mcp-qnap/deploy.sh
/share/Container/mcp-qnap/qnap-monitor.sh
/share/Container/mcp-qnap/zabbix-full-setup.sh
/share/Container/mcp-qnap/zabbix-ntfy-mediatype.xml
/share/Container/vo2status/docker-compose.yml
/share/CACHEDEV1_DATA/Public/Metin2Bausia/docker-compose.yml
/share/CACHEDEV1_DATA/Public/mcp/docker-compose.yml
/share/Container/diun/diun.yml
$SEC/mcp-mab.env
$SEC/mcp-usm.env
$SEC/qnap-te-mcp.env"

for f in $FILES; do
  [ -f "$f" ] || { echo "❌ chybí $f"; exit 1; }
  cp -p "$f" "$B/$(echo "$f" | tr '/' '_')"
  t="$B/.tmp"
  case "$f" in
    */diun.yml)
      sed "s#$old#$ptok#g" "$f" > "$t";;
    *.xml)
      # hodnota za <name>NTFY_USER</name> je na dalším řádku
      awk -v o="$old" -v p="$pub" '{ if (u && $0 ~ /<value>admin<\/value>/) { sub(/<value>admin<\/value>/, "<value>publisher</value>") } u = ($0 ~ /NTFY_USER/); gsub(o, p); print }' "$f" > "$t";;
    *)
      sed -E \
        -e "/AUTH_TOKEN/s#$old#$newtok#g" \
        -e "s#$b_old#$b_new#g" \
        -e "s#$old#$pub#g" \
        -e "s#(NTFY_USER[\"']?[[:space:]]*[=:][[:space:]]*[\"']?)admin([\"']?)#\1publisher\2#g" \
        "$f" > "$t";;
  esac
  cat "$t" > "$f"; rm -f "$t"    # přepis na místě (bind mounty)
  n=$(( $(grep -cF "$old" "$f" || true) + $(grep -cF "$b_old" "$f" || true) ))
  [ "$n" = 0 ] || { echo "❌ $f: stará hodnota zůstala ($n×) — obnovuji vše"; for g in $FILES; do cat "$B/$(echo "$g" | tr '/' '_')" > "$g"; done; exit 1; }
  printf "  ✓ %-58s ntfy-user=%s token=%s publisher=%s\n" "$f" "$(grep -c 'NTFY_USER.*publisher\|<value>publisher' "$f" || true)" "$(grep -cF "$newtok" "$f" || true)" "$(( $(grep -cF "$pub" "$f" || true) + $(grep -cF "$b_new" "$f" || true) + $(grep -cF "$ptok" "$f" || true) ))"
done
echo "=== kontrola syntaxe ==="
for f in $FILES; do
  case "$f" in
    *.sh) sh -n "$f" && echo "  sh -n OK  $f";;
    *docker-compose.yml) (cd "$(dirname "$f")" && $D compose -f "$f" config --services >/dev/null 2>&1 </dev/null) && echo "  compose OK $f" || echo "  ⚠️ compose config: $f";;
  esac
done
echo "  zbylé NTFY_USER=admin: $(for f in $FILES; do grep -lE "NTFY_USER[\"']?[[:space:]]*[=:][[:space:]]*[\"']?admin" "$f"; done | tr '\n' ' ')"
for f in /share/Container/mcp-qnap/vw-import.py /share/Container/mcp-qnap/vw-import.sh /share/Container/uptime-kuma/fix.py /share/Container/uptime-kuma/ntfy.py /share/Container/uptime-kuma/ntfy2.py /share/Container/uptime-kuma/setup.py; do chmod 600 "$f"; done
chmod 600 $B/*
echo "✓ vw-import.* a uptime-kuma/*.py → práva 600 (obsah beze změny)"
echo "✅ soubory hotové, zálohy v $B"
