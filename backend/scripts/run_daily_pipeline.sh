#!/usr/bin/env bash
# Cloud worker — full daily pipeline (alternative to split cron)
set -euo pipefail
cd "$(dirname "$0")/.."
LIMIT="${CRAWL_LIMIT_KEYWORDS:-80}"
exec python3 -u run_worker.py --job daily --limit-keywords "$LIMIT" --created-by cloud
