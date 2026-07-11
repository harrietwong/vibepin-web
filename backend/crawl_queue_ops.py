"""
crawl_queue_ops.py — Crawl queue scheduling, requeue, and selection logic.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

MIN_PENDING_FOR_CRAWL = 20
MIN_PENDING_KEYWORDS = 50
RECRAWL_AFTER_DAYS = 7
MAX_REQUEUE_PER_RUN = 200
STALE_CRAWL_DAYS = 7
MAX_FAILED_ATTEMPTS = 3
MAX_CRAWL_CONCURRENCY = 5
DEFAULT_CRAWL_CONCURRENCY = 3

DONE_STATUSES = frozenset({"done", "completed"})
RUNNING_STATUSES = frozenset({"running", "processing"})

SUCCESS_INTERVAL_DAYS = {"high": 1, "medium": 3, "low": 7}
PRIORITY_HIGH_THRESHOLD = 50.0
PRIORITY_MEDIUM_THRESHOLD = 20.0


def clamp_concurrency(value: int) -> int:
    return max(1, min(int(value), MAX_CRAWL_CONCURRENCY))


def _parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except Exception:
        return None


def priority_tier(priority_score: float) -> str:
    if priority_score >= PRIORITY_HIGH_THRESHOLD:
        return "high"
    if priority_score >= PRIORITY_MEDIUM_THRESHOLD:
        return "medium"
    return "low"


def is_stale_last_crawled(last_crawled_at: str | None, now: datetime, stale_days: int = STALE_CRAWL_DAYS) -> bool:
    dt = _parse_dt(last_crawled_at)
    if dt is None:
        return True
    return (now - dt) >= timedelta(days=stale_days)


def is_due_for_crawl(item: dict, now: datetime) -> bool:
    """Pending item is due when next_crawl_at is null or <= now."""
    if (item.get("status") or "").lower() != "pending":
        return False
    nca = item.get("next_crawl_at")
    if nca is None:
        return True
    dt = _parse_dt(nca)
    if dt is None:
        return True
    return dt <= now


def sort_crawl_queue_items(items: list[dict]) -> list[dict]:
    """priority_score DESC, attempts ASC, created_at ASC."""
    def _key(row: dict) -> tuple:
        created = row.get("created_at") or ""
        return (
            -float(row.get("priority_score") or 0),
            int(row.get("attempts") or 0),
            created,
        )
    return sorted(items, key=_key)


def select_due_crawl_items(
    items: list[dict],
    now: datetime | None = None,
    limit: int = 0,
) -> list[dict]:
    """Filter pending+due items and return ordered slice."""
    now = now or datetime.now(tz=timezone.utc)
    due = [i for i in items if is_due_for_crawl(i, now)]
    ordered = sort_crawl_queue_items(due)
    if limit and limit > 0:
        return ordered[:limit]
    return ordered


def compute_success_next_crawl_at(
    priority_score: float,
    now: datetime,
    refresh_cadence: str | None = None,
) -> str:
    """After successful crawl — prefer seed refreshCadence when provided."""
    if refresh_cadence:
        try:
            from trend_seed_pipeline import next_crawl_at_from_cadence  # type: ignore
            nca = next_crawl_at_from_cadence(now, refresh_cadence)
            if nca:
                return nca
        except ImportError:
            pass
    tier = priority_tier(priority_score)
    days = SUCCESS_INTERVAL_DAYS[tier]
    return (now + timedelta(days=days)).isoformat()


def compute_failure_update(
    current_attempts: int,
    now: datetime,
    error: str = "",
    max_attempts: int = MAX_FAILED_ATTEMPTS,
) -> dict:
    """Return crawl_queue update fields after a failed keyword crawl."""
    new_attempts = int(current_attempts or 0) + 1
    now_iso = now.isoformat()
    if new_attempts >= max_attempts:
        return {
            "status": "failed",
            "attempts": new_attempts,
            "last_error": error[:500] if error else None,
            "updated_at": now_iso,
        }
    backoff_hours = min(24, 2 ** new_attempts)
    next_at = (now + timedelta(hours=backoff_hours)).isoformat()
    return {
        "status": "pending",
        "attempts": new_attempts,
        "next_crawl_at": next_at,
        "last_error": error[:500] if error else None,
        "updated_at": now_iso,
    }


def compute_completion_update(
    priority_score: float,
    now: datetime,
    refresh_cadence: str | None = None,
) -> dict:
    """Return crawl_queue update fields after successful crawl."""
    now_iso = now.isoformat()
    return {
        "status": "completed",
        "last_crawled_at": now_iso,
        "next_crawl_at": compute_success_next_crawl_at(
            priority_score, now, refresh_cadence=refresh_cadence,
        ),
        "attempts": 0,
        "last_error": None,
        "updated_at": now_iso,
    }


def plan_crawl_queue_row(
    existing: dict | None,
    *,
    keyword: str,
    priority_score: float,
    source_interest: str,
    category: str,
    now_iso: str,
    next_crawl_at: str | None = None,
    stale_days: int = STALE_CRAWL_DAYS,
    max_failed_attempts: int = MAX_FAILED_ATTEMPTS,
    now: datetime | None = None,
) -> dict | None:
    if not keyword:
        return None

    now_dt = now or datetime.fromisoformat(now_iso.replace("Z", "+00:00"))
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)

    scheduled_at = next_crawl_at or now_iso

    base = {
        "keyword": keyword,
        "source_interest": source_interest,
        "category": category,
        "priority_score": priority_score,
        "next_crawl_at": scheduled_at,
    }

    if existing is None:
        return {**base, "status": "pending", "updated_at": now_iso}

    status = (existing.get("status") or "pending").lower()

    if status in RUNNING_STATUSES:
        return None

    if status == "pending":
        current = float(existing.get("priority_score") or 0)
        row = {**base, "status": "pending", "updated_at": now_iso}
        row["priority_score"] = max(current, priority_score)
        if not existing.get("next_crawl_at"):
            row["next_crawl_at"] = scheduled_at
        else:
            row.pop("next_crawl_at", None)
        return row

    if status in DONE_STATUSES:
        if is_stale_last_crawled(existing.get("last_crawled_at"), now_dt, stale_days):
            return {
                **base,
                "status": "pending",
                "attempts": 0,
                "last_error": None,
                "updated_at": now_iso,
            }
        return None

    if status == "failed":
        attempts = int(existing.get("attempts") or 0)
        if attempts < max_failed_attempts:
            return {**base, "status": "pending", "updated_at": now_iso}
        return None

    return None


def classify_queue_plan(existing: dict | None, planned: dict | None) -> str:
    """Return a compact action label for logging/tests."""
    if planned is None:
        return "skipped"
    if existing is None:
        return "inserted"

    status = (existing.get("status") or "pending").lower()
    if status == "pending":
        return "updated_pending"
    if status in DONE_STATUSES:
        return "requeued"
    if status == "failed":
        return "requeued_failed"
    return "updated"


def count_pending_items(select_many_fn: Callable[..., list], *, due_only: bool = True) -> int:
    rows = select_many_fn(
        "crawl_queue",
        filters={"status": "pending"},
        limit=10_000,
    )
    if not due_only:
        return len(rows)
    now = datetime.now(tz=timezone.utc)
    return sum(1 for r in rows if is_due_for_crawl(r, now))


# crawl_queue.source_interest values written by the manual/CSV seed bootstrap.
BOOTSTRAP_SOURCE_INTERESTS = ("manual_bootstrap", "csv_bootstrap")


def fetch_due_crawl_items(
    select_many_fn: Callable[..., list],
    *,
    category: str | None = None,
    limit: int = 0,
    first_crawl: bool = False,
) -> list[dict]:
    filters: dict = {"status": "pending"}
    if category:
        filters["category"] = category
    rows = select_many_fn(
        "crawl_queue",
        filters=filters,
        order="priority_score.desc,attempts.asc,created_at.asc",
        limit=10_000,
    )
    if first_crawl:
        # One-time first crawl of freshly-bootstrapped seeds: bypass the
        # next_crawl_at due gate for THIS selection only. Restricted to
        # bootstrap rows (by source_interest) so legacy not-yet-due rows are
        # never pulled in. Stored next_crawl_at is untouched — the normal
        # success/failure update logic reschedules each row as usual.
        boot = [r for r in rows if (r.get("source_interest") in BOOTSTRAP_SOURCE_INTERESTS)]
        ordered = sort_crawl_queue_items(boot)
        return ordered[:limit] if (limit and limit > 0) else ordered
    return select_due_crawl_items(rows, limit=limit)


def requeue_stale_completed_items(
    select_many_fn: Callable[..., list],
    update_where_fn: Callable[..., list],
    *,
    min_due_pending: int = MIN_PENDING_KEYWORDS,
    stale_days: int = RECRAWL_AFTER_DAYS,
    max_requeue: int = MAX_REQUEUE_PER_RUN,
) -> int:
    """
    When due pending count is below min_due_pending, requeue stale completed/done
    keywords so crawl has work without waiting for a full trends run.
    """
    now = datetime.now(tz=timezone.utc)
    due_pending = count_pending_items(select_many_fn, due_only=True)
    if due_pending >= min_due_pending:
        return 0

    rows = select_many_fn(
        "crawl_queue",
        filters={"status": "completed"},
        order="last_crawled_at.asc",
        limit=max_requeue * 2,
    )
    done_rows = select_many_fn(
        "crawl_queue",
        filters={"status": "done"},
        order="updated_at.asc",
        limit=max_requeue,
    )
    candidates = rows + done_rows
    requeued = 0
    now_iso = now.isoformat()

    for item in candidates:
        if requeued >= max_requeue:
            break
        status = (item.get("status") or "").lower()
        if status not in DONE_STATUSES:
            continue
        last = item.get("last_crawled_at") or item.get("updated_at")
        if not is_stale_last_crawled(last, now, stale_days):
            continue
        keyword = item.get("keyword")
        if not keyword:
            continue
        try:
            update_where_fn(
                "crawl_queue",
                {
                    "status": "pending",
                    "next_crawl_at": now_iso,
                    "attempts": 0,
                    "last_error": None,
                    "updated_at": now_iso,
                },
                {"keyword": keyword},
            )
            requeued += 1
        except Exception:
            pass
    return requeued
