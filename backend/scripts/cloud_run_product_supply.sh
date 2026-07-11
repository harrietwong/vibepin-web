#!/usr/bin/env bash
# cloud_run_product_supply.sh — safe VPS wrapper for the Product-Supply runner.
#
# PURPOSE
#   Single, hardened entry point for scheduled (systemd) Product-Supply jobs on the
#   Linux VPS. It NEVER calls run_worker.py directly — it only invokes the hardened
#   scripts/run_bootstrap_product_supply.py (which runs preflight + the tree-kill
#   timeout). It runs a read-only preflight first and refuses on an unsafe state.
#
# MODES (first arg, or $VIBEPIN_CLOUD_MODE; DEFAULT = preflight — a safe no-op job):
#   preflight   read-only safety check only. Writes nothing. (default)
#   dry-run     hardened runner in DRY-RUN (navigates Pinterest, writes NO DB rows).
#   apply       hardened runner --apply. Requires VIBEPIN_APPLY_CONFIRM token.
#   crawl       RESERVED — disabled. No hardened crawl wrapper exists yet; this
#               script will not call run_worker.py --job crawl directly.
#
# This script does NOT enable any schedule and is APPLY-safe-by-default (apply needs
# an explicit confirm token). It is meant to be invoked by a systemd service whose
# timer is disabled until an operator enables it.
set -euo pipefail

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$BACKEND_DIR"

LOG_DIR="$BACKEND_DIR/logs"          # timestamped run logs + JSON reports live here
LOCK_DIR="${VIBEPIN_LOCK_DIR:-/opt/vibepin/locks}"   # Linux-safe advisory lock dir
export VIBEPIN_LOCK_DIR="$LOCK_DIR"
RUN_LOCK="$LOCK_DIR/cloud_run_product_supply.lock"   # wrapper no-overlap lock

mkdir -p "$LOG_DIR" "$LOCK_DIR"

# ── Config ────────────────────────────────────────────────────────────────────
MODE="${1:-${VIBEPIN_CLOUD_MODE:-preflight}}"
TIMEOUT_SECONDS="${VIBEPIN_TIMEOUT_SECONDS:-2400}"
LIMIT="${VIBEPIN_SUPPLY_LIMIT:-50}"
CATEGORY_MIX="${VIBEPIN_CATEGORY_MIX:-fashion:18,womens-fashion:14,home-decor:18}"
APPLY_CONFIRM_TOKEN="APPLY_BOOTSTRAP_PRODUCTS"

# Prefer the project venv if present; otherwise fall back to python3 on PATH.
if [[ -x "$BACKEND_DIR/.venv/bin/python" ]]; then
  PY="$BACKEND_DIR/.venv/bin/python"
else
  PY="$(command -v python3 || command -v python)"
fi

STAMP="$(date -u +%Y%m%d_%H%M%SZ)"
RUN_LOG="$LOG_DIR/cloud_run_${MODE}_${STAMP}.log"

log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$RUN_LOG"; }

# Secrets are loaded by the Python scripts via python-dotenv (.env) and/or the
# systemd EnvironmentFile. This wrapper never reads or prints .env values.

# ── No-overlap guard (flock) ──────────────────────────────────────────────────
exec 200>"$RUN_LOCK"
if ! flock -n 200; then
  log "REFUSE: another cloud_run_product_supply is already running (lock $RUN_LOCK)."
  exit 9
fi

log "mode=$MODE backend=$BACKEND_DIR lockdir=$LOCK_DIR timeout=${TIMEOUT_SECONDS}s"

# ── Read-only preflight gate (every mode) ─────────────────────────────────────
REC="$("$PY" scripts/preflight_product_supply.py 2>>"$RUN_LOG" \
        | "$PY" -c 'import sys,json; print(json.load(sys.stdin).get("recommendation","FAIL"))' \
        2>>"$RUN_LOG" || echo FAIL)"
log "preflight recommendation = $REC"
case "$REC" in
  SAFE_FOR_DRY_RUN|SAFE_FOR_APPLY) : ;;                 # environment safe — continue
  WAIT) log "REFUSE: preflight WAIT (active worker/lock). Try later."; exit 8 ;;
  *)    log "REFUSE: preflight $REC (environment not safe)."; exit 8 ;;
esac

# ── Mode dispatch ─────────────────────────────────────────────────────────────
case "$MODE" in
  preflight)
    log "preflight-only mode: safe. No job run, nothing written."
    exit 0
    ;;

  dry-run)
    log "DRY-RUN: hardened runner (navigates Pinterest, writes NO DB rows)."
    "$PY" scripts/run_bootstrap_product_supply.py \
        --limit "$LIMIT" --category-mix "$CATEGORY_MIX" \
        --timeout-seconds "$TIMEOUT_SECONDS" \
        2>&1 | tee -a "$RUN_LOG"
    rc="${PIPESTATUS[0]}"
    log "runner exit=$rc"
    exit "$rc"
    ;;

  apply)
    if [[ "${VIBEPIN_APPLY_CONFIRM:-}" != "$APPLY_CONFIRM_TOKEN" ]]; then
      log "REFUSE apply: set VIBEPIN_APPLY_CONFIRM=$APPLY_CONFIRM_TOKEN to authorize a real write."
      exit 5
    fi
    log "APPLY: hardened runner --apply (writes pin_products). cooldown waived by operator confirm."
    "$PY" scripts/run_bootstrap_product_supply.py \
        --limit "$LIMIT" --category-mix "$CATEGORY_MIX" \
        --timeout-seconds "$TIMEOUT_SECONDS" \
        --apply --confirm "$APPLY_CONFIRM_TOKEN" --waive-cooldown \
        2>&1 | tee -a "$RUN_LOG"
    rc="${PIPESTATUS[0]}"
    log "runner exit=$rc"
    exit "$rc"
    ;;

  crawl)
    log "REFUSE: crawl mode is reserved/disabled. This wrapper will not invoke the"
    log "        crawl job directly. A hardened crawl wrapper is required first."
    exit 3
    ;;

  *)
    log "REFUSE: unknown mode '$MODE' (use: preflight | dry-run | apply | crawl)."
    exit 2
    ;;
esac
