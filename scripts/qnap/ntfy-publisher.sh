#!/bin/sh
# Vytvoří v ntfy uživatele publisher (write-only) + token. PROVEDENO 2026-09-16.
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
SEC=/share/Container/mcp-qnap/secrets; umask 077
OUT=$SEC/ntfy-publisher.env
[ -e "$OUT" ] && { echo "❌ $OUT už existuje — stop"; exit 1; }
$D exec ntfy ntfy user list </dev/null 2>&1 | grep -q '^user publisher ' && { echo "❌ uživatel publisher už existuje — stop"; exit 1; }
PW=$(openssl rand -base64 30 | tr -d '/+=\n' | cut -c1-32); [ ${#PW} -eq 32 ] || exit 1
printf '%s\n' "$PW" | $D exec -i ntfy sh -c 'read -r NTFY_PASSWORD; export NTFY_PASSWORD; ntfy user add --role=user publisher' >/dev/null 2>&1
$D exec ntfy ntfy access publisher '*' write-only </dev/null >/dev/null 2>&1
TOK=$($D exec ntfy ntfy token add publisher </dev/null 2>&1 | grep -oE 'tk_[A-Za-z0-9]+' | head -1)
[ -n "$TOK" ] || { echo "❌ token nevytvořen"; exit 1; }
printf 'NTFY_USER=publisher\nNTFY_PASS=%s\nNTFY_TOKEN=%s\n' "$PW" "$TOK" > "$OUT"; chmod 600 "$OUT"
echo "✓ uživatel publisher vytvořen, token vytvořen, údaje v $OUT"
$D exec ntfy ntfy user list </dev/null 2>&1 | sed -n '/^user publisher/,/^user /p' | grep -v '^user [^p]' | sed 's/^/  /'
cfg=$SEC/.n.$$
printf 'user = "publisher:%s"\n' "$PW" > "$cfg"
echo "  /v1/account publisher (heslo): HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -K "$cfg" http://127.0.0.1:8225/v1/account)"
printf 'header = "Authorization: Bearer %s"\n' "$TOK" > "$cfg"
echo "  /v1/account publisher (token): HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -K "$cfg" http://127.0.0.1:8225/v1/account)"
printf 'user = "publisher:%s"\n' "$PW" > "$cfg"
echo "  čtení tématu qnap-alerts jako publisher (má být 403): HTTP $(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -K "$cfg" 'http://127.0.0.1:8225/qnap-alerts/json?poll=1')"
rm -f "$cfg"
