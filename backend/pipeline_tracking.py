"""
pipeline_tracking.py — Pipeline run records and distributed job locks.

Used by run_worker.py for cloud/VPS cron execution.
"""

from __future__ import annotations

import json
import os
import socket
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from typing import Any, Generator, Optional

ROOT = __import__("pathlib").Path(__file__).parent

LOCK_TIMEOUTS_SEC: dict[str, int] = {
    "trends":        3_600,   # 1 h
    "crawl":         7_200,   # 2 h
    "stl-score":     5_400,   # 1.5 h
    "classify":      3_600,   # 1 h
    "opportunities": 5_400,   # 1.5 h (sequential per-keyword upserts)
    "daily":        10_800,   # 3 h
}

CHILD_LOCKS = ("trends", "crawl", "stl-score")


def _db():
    import sys
    sys.path.insert(0, str(ROOT / "db"))
    from db import upsert, select_many, select_one, update_where  # type: ignore
    return upsert, select_many, select_one, update_where


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


def _iso(dt: datetime | None = None) -> str:
    return (dt or _now()).isoformat()


def worker_identity(created_by: str = "cloud") -> str:
    host = socket.gethostname()
    pid = os.getpid()
    return f"{created_by}:{host}:{pid}"


def _purge_expired_locks() -> None:
    """Remove locks past expires_at."""
    try:
        from db import _get_http  # type: ignore
        http = _get_http()
        http.delete("pipeline_locks", params={"expires_at": f"lt.{_iso()}"})
    except Exception:
        pass


def is_lock_held(lock_name: str) -> bool:
    """True if a non-expired lock exists."""
    _purge_expired_locks()
    _, _, select_one, _ = _db()
    try:
        row = select_one("pipeline_locks", {"lock_name": lock_name})
        if not row:
            return False
        expires = row.get("expires_at")
        if not expires:
            return True
        exp_dt = datetime.fromisoformat(expires.replace("Z", "+00:00"))
        if exp_dt.tzinfo is None:
            exp_dt = exp_dt.replace(tzinfo=timezone.utc)
        return exp_dt > _now()
    except Exception:
        return False


def any_child_lock_held() -> Optional[str]:
    for name in CHILD_LOCKS:
        if is_lock_held(name):
            return name
    return None


def acquire_lock(lock_name: str, locked_by: str, run_id: str | None = None) -> bool:
    """
    Acquire lock if not held. Returns True on success, False if already locked.
    """
    _purge_expired_locks()
    if is_lock_held(lock_name):
        return False
    if lock_name == "daily":
        if any_child_lock_held():
            return False

    upsert, _, select_one, _ = _db()
    timeout = LOCK_TIMEOUTS_SEC.get(lock_name, 3_600)
    expires = _now() + timedelta(seconds=timeout)
    try:
        upsert("pipeline_locks", [{
            "lock_name":  lock_name,
            "locked_at":  _iso(),
            "locked_by":  locked_by,
            "expires_at": _iso(expires),
            "run_id":     run_id,
        }], on_conflict="lock_name")
        row = select_one("pipeline_locks", {"lock_name": lock_name})
        return bool(row and row.get("locked_by") == locked_by)
    except Exception:
        return False


def release_lock(lock_name: str) -> None:
    try:
        from db import _get_http  # type: ignore
        http = _get_http()
        http.delete("pipeline_locks", params={"lock_name": f"eq.{lock_name}"})
    except Exception:
        pass


def start_run(
    job_type: str,
    created_by: str = "cloud",
    metadata: dict | None = None,
) -> dict:
    """Insert pipeline_runs row with status=running."""
    upsert, _, _, _ = _db()
    run_id = str(uuid.uuid4())
    row = {
        "id":         run_id,
        "job_type":   job_type,
        "status":     "running",
        "started_at": _iso(),
        "created_by": created_by,
        "metadata":   metadata or {},
    }
    try:
        upsert("pipeline_runs", [row], on_conflict="id")
    except Exception:
        pass
    return row


def finish_run(
    run_id: str,
    status: str,
    *,
    started_at: str | None = None,
    error_message: str | None = None,
    rows_processed: int = 0,
    keywords_processed: int = 0,
    metadata: dict | None = None,
) -> None:
    """Update pipeline_runs on completion."""
    _, _, _, update_where = _db()
    finished = _now()
    duration = None
    if started_at:
        try:
            st = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
            if st.tzinfo is None:
                st = st.replace(tzinfo=timezone.utc)
            duration = round((finished - st).total_seconds(), 2)
        except Exception:
            pass

    updates: dict[str, Any] = {
        "status":            status,
        "finished_at":       _iso(finished),
        "duration_seconds":  duration,
        "rows_processed":    rows_processed,
        "keywords_processed": keywords_processed,
    }
    if error_message:
        updates["error_message"] = error_message[:2000]
    if metadata:
        updates["metadata"] = metadata

    try:
        update_where("pipeline_runs", updates, {"id": run_id})
    except Exception:
        pass


def get_last_completed_run(job_type: str) -> dict | None:
    """Most recent completed run for a job type."""
    _, select_many, _, _ = _db()
    try:
        rows = select_many(
            "pipeline_runs",
            filters={"job_type": job_type, "status": "completed"},
            order="finished_at.desc",
            limit=1,
        )
        return rows[0] if rows else None
    except Exception:
        return None


@contextmanager
def pipeline_job(
    job_type: str,
    created_by: str = "cloud",
    metadata: dict | None = None,
) -> Generator[dict, None, None]:
    """
    Context manager: acquire lock, start run, yield run dict, finish on exit.

    Yields {"run_id", "skipped": True} when lock not acquired (exits cleanly).
    """
    identity = worker_identity(created_by)
    run = start_run(job_type, created_by=created_by, metadata=metadata)
    run_id = run["id"]

    if not acquire_lock(job_type, identity, run_id=run_id):
        finish_run(run_id, "skipped", started_at=run.get("started_at"),
                   metadata={"reason": "lock_held", "lock_name": job_type})
        yield {"run_id": run_id, "skipped": True, "job_type": job_type}
        return

    ctx = {"run_id": run_id, "skipped": False, "job_type": job_type,
           "started_at": run.get("started_at"), "stats": {}}
    try:
        yield ctx
        stats = ctx.get("stats") or {}
        finish_run(
            run_id, "completed",
            started_at=run.get("started_at"),
            rows_processed=int(stats.get("pins", stats.get("rows", 0))),
            keywords_processed=int(stats.get("processed", stats.get("keywords", 0))),
            metadata=stats,
        )
    except Exception as exc:
        finish_run(
            run_id, "failed",
            started_at=run.get("started_at"),
            error_message=str(exc),
            metadata=ctx.get("stats") or {},
        )
        raise
    finally:
        release_lock(job_type)
