#!/usr/bin/env python3
"""run_bootstrap_product_supply.py — safe operator runner for the bootstrap v28
Shop-the-Look product-supply path.

This is the SUPPORTED way to produce pin_products going forward. It does NOT
contain any extraction logic of its own — it orchestrates the existing,
reviewed pieces:

    1. scripts/preflight_product_supply.py   (read-only safety gate)
    2. run_worker.py --job product-supply-expand  (dry-run / controlled apply)

Safety model
------------
* Default mode is DRY-RUN. Nothing is written without explicit apply.
* Apply requires BOTH:
      --apply
      --confirm APPLY_BOOTSTRAP_PRODUCTS
* Preflight runs first, every time:
      dry-run  requires recommendation SAFE_FOR_DRY_RUN (or SAFE_FOR_APPLY)
      apply    requires recommendation SAFE_FOR_APPLY
  A WAIT or FAIL recommendation stops the run.
* --waive-cooldown is NOT default. It additionally requires the apply confirm
  token and prints a large warning; it only affects the apply cooldown gate.

This script does not run automatically. An operator invokes it explicitly.

Examples
--------
Dry-run (safe, default):
    py scripts/run_bootstrap_product_supply.py

Controlled apply (guarded):
    py scripts/run_bootstrap_product_supply.py --apply --confirm APPLY_BOOTSTRAP_PRODUCTS

Exit codes:
    0   completed (dry-run or apply)
    10  blocked by preflight (WAIT) or unmet recommendation
    20  preflight FAIL / environment error
    2   bad usage (missing confirm token, etc.)
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from collections import namedtuple
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
PREFLIGHT = BACKEND / "scripts" / "preflight_product_supply.py"
RUN_WORKER = BACKEND / "run_worker.py"

APPLY_CONFIRM_TOKEN = "APPLY_BOOTSTRAP_PRODUCTS"

DEFAULT_SOURCE_REPORT = "logs/product_supply_expand_shop_the_look_20260623_042058.json"
DEFAULT_LIMIT = 50
DEFAULT_CATEGORY_MIX = "fashion:18,womens-fashion:14,home-decor:18"
DEFAULT_TIMEOUT_SECONDS = 1200


def _log(msg: str) -> None:
    print(msg, flush=True)


# ── Robust worker process-tree management ─────────────────────────────────────
# A bare subprocess.run(..., timeout=) only kills the IMMEDIATE child on timeout
# (Windows: TerminateProcess on that PID); it does NOT kill the child's descendant
# tree (Playwright chromium/node) and does not verify the child is dead. That let a
# timed-out worker survive as an orphan and write rows AFTER the runner returned 20.
# These helpers terminate the FULL tree and verify it is gone before returning.

# Worker-runner outcome. exit_code is the value the runner should propagate.
WorkerOutcome = namedtuple("WorkerOutcome", ["status", "exit_code", "remaining_pids"])
TIMEOUT_TREE_KILLED_EXIT = 20    # timed out; full process tree confirmed dead
TIMEOUT_TREE_SURVIVED_EXIT = 30  # timed out; tree could NOT be fully killed (orphans remain)


def _list_descendants(pid: int) -> list[int]:
    """Best-effort: PIDs of all descendants of `pid` (snapshot before kill)."""
    try:
        import psutil  # type: ignore
        return [c.pid for c in psutil.Process(pid).children(recursive=True)]
    except Exception:
        return []


def _pid_alive(pid: int) -> bool:
    """True if `pid` is a live (non-zombie) process."""
    try:
        import psutil  # type: ignore
        if not psutil.pid_exists(pid):
            return False
        try:
            return psutil.Process(pid).status() != psutil.STATUS_ZOMBIE
        except psutil.NoSuchProcess:
            return False
    except Exception:
        if os.name != "nt":
            try:
                os.kill(pid, 0)
                return True
            except ProcessLookupError:
                return False
            except PermissionError:
                return True
        return False


def _kill_tree(pid: int) -> None:
    """Terminate the entire process tree rooted at `pid` (parent + all descendants)."""
    if os.name == "nt":
        # taskkill /T terminates the process AND its child tree; /F forces it.
        try:
            subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"],
                           capture_output=True, text=True, timeout=30)
        except Exception:
            pass
    else:
        import signal
        # Worker is launched in its own session/process group (start_new_session),
        # so killpg reaches every descendant in one shot.
        try:
            os.killpg(os.getpgid(pid), signal.SIGKILL)
        except Exception:
            try:
                os.kill(pid, signal.SIGKILL)
            except Exception:
                pass


def _new_session_kwargs() -> dict:
    # POSIX: give the worker its own process group so killpg reaches all children.
    # Windows: no flags needed — taskkill /T walks the tree by PID.
    return {} if os.name == "nt" else {"start_new_session": True}


def run_worker_with_timeout(cmd: list[str], *, cwd: str, timeout: int,
                            verify_grace: float = 1.0) -> WorkerOutcome:
    """Launch the worker, wait up to `timeout` seconds.

    On normal completion → WorkerOutcome("completed", <worker exit code>, []).
    On timeout → terminate the ENTIRE process tree and VERIFY every PID is gone:
      * all dead  → WorkerOutcome("timeout_killed", 20, [])
      * any alive → WorkerOutcome("timeout_survived", 30, [<surviving pids>])

    The caller must not perform any post-timeout work (e.g. "no write" checks)
    unless status == "timeout_killed". A "timeout_survived" means orphans may
    still be writing and require manual intervention.
    """
    proc = subprocess.Popen(cmd, cwd=cwd, **_new_session_kwargs())
    try:
        code = proc.wait(timeout=timeout)
        return WorkerOutcome("completed", code, [])
    except subprocess.TimeoutExpired:
        pass

    # Snapshot the descendant tree BEFORE killing so we can verify it afterwards.
    descendants = _list_descendants(proc.pid)
    _kill_tree(proc.pid)
    # Reap the immediate child so it does not linger as a zombie.
    try:
        proc.wait(timeout=15)
    except subprocess.TimeoutExpired:
        pass
    time.sleep(verify_grace)  # let the OS finish tearing the tree down

    remaining = [p for p in ([proc.pid] + descendants) if _pid_alive(p)]
    if remaining:
        _log(f"[runner] HARD-FAIL — worker tree NOT fully terminated after timeout; "
             f"surviving PIDs: {remaining}. Manual intervention required; do NOT assume 'no write'.")
        return WorkerOutcome("timeout_survived", TIMEOUT_TREE_SURVIVED_EXIT, remaining)
    _log(f"[runner] STOP — worker exceeded timeout; full process tree terminated "
         f"({len([proc.pid] + descendants)} pid(s)).")
    return WorkerOutcome("timeout_killed", TIMEOUT_TREE_KILLED_EXIT, [])


def _run_preflight(*, waive_cooldown: bool) -> tuple[str, int, dict]:
    """Run the read-only preflight. Returns (recommendation, exit_code, report)."""
    cmd = [sys.executable, str(PREFLIGHT)]
    if waive_cooldown:
        cmd.append("--waive-cooldown")
    _log(f"[runner] preflight: {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=str(BACKEND), capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    if proc.stdout:
        print(proc.stdout)
    if proc.stderr:
        print(proc.stderr, file=sys.stderr)
    report: dict = {}
    try:
        report = json.loads(proc.stdout)
    except Exception:
        pass
    rec = report.get("recommendation", "FAIL")
    return rec, proc.returncode, report


def _build_worker_cmd(args, *, apply: bool) -> list[str]:
    cmd = [
        sys.executable, str(RUN_WORKER),
        "--job", "product-supply-expand",
        "--engine", "shop-the-look",
        "--limit", str(args.limit),
        "--category-mix", args.category_mix,
    ]
    # Forward the recent-window widener when set; omitted → run_worker default (168h).
    if getattr(args, "since_hours", None):
        cmd += ["--since-hours", str(args.since_hours)]
    if args.source_report:
        # Pass only if the file exists; run_worker validates it (fail-closed) and
        # without it the expand path reselects sources for a fresh dry-run.
        report_path = (BACKEND / args.source_report)
        if report_path.exists():
            cmd += ["--source-report", str(report_path)]
        else:
            _log(f"[runner] WARNING: --source-report not found, omitting: {report_path}")
    if apply:
        cmd.append("--apply")
    else:
        cmd.append("--dry-run")
    return cmd


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true",
                    help="Run the controlled apply (writes pin_products). "
                         f"Requires --confirm {APPLY_CONFIRM_TOKEN}.")
    ap.add_argument("--confirm", default=None,
                    help=f"Confirmation token; must equal {APPLY_CONFIRM_TOKEN} for --apply.")
    ap.add_argument("--waive-cooldown", action="store_true",
                    help="Operator waives the post-Pinterest cooldown for apply. "
                         f"Requires --confirm {APPLY_CONFIRM_TOKEN} and prints a warning.")
    ap.add_argument("--source-report", default=DEFAULT_SOURCE_REPORT,
                    help="Approved frozen dry-run JSON (relative to backend). "
                         f"Default: {DEFAULT_SOURCE_REPORT}")
    ap.add_argument("--limit", type=int, default=DEFAULT_LIMIT,
                    help=f"Source pins to process (default {DEFAULT_LIMIT}).")
    ap.add_argument("--category-mix", default=DEFAULT_CATEGORY_MIX,
                    help=f"Category allocation (default {DEFAULT_CATEGORY_MIX}).")
    ap.add_argument("--since-hours", type=int, default=None,
                    help="Recent source-pin window forwarded to run_worker "
                         "(widens the eligible pin_samples pool; default 168 when unset). "
                         "Never selects legacy pins — only widens the recent window.")
    ap.add_argument("--timeout-seconds", type=int, default=DEFAULT_TIMEOUT_SECONDS,
                    help=f"Max seconds for the worker run (default {DEFAULT_TIMEOUT_SECONDS}).")
    args = ap.parse_args()

    apply = bool(args.apply)

    # ── usage gating ──────────────────────────────────────────────────────────
    if apply and args.confirm != APPLY_CONFIRM_TOKEN:
        _log(f"Refusing apply: pass --confirm {APPLY_CONFIRM_TOKEN} to confirm a real write.")
        return 2
    if args.waive_cooldown:
        if args.confirm != APPLY_CONFIRM_TOKEN:
            _log(f"Refusing --waive-cooldown without --confirm {APPLY_CONFIRM_TOKEN}.")
            return 2
        _log("=" * 72)
        _log("!!  WARNING: --waive-cooldown waives the post-Pinterest cooldown gate.  !!")
        _log("!!  Only do this if you are CERTAIN no Pinterest activity is in flight.  !!")
        _log("=" * 72)

    mode = "apply" if apply else "dry-run"
    _log(f"[runner] mode = {mode}")

    # ── preflight (always; read-only) ─────────────────────────────────────────
    rec, code, _report = _run_preflight(waive_cooldown=args.waive_cooldown and apply)
    _log(f"[runner] preflight recommendation = {rec} (exit {code})")

    if rec == "FAIL" or code == 20:
        _log("[runner] STOP — preflight FAIL (environment not safe).")
        return 20
    if rec == "WAIT" or code == 10:
        _log("[runner] STOP — preflight WAIT (a Pinterest job / writer is active). Try later.")
        return 10

    if apply:
        if rec != "SAFE_FOR_APPLY":
            _log(f"[runner] STOP — apply requires SAFE_FOR_APPLY, got {rec}. "
                 f"(cooldown unmet? re-run with --waive-cooldown --confirm {APPLY_CONFIRM_TOKEN} "
                 "only if certain.)")
            return 10
    else:
        if rec not in ("SAFE_FOR_DRY_RUN", "SAFE_FOR_APPLY"):
            _log(f"[runner] STOP — dry-run requires SAFE_FOR_DRY_RUN, got {rec}.")
            return 10

    # ── invoke the supported worker path ──────────────────────────────────────
    cmd = _build_worker_cmd(args, apply=apply)
    _log(f"[runner] launch: {' '.join(cmd)}")
    result = run_worker_with_timeout(cmd, cwd=str(BACKEND), timeout=args.timeout_seconds)
    if result.status == "timeout_killed":
        # Tree confirmed dead — safe to treat as a clean (no-orphan) timeout.
        return TIMEOUT_TREE_KILLED_EXIT
    if result.status == "timeout_survived":
        # Orphans remain — distinct hard-fail so the operator does NOT assume "no write".
        return TIMEOUT_TREE_SURVIVED_EXIT
    _log(f"[runner] worker exit = {result.exit_code}")
    return result.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
