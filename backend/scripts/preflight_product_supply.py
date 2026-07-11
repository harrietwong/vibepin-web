"""preflight_product_supply.py — READ-ONLY safety gate for the STL bootstrap.

Run before any frozen dry-run / controlled apply. Performs no writes, no crawl,
no Pinterest navigation. Reports a single recommendation:

    SAFE_FOR_APPLY  — clear to run the controlled apply
    SAFE_FOR_DRY_RUN — clear to run the dry-run (but a writer/cooldown blocks apply)
    WAIT            — a Pinterest job / writer is active; try again later
    FAIL            — could not establish safety (e.g. DB unreachable)

Usage:
    py scripts/preflight_product_supply.py
    py scripts/preflight_product_supply.py --cooldown-min 120   # require 2h since last Pinterest activity
    py scripts/preflight_product_supply.py --waive-cooldown     # operator waives cooldown for apply
"""

from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import os
import subprocess
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "db"))

import joblock  # noqa: E402

VIBEPIN_TASKS = [
    "VibePinLocalCrawl",
    "VibePin-Pipeline-Daily",
    "VibePin-Pipeline-Daily-10",
    "VibePin Daily Pipeline",
    "VibePin-Classify-Daily",
]
# Tasks that touch Pinterest (Running ⇒ unsafe). Classify is local-only.
PINTEREST_TASKS = {
    "VibePinLocalCrawl", "VibePin-Pipeline-Daily",
    "VibePin-Pipeline-Daily-10", "VibePin Daily Pipeline",
}
PROC_HINTS = ("run_worker", "shop_the_look", "pipeline.py", "product-supply",
              "--job crawl", "--step stl", "local_crawl")
LOG_DIRS = [BACKEND / "logs", BACKEND / "logs" / "daily", Path(r"C:\vibepinlogs")]

# Command-line markers identifying the controlled bootstrap runner. The runner
# (scripts/run_bootstrap_product_supply.py) spawns THIS preflight as a subprocess
# and passes --source-report logs/..._shop_the_look_...json. That path contains
# "shop_the_look", a PROC_HINTS token, so without an exclusion the preflight would
# detect the runner (its own parent) as an active Pinterest worker and return WAIT
# — a false positive. We therefore exclude this process and, ONLY when it is the
# controlled runner, its direct parent. No other process is ever excluded, so a
# genuine external run_worker / shop_the_look / Playwright job is still detected.
RUNNER_MARKERS = ("run_bootstrap_product_supply.py",)


def _self_and_runner_parent_pids() -> set[int]:
    """Return PIDs to exclude from active-worker detection: this preflight process
    itself, plus its parent ONLY if the parent's command line is the controlled
    runner. Never excludes unrelated parents."""
    excluded: set[int] = {os.getpid()}
    try:
        import psutil
        me = psutil.Process(os.getpid())
        parent = me.parent()
        if parent is not None:
            try:
                pcmd = " ".join(parent.cmdline() or [])
            except Exception:
                pcmd = ""
            if any(m in pcmd for m in RUNNER_MARKERS):
                excluded.add(parent.pid)
    except Exception:
        # psutil unavailable / parent gone — still exclude our own PID.
        pass
    return excluded


def task_states() -> dict:
    out = {}
    for name in VIBEPIN_TASKS:
        try:
            r = subprocess.run(["schtasks", "/query", "/tn", name, "/fo", "csv", "/nh"],
                               capture_output=True, text=True, timeout=15)
            state = "?"
            if r.returncode == 0 and r.stdout.strip():
                # CSV: "TaskName","Next Run Time","Status"
                parts = [p.strip('"') for p in r.stdout.strip().splitlines()[-1].split('","')]
                state = parts[-1].strip('"') if parts else "?"
            out[name] = state
        except Exception as exc:
            out[name] = f"err:{exc}"
    return out


def active_procs() -> list:
    hits = []
    # Exclude this preflight process and (only) the controlled runner parent, so
    # the runner's own --source-report path can't self-match PROC_HINTS. All other
    # python workers are still detected.
    excluded = _self_and_runner_parent_pids()
    try:
        import psutil
        for p in psutil.process_iter(["pid", "name", "cmdline", "create_time"]):
            try:
                if p.info.get("pid") in excluded:
                    continue
                nm = (p.info.get("name") or "").lower()
                if nm not in ("python.exe", "py.exe", "pythonw.exe"):
                    continue
                cmd = " ".join(p.info.get("cmdline") or [])
                if any(h in cmd for h in PROC_HINTS):
                    hits.append({"pid": p.info["pid"], "cmd": cmd[:160]})
                elif not cmd:
                    # cmdline unreadable (scheduled/elevated) — flag python procs too
                    hits.append({"pid": p.info["pid"], "cmd": "(cmdline unreadable)"})
            except Exception:
                continue
    except Exception as exc:
        return [{"error": str(exc)}]
    return hits


def playwright_procs() -> int:
    try:
        import psutil
        n = 0
        for p in psutil.process_iter(["name", "exe", "cmdline"]):
            try:
                if (p.info.get("name") or "").lower() != "chrome.exe":
                    continue
                exe = (p.info.get("exe") or "")
                cmd = " ".join(p.info.get("cmdline") or [])
                if "ms-playwright" in exe or "--headless" in cmd or "remote-debugging-pipe" in cmd:
                    n += 1
            except Exception:
                continue
        return n
    except Exception:
        return -1


# Wrapper-owned scheduler run-logs. Each cloud_run_*.sh wrapper writes its own
# logs/cloud_run_<job>_<stamp>.log BEFORE it calls this preflight, so without an
# exclusion logs_growing() would flag the wrapper's OWN fresh log as "active
# pipeline work" and return WAIT — a self-trip that makes every scheduled run
# refuse. These logs are not external Pinterest activity. Genuine cross-job
# contention is still caught by the shared pinterest_network.lock, the per-job
# locks, active-process detection, Playwright/chromium detection and the DB
# sentinel — none of which this exclusion touches.
IGNORED_LOG_GLOBS = ("cloud_run_*.log",)


def _is_ignored_log(name: str) -> bool:
    """True if a log filename is a wrapper-owned scheduler log (ignored by
    logs_growing). Matches on the basename only, not the directory."""
    return any(fnmatch.fnmatch(name, pat) for pat in IGNORED_LOG_GLOBS)


def logs_growing() -> list:
    growing = []
    cutoff = dt.datetime.now() - dt.timedelta(minutes=2)
    for d in LOG_DIRS:
        if not d.exists():
            continue
        for f in d.glob("*.log"):
            if _is_ignored_log(f.name):
                continue  # wrapper's own scheduler log — not external activity
            try:
                if dt.datetime.fromtimestamp(f.stat().st_mtime) > cutoff:
                    growing.append(str(f))
            except Exception:
                continue
    return growing


def db_sentinel() -> dict:
    try:
        from dotenv import load_dotenv
        load_dotenv(BACKEND / ".env")
        import httpx
        U = os.environ["SUPABASE_URL"].rstrip("/"); K = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
        c = httpx.Client(base_url=f"{U}/rest/v1/", headers={"apikey": K, "Authorization": f"Bearer {K}"}, timeout=30)

        def cnt(params):
            p = dict(params); p["limit"] = "1"
            r = c.get("pin_products", params=p, headers={"Prefer": "count=exact", "Range": "0-0"})
            cr = r.headers.get("content-range", "")
            return int(cr.split("/")[-1]) if "/" in cr and cr.split("/")[-1].isdigit() else -1

        today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
        # sorted-id checksum (stable hash of all ids)
        import hashlib
        ids = []
        off = 0
        while True:
            r = c.get("pin_products", params={"select": "id", "order": "id.asc", "limit": "1000", "offset": str(off)})
            if r.status_code not in (200, 206):
                break
            rows = r.json()
            ids.extend(x["id"] for x in rows)
            if len(rows) < 1000:
                break
            off += 1000
        checksum = hashlib.md5(",".join(sorted(ids)).encode()).hexdigest()
        return {
            "ok": True,
            "pin_products_total": cnt({}),
            "sorted_id_checksum": checksum,
            "bootstrap_rows": cnt({"discovery_method_detail": "eq.pinterest_product_card_bootstrap"}),
            "normalized_hash_not_null": cnt({"normalized_product_url_hash": "not.is.null"}),
            "created_today": cnt({"created_at": f"gte.{today}"}),
            "legacy_stl_rows": cnt({"discovery_method": "eq.stl", "discovery_method_detail": "is.null"}),
        }
    except Exception as exc:
        return {"ok": False, "error": str(exc)[:300]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cooldown-min", type=int, default=120)
    ap.add_argument("--waive-cooldown", action="store_true")
    args = ap.parse_args()

    report = {
        "generatedAt": dt.datetime.now().isoformat(),
        "localTime": dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "taskStates": task_states(),
        "activePinterestProcs": active_procs(),
        "playwrightProcCount": playwright_procs(),
        "locks": joblock.describe_locks(),
        "logsGrowing": logs_growing(),
        "dbSentinel": db_sentinel(),
    }

    # ── decision ──────────────────────────────────────────────────────────────
    reasons = []
    pinterest_task_running = [n for n, s in report["taskStates"].items()
                             if n in PINTEREST_TASKS and s == "Running"]
    if pinterest_task_running:
        reasons.append(f"Pinterest scheduled task running: {pinterest_task_running}")
    if report["activePinterestProcs"] and not (len(report["activePinterestProcs"]) == 1 and "error" in report["activePinterestProcs"][0]):
        reasons.append(f"active python crawler/STL/worker processes: {len(report['activePinterestProcs'])}")
    if report["playwrightProcCount"] and report["playwrightProcCount"] > 0:
        reasons.append("Playwright/Chromium automation active")
    if report["locks"]["pinterest_network"]["live"]:
        reasons.append("pinterest_network.lock is held")
    if report["logsGrowing"]:
        reasons.append(f"logs growing: {len(report['logsGrowing'])}")
    if not report["dbSentinel"].get("ok"):
        reasons.append("DB sentinel unavailable")

    writer_live = report["locks"]["pin_products_writer"]["live"]

    if not report["dbSentinel"].get("ok"):
        rec = "FAIL"
    elif reasons:
        rec = "WAIT"
    elif writer_live:
        # No Pinterest contention, but a writer is active → dry-run sentinel unstable,
        # apply unsafe. Treat as WAIT (writer must finish).
        reasons.append("pin_products_writer.lock is held")
        rec = "WAIT"
    else:
        # No Pinterest contention, no writer. Dry-run is safe.
        # Apply additionally needs cooldown satisfied or explicitly waived.
        rec = "SAFE_FOR_DRY_RUN"
        cooldown_ok = args.waive_cooldown  # operator asserts cooldown satisfied
        if cooldown_ok:
            rec = "SAFE_FOR_APPLY"
        else:
            reasons.append(f"apply also requires --waive-cooldown or {args.cooldown_min}min since last Pinterest activity (operator-confirmed)")

    report["recommendation"] = rec
    report["reasons"] = reasons
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    # exit codes: 0 SAFE_FOR_*, 10 WAIT, 20 FAIL
    return 0 if rec.startswith("SAFE") else (10 if rec == "WAIT" else 20)


if __name__ == "__main__":
    sys.exit(main())
