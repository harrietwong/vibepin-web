#!/usr/bin/env bash
# Cloud worker — classify product signals + reference pins, then regenerate opportunities.
# Produces Pin Ideas (pin_samples.is_reference_eligible) and Product Ideas
# (pin_products.product_type + opportunities table). NOT covered by trends/crawl/stl-score,
# so run this after run_stl_score_daily.sh (e.g. 12:00 cron). Lock-safe via run_worker.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 -u run_worker.py --job classify --created-by cloud
