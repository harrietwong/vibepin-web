#!/usr/bin/env bash
# Bounded daily tracking for every active Product Opportunity.
# Default mode is a read-only preflight. A real run needs three explicit values:
# VIBEPIN_TRACKING_RUN_MODE=track
# VIBEPIN_PRODUCT_TRACKING_MODE=production
# VIBEPIN_PRODUCT_TRACKING_CONFIRM=TRACK_ACTIVE_PRODUCTS
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cloud_lib.sh"
cloud_init "product_tracking"

MODE="${1:-${VIBEPIN_TRACKING_RUN_MODE:-preflight}}"
TIMEOUT_SECONDS="${VIBEPIN_PRODUCT_TRACKING_TIMEOUT_SECONDS:-7200}"
LIMIT="${VIBEPIN_PRODUCT_TRACKING_LIMIT:-2499}"

cloud_flock
cloud_log "mode=$MODE backend=$BACKEND_DIR lockdir=$LOCK_DIR timeout=${TIMEOUT_SECONDS}s limit=$LIMIT"
if [[ "$MODE" == "track" ]]; then
  # A real Pinterest run needs measured cooldown evidence, not merely the
  # read-only SAFE_FOR_DRY_RUN state.
  cloud_preflight_gate SAFE_FOR_APPLY
else
  cloud_preflight_gate
fi

case "$MODE" in
  preflight)
    cloud_log "preflight-only mode: safe. No provider requests and no writes."
    exit 0
    ;;
  dry-run)
    cloud_log "DRY-RUN: inventory and budget check only; no provider requests and no writes."
    "$PY" product_opportunity_tracking.py --limit "$LIMIT" 2>&1 | tee -a "$RUN_LOG"
    exit "${PIPESTATUS[0]}"
    ;;
  track)
    if [[ "${VIBEPIN_PRODUCT_TRACKING_MODE:-}" != "production" ]]; then
      cloud_log "REFUSE track: VIBEPIN_PRODUCT_TRACKING_MODE must equal production."
      exit 5
    fi
    if [[ "${VIBEPIN_PRODUCT_TRACKING_CONFIRM:-}" != "TRACK_ACTIVE_PRODUCTS" ]]; then
      cloud_log "REFUSE track: VIBEPIN_PRODUCT_TRACKING_CONFIRM must equal TRACK_ACTIVE_PRODUCTS."
      exit 5
    fi
    # Acquire the cross-job lock after preflight. Losing the race fails closed.
    cloud_network_flock
    cloud_log "TRACK: all active products must fit the reviewed request budget or the job refuses before network access."
    if cloud_run_with_tree_timeout "$TIMEOUT_SECONDS" \
      "$PY" product_opportunity_tracking.py --apply --limit "$LIMIT"; then
      rc=0
    else
      rc=$?
    fi
    cloud_log "product tracking exit=$rc"
    exit "$rc"
    ;;
  *)
    cloud_log "REFUSE: unknown mode '$MODE' (use: preflight | dry-run | track)."
    exit 2
    ;;
esac
