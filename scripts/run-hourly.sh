#!/bin/bash
# run-hourly.sh — runs the fuel price update and uploads to Cloudflare R2.
# Called by launchd on macOS (or cron on Linux).

set -euo pipefail

# launchd runs with a minimal PATH that misses Homebrew, where node and
# rclone live.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

HEALTHCHECK_URL="https://hc-ping.com/2cecc532-df80-48a2-82a8-50dc9aa4333d"

# Attempts at the price update within one run, and the pause between them.
UPDATE_ATTEMPTS=3
UPDATE_RETRY_DELAY=120

# Move to the scripts directory. All paths are relative to this location.
cd "$(dirname "$0")"

# Log everything to a rolling log file so we can debug when things break.
LOG_FILE="$HOME/next-services-pipeline.log"
exec > >(tee -a "$LOG_FILE") 2>&1

# A failed run is recorded on healthchecks.io with /log, which shows the
# reason in the check's history without marking it down. If runs keep
# failing, the check goes down by itself once the grace time passes with no
# success ping, so one-off blips no longer send an alert.
record_failure() {
  echo "❌ $1 at $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  osascript -e "display notification \"$1 — check logs\" with title \"Next Services\" sound name \"Basso\"" 2>/dev/null || true
  curl -fsS --retry 3 --data-raw "$1" "$HEALTHCHECK_URL/log" > /dev/null 2>&1 || true
}

record_success() {
  curl -fsS --retry 3 "$HEALTHCHECK_URL" > /dev/null || echo "⚠️ Healthcheck ping failed"
}

# Anything else that fails still ends the run, but is logged, not alerted.
trap 'record_failure "Unexpected error on line $LINENO"; exit 1' ERR

# After waking from sleep, launchd runs a missed job straight away, often
# before Wi-Fi has reconnected. Wait up to 2 minutes for the network.
wait_for_network() {
  for _ in $(seq 1 24); do
    if curl -sS --max-time 5 -o /dev/null https://www.fuel-finder.service.gov.uk 2>/dev/null; then
      return 0
    fi
    sleep 5
  done
  return 1
}

echo ""
echo "=== Run at $(date -u '+%Y-%m-%d %H:%M:%S UTC') ==="

if ! wait_for_network; then
  record_failure "No network after 2 minutes"
  exit 1
fi

# Update prices — this generates ../data/fuel-prices.json. Retried as a whole
# in case Fuel Finder is still failing after update-prices.mjs's own retries.
attempt=1
until npm run update-prices; do
  if [ "$attempt" -ge "$UPDATE_ATTEMPTS" ]; then
    record_failure "Price update failed after $UPDATE_ATTEMPTS attempts"
    exit 1
  fi
  echo "⏳ Price update failed (attempt $attempt of $UPDATE_ATTEMPTS), retrying in ${UPDATE_RETRY_DELAY}s"
  sleep "$UPDATE_RETRY_DELAY"
  attempt=$((attempt + 1))
done

cd ..

# Upload to R2 only if the JSON actually changed. update-prices.mjs reuses
# the previous timestamp when prices are unchanged, so a byte-compare against
# the last uploaded copy is a reliable no-change check.
MARKER="data/.last-uploaded-fuel-prices.json"

if [ -f "$MARKER" ] && cmp -s data/fuel-prices.json "$MARKER"; then
  echo "No changes to fuel-prices.json — skipping upload."
  osascript -e 'display notification "No price changes this hour" with title "Next Services"' 2>/dev/null || true
  record_success
  exit 0
fi

if rclone copyto data/fuel-prices.json r2:next-services-data/fuel-prices.json \
    --header-upload "Cache-Control: public, max-age=300"; then
  cp data/fuel-prices.json "$MARKER"
  echo "Uploaded to R2 at $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
  osascript -e 'display notification "Fuel prices updated" with title "Next Services"' 2>/dev/null || true
  record_success
else
  record_failure "Upload to R2 failed"
  exit 1
fi
