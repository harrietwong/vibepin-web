#!/usr/bin/env python3
"""
job_entry.py — shared cron-safe runner for the independent pipeline jobs
(run_crawl.py / run_classify.py / run_opportunities.py).

Wraps one unit of work in `pipeline_job` (DB run-tracking + a distributed lock)
with `[tag]` logging (counts + duration).

Cron contract:
  - exit 0 on success
  - exit 0 on skip (another run holds the lock — not a failure)
  - exit 1 on failure (exception propagates; never reports success on failure)

This does NOT change business logic — it only provides an execution boundary so
each job can run independently of the others (and of STL / Playwright).
"""
from __future__ import annotations

import asyncio
import sys
import time
import traceback
from pathlib import Path
from typing import Awaitable, Callable

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from pipeline_tracking import pipeline_job  # noqa: E402


def log(tag: str, msg: str) -> None:
    print(f"[{tag}] {msg}", flush=True)


def _fmt_stats(stats: dict) -> str:
    if not stats:
        return "(no stats)"
    return " ".join(f"{k}={v}" for k, v in stats.items())


async def _run(job_type: str, tag: str,
               work: Callable[[dict], Awaitable[None]], created_by: str) -> int:
    start = time.monotonic()
    log(tag, f"start (job={job_type}, by={created_by})")
    try:
        with pipeline_job(job_type, created_by=created_by) as ctx:
            if ctx.get("skipped"):
                log(tag, f"skipped — lock '{job_type}' held by another run (exit 0)")
                return 0
            await work(ctx)
            stats = ctx.get("stats") or {}
        # work() prints the job-specific metric lines; we emit duration + a summary.
        log(tag, f"duration={time.monotonic() - start:.1f}s")
        log(tag, f"status=completed ({_fmt_stats(stats)})")
        return 0
    except Exception as exc:
        # pipeline_job already marked the run failed and re-raised; surface loudly.
        log(tag, f"FAILED after {time.monotonic() - start:.1f}s: {exc}")
        traceback.print_exc()
        return 1


def run_job(job_type: str, tag: str,
            work: Callable[[dict], Awaitable[None]], *, created_by: str = "cloud") -> int:
    """Synchronous entrypoint used by the run_*.py scripts. Returns a process exit code."""
    try:
        return asyncio.run(_run(job_type, tag, work, created_by))
    except KeyboardInterrupt:
        log(tag, "interrupted")
        return 130
