#!/usr/bin/env bash
# cloud_run_pin_crawl.sh — safe VPS wrapper for the daily Pin/crawler refresh.
#
# Writes pin_samples + crawl_queue from Pinterest via Playwright (residential IP).
# Acquires the shared pinterest_network.lock INTERNALLY (run_worker --job crawl),
# and this wrapper additionally preflight-gates + holds a dedicated crawl lock.
#
# MODES (arg 1 or $VIBEPIN_CRAWL_MODE; DEFAULT = preflight — safe no-op):
#   preflight   read-only safety check only. Writes nothing. (default)
#   crawl       REAL crawl. Requires VIBEPIN_CRAWL_CONFIRM=RUN_CRAWL.
#
# Default is APPLY-safe: a real crawl needs both mode=crawl AND the confirm token.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cloud_lib.sh"
cloud_init "pin_crawl"

MODE="${1:-${VIBEPIN_CRAWL_MODE:-preflight}}"
TIMEOUT_SECONDS="${VIBEPIN_CRAWL_TIMEOUT_SECONDS:-5400}"   # 90 min hard cap
LIMIT_KEYWORDS="${VIBEPIN_CRAWL_LIMIT_KEYWORDS:-150}"
TOP_N="${VIBEPIN_CRAWL_TOP:-50}"
CRAWL_CONFIRM_TOKEN="RUN_CRAWL"

cloud_flock
cloud_log "mode=$MODE backend=$BACKEND_DIR lockdir=$LOCK_DIR timeout=${TIMEOUT_SECONDS}s"
cloud_preflight_gate

case "$MODE" in
  preflight)
    cloud_log "preflight-only mode: safe. No crawl run, nothing written."
    exit 0
    ;;
  crawl)
    if [[ "${VIBEPIN_CRAWL_CONFIRM:-}" != "$CRAWL_CONFIRM_TOKEN" ]]; then
      cloud_log "REFUSE crawl: set VIBEPIN_CRAWL_CONFIRM=$CRAWL_CONFIRM_TOKEN to authorize a real crawl."
      exit 5
    fi
    cloud_log "CRAWL: run_worker --job crawl (Playwright/Pinterest; writes pin_samples)."
    # crawl is the job's only safe entrypoint; run it under the tree-timeout so a
    # hang can never orphan Playwright/chromium. No automatic retry.
    cloud_run_with_tree_timeout "$TIMEOUT_SECONDS" \
      "$PY" run_worker.py --job crawl \
        --limit-keywords "$LIMIT_KEYWORDS" --top "$TOP_N" --created-by cloud
    rc=$?
    cloud_log "crawl exit=$rc"
    exit "$rc"
    ;;
  *)
    cloud_log "REFUSE: unknown mode '$MODE' (use: preflight | crawl)."
    exit 2
    ;;
esac
