#!/bin/sh
# Zneplatní uniklý GITEA_TOKEN (admin olsanvit, scope all): smaže řádek access_token v DB gitea (pg16,
# podle token_last_eight), restartuje Giteu (drží ověřené tokeny v paměti) a odstraní GITEA_TOKEN z compose —
# qnap-game-mcp ho nepoužívá. PROVEDENO 2026-09-16 13:06. Spuštění: scp do secrets/ a `sh <soubor>`.
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
CD=/share/Container/mcp-qnap; C=$CD/docker-compose.yml; SEC=$CD/secrets
TS=$(date +%Y%m%d-%H%M%S); umask 077
q() { $D exec pg16 psql -U roundnet -d gitea -v ON_ERROR_STOP=1 -tA "$@" </dev/null; }
tok=$(sed -nE 's#^[[:space:]]*GITEA_TOKEN:[[:space:]]*"?([^"[:space:]]+)"?.*#\1#p' "$C" | head -1)
[ ${#tok} = 40 ] || { echo "❌ token v compose nenalezen — stop"; exit 1; }
last8=$(printf '%s' "$tok" | tail -c 8)
api() { cfg=$SEC/.g.$$; printf 'header = "Authorization: token %s"\n' "$tok" > "$cfg"; c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -K "$cfg" http://192.168.60.221:3001/api/v1/user || true); rm -f "$cfg"; echo "$c"; }

# 1) databáze Gitea je v pg16?
[ "$(q -c "SELECT 1 FROM pg_database WHERE datname='gitea'" -d postgres 2>/dev/null)" = 1 ] || { echo "❌ DB gitea v pg16 není — stop"; exit 1; }
rows=$(q -c "SELECT count(*) FROM access_token WHERE token_last_eight='$last8'")
[ "$rows" = 1 ] || { echo "❌ tokenů s touto koncovkou: $rows (čekám 1) — stop"; exit 1; }
info=$(q -c "SELECT t.id||'|'||u.lower_name||'|'||t.name||'|'||coalesce(t.scope,'') FROM access_token t JOIN \"user\" u ON u.id=t.uid WHERE t.token_last_eight='$last8'")
id=${info%%|*}; rest=${info#*|}; user=${rest%%|*}
echo "✓ token nalezen: id=$id uživatel=$user název='$(echo "$rest" | cut -d'|' -f2)' scope='$(echo "$rest" | cut -d'|' -f3)'"
[ "$user" = olsanvit ] || { echo "❌ neočekávaný vlastník — stop"; exit 1; }
echo "  API se starým tokenem před: $(api)"

# 2) záloha řádku (jen hash, ne token) a smazání
q -c "SELECT row_to_json(t) FROM access_token t WHERE id=$id" > "$SEC/gitea-access-token-$id-$TS.json"
q -c "DELETE FROM access_token WHERE id=$id" >/dev/null
[ "$(q -c "SELECT count(*) FROM access_token WHERE id=$id")" = 0 ] || { echo "❌ smazání"; exit 1; }
echo "✓ token smazán z DB (záloha řádku: gitea-access-token-$id-$TS.json)"

# 3) Gitea drží úspěšná ověření v paměti → restart
$D restart gitea >/dev/null </dev/null
i=0; while [ $i -lt 24 ]; do c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://192.168.60.221:3001/api/healthz || true); [ "$c" = 200 ] && break; i=$((i+1)); sleep 5; done
echo "✓ Gitea restartována (healthz $c)"
a=$(api); echo "  API se starým tokenem po: $a"
[ "$a" = 401 ] || { echo "❌ starý token pořád neodmítnut"; exit 1; }

# 4) GITEA_TOKEN z compose pryč (kód ho nepoužívá) + nové vytvoření qnap-game-mcp
cp "$C" "$CD/docker-compose.yml.pre-giteatoken-$TS"; chmod 600 "$CD/docker-compose.yml.pre-giteatoken-$TS"
sed -i '/^[[:space:]]*GITEA_TOKEN:/d' "$C"
[ "$(grep -c 'GITEA_TOKEN' "$C")" = 0 ] || { echo "❌ úprava compose"; exit 1; }
(cd "$CD" && $D compose config --services >/dev/null 2>&1 </dev/null) || { cp "$CD/docker-compose.yml.pre-giteatoken-$TS" "$C"; echo "❌ compose config — vráceno"; exit 1; }
(cd "$CD" && $D compose up -d --no-deps --force-recreate mcp >/dev/null 2>&1 </dev/null)
ok=0; i=0; while [ $i -lt 12 ]; do case "$(curl -s --max-time 5 http://127.0.0.1:3000/health)" in *'"db":"ok"'*) ok=1; break;; esac; i=$((i+1)); sleep 5; done
[ $ok = 1 ] || { cp "$CD/docker-compose.yml.pre-giteatoken-$TS" "$C"; (cd "$CD" && $D compose up -d --no-deps --force-recreate mcp >/dev/null 2>&1 </dev/null); echo "❌ /health — compose vrácen"; exit 1; }
echo "✓ qnap-game-mcp znovu vytvořen bez GITEA_TOKEN, /health db ok"
echo "  GITEA_TOKEN v env kontejneru: $($D inspect qnap-game-mcp --format '{{range .Config.Env}}{{println .}}{{end}}' </dev/null | grep -c '^GITEA_TOKEN=')"
sleep 40
echo "  docker health: $($D inspect qnap-game-mcp --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' </dev/null)"
echo "✅ GITEA_TOKEN zneplatněn a odstraněn"
