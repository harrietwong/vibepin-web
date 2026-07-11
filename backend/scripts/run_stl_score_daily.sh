#!/usr/bin/env bash
# Cloud worker — Shop the Look + product scoring (11:30 cron)
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 -u run_worker.py --job stl-score --created-by cloud
