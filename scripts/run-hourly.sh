#!/bin/bash
# run-hourly.sh — runs the fuel price update and uploads to Cloudflare R2.
# Called by launchd on macOS (or cron on Linux).

set -euo pipefail

# launchd runs with a minimal PATH that misses Homebrew, where node and
# rclone live.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

HEALTHCHECK_URL="https://hc-ping.com/2cecc532-df80-48a2-82a8-50dc9aa4333d"

# On any failure, ping healthchecks.io/fail so we get an email alert.
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

cd ..

# Upload to R2 only if the JSON actually changed. update-prices.mjs reuses
# the previous timestamp when prices are unchanged, so a byte-compare against
# the last uploaded copy is a reliable no-change check.
MARKER="data/.last-uploaded-fuel-prices.json"

if [ -f "$MARKER" ] && cmp -s data/fuel-prices.json "$MARKER"; then
  echo "No changes to fuel-prices.json — skipping upload."
  osascript -e 'display notification "No price changes this hour" with title "Next Services"' 2>/dev/null || true
  curl -fsS --retry 3 "$HEALTHCHECK_URL" > /dev/null
  exit 0
fi

if rclone copyto data/fuel-prices.json r2:next-services-data/fuel-prices.json \
    --header-upload "Cache-Control: public, max-age=300"; then
  cp data/fuel-prices.json "$MARKER"
  echo "Uploaded to R2 at $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  osascript -e 'display notification "Fuel prices updated" with title "Next Services"' 2>/dev/null || true
  curl -fsS --retry 3 "$HEALTHCHECK_URL" > /dev/null
else
  echo "❌ Upload failed at $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  osascript -e 'display notification "Upload failed — check logs" with title "Next Services" sound name "Basso"' 2>/dev/null || true
  curl -fsS --retry 3 "$HEALTHCHECK_URL/fail" > /dev/null
fi