#!/usr/bin/env bash
# Odmítne literální hesla a tokeny v trackovaných souborech.
#
# PROČ: repo je public a historie už jednou musela být přepsána, protože hodnoty byly
# zapsané přímo (docker-compose patch, deploy poznámky, fallback v server.js).
# Povolené jsou jen odkazy: ${PROMĚNNÁ}, process.env.X, <placeholder>, {PLACEHOLDER}.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)"

# Vzory, u kterých řádek s process.env / ${…} znamená bezpečný odkaz → takové řádky se vyřadí
REF_PATTERNS=(
  'postgres(ql)?://[A-Za-z0-9_]+:[^@[:space:]$<{"]+@'
  '(AUTH_TOKEN|GITEA_TOKEN|API_KEY|SECRET_KEY|ACCESS_TOKEN)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?[A-Za-z0-9!_-]{12,}'
  '[Pp]assword=[^;"[:space:]$<{]{6,}'
  'Authorization: Basic [A-Za-z0-9+/]{16,}={0,2}'
  'Bearer [A-Za-z0-9._!-]{16,}'
)
# Fallback za proměnnou prostředí: process.env na řádku je tu naopak znak úniku
# (historicky: process.env.AUTH_TOKEN || "<token>"), proto se nevyřazuje.
# Omezeno na názvy typu token/heslo/klíč — obyčejné výchozí hodnoty (mode || "safe_mode") projdou.
FALLBACK_PATTERN='(TOKEN|SECRET|PASSWORD|PASSWD|PASS|API_?KEY|AUTH)[A-Za-z0-9_]*[[:space:]]*\|\|[[:space:]]*["'"'"'][^"'"'"'$<{[:space:]]{6,}["'"'"']'

fail=0
# Bez roury: funkce volaná přes | běží v podshellu a fail=1 by se ztratilo (skript by vždy prošel)
report() { fail=1; echo "❌ vzor: $1"; sed -E 's/(:[0-9]+:).*/\1 «řádek skryt»/; s/^/   /' <<< "$2"; }

for pat in "${REF_PATTERNS[@]}"; do
  hits=$(git grep -nIE "$pat" -- . ':!scripts/check-secrets.sh' 2>/dev/null \
         | grep -vE 'process\.env|\$\{|YOUR_|REDACTED|\*\*\*REMOVED\*\*\*' || true)
  [ -n "$hits" ] && report "$pat" "$hits"
done
hits=$(git grep -nIE "$FALLBACK_PATTERN" -- . ':!scripts/check-secrets.sh' 2>/dev/null \
       | grep -vE 'REDACTED|\*\*\*REMOVED\*\*\*' || true)
[ -n "$hits" ] && report "fallback tajemství za ||" "$hits"

[ $fail -eq 0 ] && echo "✅ žádné literální hodnoty tajemství" || { echo "Nahraď hodnotu za \${PROMĚNNÁ} — repo je public."; exit 1; }
