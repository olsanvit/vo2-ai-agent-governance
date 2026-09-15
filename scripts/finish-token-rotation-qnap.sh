#!/bin/sh
# Dokončení rotace MCP_AUTH_TOKEN a hesla AgentAI pro kontejnery vytvořené přes `docker run`.
# Spouštět z Macu:  ssh -i ~/.ssh/claude-qnap admin@192.168.60.221 'sh -s' < scripts/finish-token-rotation-qnap.sh
#
# PROČ: 2026-09-15 dostaly nové hodnoty z /share/Container/mcp-qnap/.env jen compose služby
# (qnap-game-mcp, mcp-sportreal). Kontejnery z `docker run` mají env zapečené při vytvoření, takže
# dál běží se starým (uniklým) tokenem a ten tím pořád platí. Env nejde změnit za běhu — kontejner
# se musí vytvořit znovu se stejnými parametry.
#
# Pojistky:
#  - image se bere podle ID starého kontejneru, ne podle tagu (tag mezitím mohl ukazovat jinam)
#  - starý kontejner se jen přejmenuje na <název>-prerot a zastaví; při selhání se vrací zpět
#  - env jde do secrets/<název>.env (600) — hodnoty nejsou v argumentech procesů ani ve výpisu
#  - staré kontejnery (drží starý token) se mažou až po úspěchu všech
#  - NTFY_PASS se nemění: heslo admina ntfy zatím rotované není
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
CD=/share/Container/mcp-qnap
SEC=$CD/secrets
umask 077

NEW_TOK=$(sed -n 's/^MCP_AUTH_TOKEN=//p' "$CD/.env" | head -1)
NEW_PW=$(sed -n 's/^AGENT_DB_PASSWORD=//p' "$CD/.env" | head -1)
[ -n "$NEW_TOK" ] && [ -n "$NEW_PW" ] || { echo "❌ v .env chybí MCP_AUTH_TOKEN nebo AGENT_DB_PASSWORD — stop"; exit 1; }
case "$NEW_TOK" in *[!A-Za-z0-9]*) echo "❌ token obsahuje nečekané znaky — stop"; exit 1;; esac
# Heslo jde do DSN v uvozovkách — apostrof, zpětné lomítko nebo nový řádek by ho rozbily
case "$NEW_PW" in *"'"*|*'\'*) echo "❌ heslo obsahuje ' nebo \\ — stop"; exit 1;; esac
for c in vin-importer qnap-te-mcp mcp-usm mcp-mab mcp-oauth; do
  $D inspect "$c" >/dev/null 2>&1 || { echo "❌ kontejner $c neexistuje — stop"; exit 1; }
  $D inspect "$c-prerot" >/dev/null 2>&1 && { echo "❌ $c-prerot už existuje — stop"; exit 1; }
done
mkdir -p "$SEC"; chmod 700 "$SEC"

h() { printf '%s' "$1" | md5sum | cut -c1-32; }

# Env starého kontejneru → soubor; nahradí jen zadaný klíč. Víceřádkové hodnoty env-file neumí.
dump_env() { # $1=kontejner $2=klíč $3=nová hodnota $4=soubor
  n=$($D inspect "$1" --format '{{range .Config.Env}}{{$p := split . "\n"}}{{if gt (len $p) 1}}x{{end}}{{end}}')
  [ -z "$n" ] || { echo "❌ $1 má víceřádkovou env hodnotu — env-file by ji rozbil"; return 1; }
  $D inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^$' | grep -v "^$2=" > "$4" || true
  printf '%s=%s\n' "$2" "$3" >> "$4"
  chmod 600 "$4"
}

health_ok() { # $1=port $2=vzor v těle
  i=0; while [ $i -lt 12 ]; do
    case "$(curl -s --max-time 5 "http://127.0.0.1:$1/health" || true)" in *$2*) return 0;; esac
    i=$((i+1)); sleep 5
  done; return 1
}

swap() { # $1=kontejner, zbytek = parametry docker run (bez --name a env)
  c=$1; shift
  img=$($D inspect "$c" --format '{{.Image}}')
  $D rename "$c" "$c-prerot"
  $D stop "$c-prerot" >/dev/null 2>&1 || true
  if $D run -d --name "$c" --env-file "$SEC/$c.env" \
       --log-driver json-file --log-opt max-file=10 --log-opt max-size=10m "$@" "$img" $CMD >/dev/null; then
    return 0
  fi
  echo "❌ docker run $c selhal"; return 1
}

rollback() { # $1=kontejner
  c=$1
  $D rm -f "$c" >/dev/null 2>&1 || true
  $D rename "$c-prerot" "$c" && $D start "$c" >/dev/null && echo "↩ $c vrácen na původní kontejner"
}

done_list=""

# ── vin-importer: nové heslo AgentAI, DSN v klíčovém tvaru (heslo nemusí být URL-safe) ──
c=vin-importer
dump_env "$c" DB_CONN "host=127.0.0.1 port=5432 dbname=AIData user=AgentAI password='$NEW_PW'" "$SEC/$c.env"
CMD="python importer.py import"
swap "$c" --network host --restart unless-stopped -m 268435456 -w /app \
  -v /share/CACHEDEV1_DATA/homes/admin/vin-imports:/data/vin-imports || { rollback "$c"; exit 1; }
sleep 5
if $D exec "$c" python -c "import os,psycopg2; psycopg2.connect(os.environ['DB_CONN']).close(); print('ok')" 2>/dev/null | grep -qx ok; then
  echo "✓ $c: přihlášení do AIData novým heslem OK"; done_list="$done_list $c"
else
  echo "❌ $c: přihlášení selhalo"; rollback "$c"; exit 1
fi

# ── MCP servery: nový AUTH_TOKEN ──
c=qnap-te-mcp
dump_env "$c" AUTH_TOKEN "$NEW_TOK" "$SEC/$c.env"
CMD="node server.js"
swap "$c" --network host --restart unless-stopped -w /app --entrypoint docker-entrypoint.sh \
  -v /share/Container/mcp-qnap/service-account.json:/app/service-account.json:ro \
  -v /share/Container/mcp-image/uploads-te:/app/uploads \
  --health-cmd 'wget -qO- http://localhost:${PORT}/ping || exit 1' \
  --health-interval 30s --health-timeout 5s --health-start-period 15s --health-retries 3 || { rollback "$c"; exit 1; }
health_ok 3003 '"db":"ok"' && { echo "✓ $c: /health db ok"; done_list="$done_list $c"; } || { echo "❌ $c: /health"; rollback "$c"; exit 1; }

c=mcp-usm
dump_env "$c" AUTH_TOKEN "$NEW_TOK" "$SEC/$c.env"
CMD="mcp-usm.js"
swap "$c" --network host --restart unless-stopped -w /app --entrypoint node \
  -v /share/Container/mcp-image:/app || { rollback "$c"; exit 1; }
health_ok 3006 '"db":"ok"' && { echo "✓ $c: /health db ok"; done_list="$done_list $c"; } || { echo "❌ $c: /health"; rollback "$c"; exit 1; }

c=mcp-mab
dump_env "$c" AUTH_TOKEN "$NEW_TOK" "$SEC/$c.env"
CMD="mcp-mab.js"
swap "$c" --network host --restart unless-stopped -m 268435456 -w /app --entrypoint node \
  -v /share/Container/mcp-image/uploads-mab:/app/uploads || { rollback "$c"; exit 1; }
health_ok 3007 '"db":"ok"' && { echo "✓ $c: /health db ok"; done_list="$done_list $c"; } || { echo "❌ $c: /health"; rollback "$c"; exit 1; }

c=mcp-oauth
dump_env "$c" AUTH_TOKEN "$NEW_TOK" "$SEC/$c.env"
CMD="node server.js"
swap "$c" --network host --restart unless-stopped -m 67108864 -w /app --entrypoint docker-entrypoint.sh || { rollback "$c"; exit 1; }
health_ok 3009 '"status":"ok"' && { echo "✓ $c: /health ok"; done_list="$done_list $c"; } || { echo "❌ $c: /health"; rollback "$c"; exit 1; }

# ── ověření a úklid ──
echo "=== AUTH_TOKEN vs .env ==="
for c in qnap-game-mcp mcp-sportreal mcp-mab mcp-usm qnap-te-mcp mcp-oauth; do
  t=$($D inspect "$c" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^AUTH_TOKEN=//p')
  [ "$(h "$t")" = "$(h "$NEW_TOK")" ] && echo "  ✓ $c" || echo "  ✗ $c"
done
for c in $done_list; do $D rm -f "$c-prerot" >/dev/null && echo "  smazán $c-prerot (držel starou hodnotu)"; done
echo "✅ HOTOVO:$done_list"
