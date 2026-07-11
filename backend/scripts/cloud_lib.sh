#!/usr/bin/env bash
# cloud_lib.sh — shared helpers for VibePin cloud wrapper scripts.
#
# Sourced by cloud_run_pin_crawl.sh and cloud_run_keyword_trends.sh. Provides:
#   * dir/env setup + Linux-safe lock dir
#   * flock-based no-overlap guard
#   * read-only preflight gate (refuse on unsafe state)
#   * process-TREE timeout kill (setsid + process-group SIGKILL), so a timed-out
#     job can never leave an orphan (same lesson as the Product-Supply runner).
#
# Never prints secrets. Python scripts load .env via python-dotenv / systemd
# EnvironmentFile; this lib never reads or echoes .env values.
#
# (cloud_run_product_supply.sh stays self-contained — it delegates its timeout
# tree-kill to the hardened Python runner run_bootstrap_product_supply.py.)

# cloud_init <job_name>  — sets BACKEND_DIR, LOG_DIR, LOCK_DIR, PY, RUN_LOG; mkdirs.
cloud_init() {
  CLOUD_JOB="$1"
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[1]}")" && pwd)"
  BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
  cd "$BACKEND_DIR"
  LOG_DIR="$BACKEND_DIR/logs"
  LOCK_DIR="${VIBEPIN_LOCK_DIR:-/opt/vibepin/locks}"
  export VIBEPIN_LOCK_DIR="$LOCK_DIR"
  mkdir -p "$LOG_DIR" "$LOCK_DIR"
  if [[ -x "$BACKEND_DIR/.venv/bin/python" ]]; then
    PY="$BACKEND_DIR/.venv/bin/python"
  else
    PY="$(command -v python3 || command -v python)"
  fi
  STAMP="$(date -u +%Y%m%d_%H%M%SZ)"
  RUN_LOG="$LOG_DIR/cloud_run_${CLOUD_JOB}_${STAMP}.log"
}

cloud_log() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$RUN_LOG"; }

# cloud_flock — acquire a per-job no-overlap lock on fd 201. Exit 9 if held.
cloud_flock() {
  local lock="$LOCK_DIR/cloud_run_${CLOUD_JOB}.lock"
  exec 201>"$lock"
  if ! flock -n 201; then
    cloud_log "REFUSE: another ${CLOUD_JOB} run is already active (lock $lock)."
    exit 9
  fi
}

# cloud_preflight_gate — run the read-only preflight; refuse on WAIT/FAIL.
# This is how every Pinterest-touching job RESPECTS the shared pinterest_network
# lock + active-worker state (the preflight reports both). Exit 8 if unsafe.
cloud_preflight_gate() {
  local raw rec
  # preflight EXITS NONZERO by design for WAIT(10)/FAIL(20). Capture its JSON
  # separately and parse the recommendation from that, instead of piping preflight
  # straight into the parser: under `set -o pipefail` the old pipeline returned
  # preflight's nonzero status, firing `|| echo FAIL` and appending a second line so
  # $rec became "WAIT\nFAIL" (which then fell through to the generic refuse branch).
  # `|| true` keeps preflight's expected nonzero exit from aborting under errexit.
  raw="$("$PY" scripts/preflight_product_supply.py 2>>"$RUN_LOG")" || true
  # The parser catches any error and prints FAIL itself, so it always exits 0 and
  # yields a single clean token. Refusal stays the safe default on bad/empty input.
  rec="$(printf '%s' "$raw" | "$PY" -c 'import sys, json
try:
    print(json.load(sys.stdin).get("recommendation", "FAIL"))
except Exception:
    print("FAIL")' 2>>"$RUN_LOG")"
  [ -n "$rec" ] || rec="FAIL"
  cloud_log "preflight recommendation = $rec"
  case "$rec" in
    SAFE_FOR_DRY_RUN|SAFE_FOR_APPLY) return 0 ;;
    WAIT) cloud_log "REFUSE: preflight WAIT (active Pinterest worker/lock). Try later."; exit 8 ;;
    *)    cloud_log "REFUSE: preflight $rec (environment not safe)."; exit 8 ;;
  esac
}

# cloud_run_with_tree_timeout <timeout_s> <cmd...>
# Runs cmd in its OWN process group (setsid) and, on timeout, SIGKILLs the whole
# group so children (run_worker, Playwright/chromium) cannot orphan. Returns the
# command's exit code, or 124 on timeout-kill.
cloud_run_with_tree_timeout() {
  local timeout_s="$1"; shift
  setsid "$@" >>"$RUN_LOG" 2>&1 &
  local pid=$!
  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= timeout_s )); then
      cloud_log "TIMEOUT after ${timeout_s}s — terminating process group $pid"
      kill -TERM -- "-$pid" 2>/dev/null || true
      sleep 5
      kill -KILL -- "-$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 5; waited=$((waited+5))
  done
  wait "$pid"
}
