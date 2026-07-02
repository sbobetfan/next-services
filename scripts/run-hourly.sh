#!/bin/bash
# run-hourly.sh — runs the fuel price update and pushes to GitHub.
# Called by launchd on macOS (or cron on Linux).

set -euo pipefail

# Note: `git push` needs SSH or a stored credential.
# On macOS, the keychain usually handles this if you've pushed before.
HEALTHCHECK_URL="https://hc-ping.com/2cecc532-df80-48a2-82a8-50dc9aa4333d"

trap 'curl -fsS --retry 3 "$HEALTHCHECK_URL/fail" > /dev/null 2>&1; exit 1' ERR

# Move to the scripts directory. All paths are relative to this location.
cd "$(dirname "$0")"

# Log everything to a rolling log file so we can debug when things break.
LOG_FILE="$HOME/next-services-pipeline.log"
exec > >(tee -a "$LOG_FILE") 2>&1

echo ""
echo "=== Run at $(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="

# Update prices — this generates ../data/fuel-prices.json
npm run update-prices

# Stage, commit, and push (only if the JSON actually changed)
cd ..
git add data/fuel-prices.json

if git diff --staged --quiet; then
  echo "No changes to fuel-prices.json — skipping commit."
  exit 0
fi

git -c user.email="fuel-bot@martinjohnston.local" \
    -c user.name="fuel-bot" \
    commit -m "chore: update fuel prices"

if git push; then
  echo "Pushed at $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  osascript -e 'display notification "Fuel prices updated" with title "Next Services"' 2>/dev/null || true
  curl -fsS --retry 3 "$HEALTHCHECK_URL" > /dev/null
else
  echo "❌ Push failed at $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  osascript -e 'display notification "Push failed — check logs" with title "Next Services" sound name "Basso"' 2>/dev/null || true
  curl -fsS --retry 3 "$HEALTHCHECK_URL/fail" > /dev/null
fi