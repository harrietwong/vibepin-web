#!/usr/bin/env python3
"""Clear stale pipeline locks and running records."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "db"))

try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env")
except ImportError:
    pass

from db import _get_http, select_many, update_where  # type: ignore


def main() -> int:
    http = _get_http()
    locks = select_many("pipeline_locks", limit=50)
    for lk in locks:
        name = lk.get("lock_name")
        if name:
            http.delete("pipeline_locks", params={"lock_name": f"eq.{name}"})
            print(f"removed lock {name}")
    runs = select_many("pipeline_runs", filters={"status": "running"}, limit=50)
    for r in runs:
        update_where(
            "pipeline_runs",
            {"status": "failed", "error_message": "stale_run_cleared"},
            {"id": r["id"]},
        )
        print(f"cleared {r.get('job_type')} {r.get('id')}")
    print(f"done: {len(runs)} stale runs, all locks removed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
