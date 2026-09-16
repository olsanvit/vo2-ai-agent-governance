#!/bin/sh
# Spustí docker-clone-with-env.js v pomocném node kontejneru (na QNAPu není node). PROVEDENO 2026-09-16.
# Použití (na QNAPu, soubory v secrets/): sh ntfy-clone-run.sh <kontejner>...
set -eu
D=/share/CACHEDEV1_DATA/.qpkg/container-station/bin/docker
SEC=/share/Container/mcp-qnap/secrets; umask 077
E=$SEC/ntfy-clone.env
sed -n 's/^NTFY_USER=/NTFY_NEW_USER=/p; s/^NTFY_PASS=/NTFY_NEW_PASS=/p' $SEC/ntfy-publisher.env > "$E"
echo "Docker API: $(curl -s --unix-socket /var/run/docker.sock http://localhost/version | grep -oE '"ApiVersion":"[^"]*"')"
rc=0
$D run --rm --network none -v /var/run/docker.sock:/var/run/docker.sock -v $SEC/docker-clone-with-env.js:/clone.js:ro \
  --env-file "$E" --entrypoint node mcp-image-base:latest /clone.js "$@" </dev/null || rc=$?
rm -f "$E"; exit $rc
