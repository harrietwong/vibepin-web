#!/usr/bin/env bash
# Install simple daily cron on VPS (run after smoke passes).
set -euo pipefail
BACKEND_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VENV_PY="$BACKEND_DIR/.venv/bin/python"
LOG_DIR="$BACKEND_DIR/logs"
mkdir -p "$LOG_DIR"

CRON_LINE="0 9 * * * cd $BACKEND_DIR && $VENV_PY run_worker.py --job daily >> $LOG_DIR/cron_daily.log 2>&1"

( crontab -l 2>/dev/null | grep -v "run_worker.py --job daily" || true
  echo "$CRON_LINE"
) | crontab -

echo "Installed cron:"
crontab -l | grep run_worker || true
