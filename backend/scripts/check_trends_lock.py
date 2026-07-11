#!/usr/bin/env python3
"""Check trends pipeline lock state on VPS (run remotely)."""
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "db"))

from db import select_many

try:
    from pipeline_tracking import _purge_expired_locks, is_lock_held, release_lock
except ImportError:
    def is_lock_held(_name: str) -> bool:
        return False

    def _purge_expired_locks() -> None:
        pass

    def release_lock(_name: str) -> bool:
        return False


def main() -> None:
    _purge_expired_locks()
    locks = select_many("pipeline_locks", limit=20)
    runs = select_many("pipeline_runs", order="started_at.desc", limit=5)
    proc = subprocess.run(
        "ps aux | grep 'run_worker.py --job trends' | grep -v grep || true",
        shell=True,
        capture_output=True,
        text=True,
    )
    trends_locks = [l for l in locks if l.get("pipeline_name") == "trends"]
    stale_released = False
    for lock in trends_locks:
        held = is_lock_held("trends")
        active_proc = bool(proc.stdout.strip())
        if held and not active_proc:
            release_lock("trends")
            stale_released = True
    print(
        json.dumps(
            {
                "locks": locks,
                "trendsLocks": trends_locks,
                "recentRuns": runs,
                "trendsLockHeld": is_lock_held("trends"),
                "trendsProcess": proc.stdout.strip(),
                "staleTrendsLockReleased": stale_released,
            },
            default=str,
        )
    )


if __name__ == "__main__":
    main()
