#!/usr/bin/env bash
# Cloud worker — trends replenish (08:30 cron)
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 -u run_worker.py --job trends --created-by cloud
