#!/usr/bin/env bash
# cloud_run_keyword_trends.sh — safe VPS wrapper for the daily keyword-trend refresh.
#
# Writes trend_keywords + crawl_queue. Source is the Pinterest TRENDS API (token
# channel) + typeahead — NOT the residential-IP Playwright crawl, so it does not
# contend for the residential-IP lock. It is still network-sensitive, so it is
# scheduled in its OWN window, holds a dedicated keyword-trends lock, and
# preflight-gates: it REFUSES while a Pinterest crawl / Product-Supply worker holds
# the shared pinterest_network.lock (defence-in-depth, no co-running).
#
# MODES (arg 1 or $VIBEPIN_TRENDS_MODE; DEFAULT = preflight — safe no-op):
#   preflight   read-only safety check only. Writes nothing. (default)
#   trends      REAL trend refresh. Requires VIBEPIN_TRENDS_CONFIRM=RUN_TRENDS.
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/cloud_lib.sh"
cloud_init "keyword_trends"

MODE="${1:-${VIBEPIN_TRENDS_MODE:-preflight}}"
TIMEOUT_SECONDS="${VIBEPIN_TRENDS_TIMEOUT_SECONDS:-1800}"   # 30 min hard cap
TRENDS_CONFIRM_TOKEN="RUN_TRENDS"

cloud_flock
cloud_log "mode=$MODE backend=$BACKEND_DIR lockdir=$LOCK_DIR timeout=${TIMEOUT_SECONDS}s"
cloud_preflight_gate

case "$MODE" in
  preflight)
    cloud_log "preflight-only mode: safe. No trend refresh run, nothing written."
    exit 0
    ;;
  trends)
    if [[ "${VIBEPIN_TRENDS_CONFIRM:-}" != "$TRENDS_CONFIRM_TOKEN" ]]; then
      cloud_log "REFUSE trends: set VIBEPIN_TRENDS_CONFIRM=$TRENDS_CONFIRM_TOKEN to authorize a real refresh."
      exit 5
    fi
    cloud_log "TRENDS: run_worker --job trends (Pinterest Trends API; writes trend_keywords/crawl_queue)."
    cloud_run_with_tree_timeout "$TIMEOUT_SECONDS" \
      "$PY" run_worker.py --job trends --created-by cloud
    rc=$?
    cloud_log "trends exit=$rc"
    exit "$rc"
    ;;
  *)
    cloud_log "REFUSE: unknown mode '$MODE' (use: preflight | trends)."
    exit 2
    ;;
esac
