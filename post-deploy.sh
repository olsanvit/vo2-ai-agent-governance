#!/bin/bash
# post-deploy.sh — spouštěj po každém git pull na QNAP
# Regeneruje audit-report.html do wwwroot VO2DataManager
#
# Použití (např. v deploy skriptu nebo git hook):
#   bash /opt/vo2-ai-agent-governance/post-deploy.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VO2_WWWROOT="/opt/VO2DataManager/src/VO2DataManager.Web/wwwroot"

python3 "$SCRIPT_DIR/audit-generator.py" --output "$VO2_WWWROOT/audit-report.html"
echo "Audit report regenerován: $VO2_WWWROOT/audit-report.html"
