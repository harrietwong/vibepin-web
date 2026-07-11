#!/usr/bin/env bash
# Cloud worker — crawl due queue items (09:00 / 10:00 cron)
set -euo pipefail
cd "$(dirname "$0")/.."
LIMIT="${CRAWL_LIMIT_KEYWORDS:-80}"
exec python3 -u run_worker.py --job crawl --limit-keywords "$LIMIT" --created-by cloud
