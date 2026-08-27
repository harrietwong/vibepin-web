#!/usr/bin/env bash
# Bounded Product Supply receipt -> Product Opportunity admission.
# Default mode is a safe preflight. A real run needs all three explicit values:
# VIBEPIN_PRODUCT_ADMISSION_RUN_MODE=apply
# VIBEPIN_PRODUCT_ADMISSION_MODE=production
# VIBEPIN_PRODUCT_ADMISSION_CONFIRM=ADMIT_REVIEWED_PRODUCTS
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cloud_lib.sh"
cloud_init "product_opportunity_admission"

MODE="${1:-${VIBEPIN_PRODUCT_ADMISSION_RUN_MODE:-preflight}}"
TIMEOUT_SECONDS="${VIBEPIN_PRODUCT_ADMISSION_TIMEOUT_SECONDS:-2400}"
SOURCE_REPORT="${VIBEPIN_PRODUCT_ADMISSION_SOURCE_REPORT:-$BACKEND_DIR/logs/product_supply_expand_shop_the_look_latest.json}"

cloud_flock
cloud_log "mode=$MODE backend=$BACKEND_DIR timeout=${TIMEOUT_SECONDS}s source_report=$SOURCE_REPORT"

case "$MODE" in
  preflight)
    cloud_preflight_gate
    cloud_log "preflight-only mode: no provider requests and no writes."
    exit 0
    ;;
  dry-run)
    # Manifest construction re-verifies Pinterest Pin identity/direct-PDP proof.
    # It therefore requires the same real cooldown as an apply, even though it
    # performs no database write.
    cloud_preflight_gate SAFE_FOR_APPLY
    cloud_network_flock
    cloud_log "DRY-RUN: exact Product Supply receipt, bounded Pinterest/merchant proof, zero writes."
    if cloud_run_with_tree_timeout "$TIMEOUT_SECONDS" \
      "$PY" product_opportunity_admission_pipeline.py \
      --source-report "$SOURCE_REPORT" --output-dir "$LOG_DIR"; then
      rc=0
    else
      rc=$?
    fi
    cloud_log "Product Opportunity admission dry-run exit=$rc"
    exit "$rc"
    ;;
  apply)
    cloud_preflight_gate SAFE_FOR_APPLY
    if [[ "${VIBEPIN_PRODUCT_ADMISSION_MODE:-}" != "production" ]]; then
      cloud_log "REFUSE apply: VIBEPIN_PRODUCT_ADMISSION_MODE must equal production."
      exit 5
    fi
    if [[ "${VIBEPIN_PRODUCT_ADMISSION_CONFIRM:-}" != "ADMIT_REVIEWED_PRODUCTS" ]]; then
      cloud_log "REFUSE apply: VIBEPIN_PRODUCT_ADMISSION_CONFIRM is not the reviewed token."
      exit 5
    fi
    cloud_network_flock
    cloud_log "APPLY: exact fresh Product Supply IDs only; run cap=50, atomic cap=20."
    if cloud_run_with_tree_timeout "$TIMEOUT_SECONDS" \
      "$PY" product_opportunity_admission_pipeline.py \
      --source-report "$SOURCE_REPORT" --output-dir "$LOG_DIR" --apply; then
      rc=0
    else
      rc=$?
    fi
    cloud_log "Product Opportunity admission apply exit=$rc"
    exit "$rc"
    ;;
  *)
    cloud_log "REFUSE: unknown mode '$MODE' (use: preflight | dry-run | apply)."
    exit 2
    ;;
esac
