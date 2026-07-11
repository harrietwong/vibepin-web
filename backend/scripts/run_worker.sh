#!/usr/bin/env bash
# Generic cloud worker wrapper — pass any run_worker.py args.
# Examples:
#   ./scripts/run_worker.sh --job smoke
#   ./scripts/run_worker.sh --job crawl --limit-keywords 80
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 -u run_worker.py "$@"
