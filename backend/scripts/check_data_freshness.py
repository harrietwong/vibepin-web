#!/usr/bin/env python3
"""
check_data_freshness.py — Read-only pipeline freshness audit + bottleneck hint.

Usage:
  python scripts/check_data_freshness.py
"""

from __future__ import annotations

import os
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "db"))


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)


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


def _fmt_ts(value: str | None) -> str:
    dt = _parse_dt(value)
    if dt is None:
        return value or "—"
    return dt.strftime("%Y-%m-%d %H:%M UTC")


def _count_table(http, table: str, filters: dict | None = None) -> int | None:
    try:
        params: dict = {"limit": "0", "select": "id"}
        for col, val in (filters or {}).items():
            params[col] = val if "." in str(val) else f"eq.{val}"
        resp = http.head(table, params=params, headers={"Prefer": "count=exact"})
        if resp.status_code not in (200, 206):
            return None
        cr = resp.headers.get("Content-Range", "")
        if "/" in cr:
            total = cr.split("/")[-1]
            return int(total) if total.isdigit() else None
    except Exception:
        pass
    return None


def _count_since(http, table: str, column: str, since: datetime) -> int | None:
    try:
        iso = since.isoformat()
        params = {
            "limit": "0",
            "select": "id",
            column: f"gte.{iso}",
        }
        resp = http.head(table, params=params, headers={"Prefer": "count=exact"})
        if resp.status_code not in (200, 206):
            return None
        cr = resp.headers.get("Content-Range", "")
        if "/" in cr:
            total = cr.split("/")[-1]
            return int(total) if total.isdigit() else None
    except Exception:
        pass
    return None


def _diagnose(
    *,
    pending: int | None,
    due_pending: int,
    completed: int | None,
    failed: int | None,
    max_pin_scraped: str | None,
    pins_24h: int | None,
    pins_7d: int | None,
    last_crawl: dict | None,
    last_daily: dict | None,
) -> str:
    now = _now()
    max_dt = _parse_dt(max_pin_scraped)
    stale_days = None
    if max_dt:
        stale_days = (now - max_dt).days

    if pending == 0:
        return "LIKELY BOTTLENECK: crawl_queue has 0 pending keywords (Cause B)"

    if pending and pending > 0 and due_pending > 0 and pins_24h == 0:
        return (
            "LIKELY BOTTLENECK: crawl_queue has due pending keywords but pin_samples "
            "not updated in 24h — local crawl not running (VPS has crawl disabled) (Cause C/J)"
        )

    if pending and pending > 0 and due_pending == 0:
        return (
            "LIKELY BOTTLENECK: pending keywords exist but none are due "
            "(next_crawl_at in future) — crawl exits with 0 work (Cause B variant)"
        )

    if last_crawl and last_crawl.get("status") == "completed":
        stats = last_crawl.get("stats") or {}
        if isinstance(stats, dict) and stats.get("skipped"):
            return "LIKELY BOTTLENECK: last crawl job skipped (no due items or replenish failed) (Cause B/C)"

    if max_dt and stale_days is not None and stale_days >= 3:
        if pins_7d == 0:
            return (
                f"LIKELY BOTTLENECK: pin_samples stale ({stale_days}d since max scraped_at) "
                "and 0 rows in last 7d — crawl not inserting/updating (Cause C/D/E)"
            )

    if last_daily and last_daily.get("status") == "completed" and stale_days and stale_days >= 3:
        return (
            "LIKELY BOTTLENECK: daily job completes but pin_samples not fresh — "
            "check VPS PINTEREST_SEARCH_CRAWL_ENABLED or local crawl task (Cause H/I/J)"
        )

    if pins_24h and pins_24h > 0:
        return "Freshness OK: pin_samples updated in last 24h"

    return "INCONCLUSIVE: review crawl_queue, pipeline_runs, and host crawl config"


def main() -> int:
    url = (os.environ.get("SUPABASE_URL") or "").strip()
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not key:
        print("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
        return 1

    host = urlparse(url).netloc or url

    try:
        from db import _get_http, select_many  # type: ignore
        from crawl_queue_ops import count_pending_items, is_due_for_crawl  # type: ignore
    except Exception as exc:
        print(f"Cannot load modules: {exc}")
        return 1

    http = _get_http()
    now = _now()
    since_24h = now - timedelta(hours=24)
    since_7d = now - timedelta(days=7)

    print("VibePin Data Freshness Audit")
    print("=" * 44)
    print(f"Current time:     {now.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"Supabase host:    {host}")
    print()

    # pin_samples
    pins_total = _count_table(http, "pin_samples")
    pin_eligible = _count_table(http, "pin_samples", {"is_reference_eligible": "true"})
    pin_null_elig = _count_table(http, "pin_samples", {"is_reference_eligible": "is.null"})
    pin_no_image = _count_table(http, "pin_samples", {"image_url": "is.null"})
    pins_24h = _count_since(http, "pin_samples", "scraped_at", since_24h)
    pins_7d = _count_since(http, "pin_samples", "scraped_at", since_7d)

    pin_rows = select_many("pin_samples", order="scraped_at.desc", limit=1)
    max_pin_scraped = pin_rows[0].get("scraped_at") if pin_rows else None

    print("pin_samples:")
    print(f"  total:                 {pins_total if pins_total is not None else '—'}")
    print(f"  latest scraped_at:     {_fmt_ts(max_pin_scraped)}")
    print(f"  scraped last 24h:      {pins_24h if pins_24h is not None else '—'}")
    print(f"  scraped last 7d:       {pins_7d if pins_7d is not None else '—'}")
    print(f"  is_reference_eligible: {pin_eligible if pin_eligible is not None else '—'}")
    print(f"  eligibility null:      {pin_null_elig if pin_null_elig is not None else '—'}")
    print(f"  image_url null:        {pin_no_image if pin_no_image is not None else '—'}")
    print()

    # crawl_queue
    pending = _count_table(http, "crawl_queue", {"status": "pending"})
    completed = _count_table(http, "crawl_queue", {"status": "completed"})
    done = _count_table(http, "crawl_queue", {"status": "done"})
    failed = _count_table(http, "crawl_queue", {"status": "failed"})
    running = _count_table(http, "crawl_queue", {"status": "processing"})

    pending_rows = select_many(
        "crawl_queue",
        filters={"status": "pending"},
        order="updated_at.desc",
        limit=5000,
    )
    due_pending = sum(1 for r in pending_rows if is_due_for_crawl(r, now))
    cq_updated = pending_rows[0].get("updated_at") if pending_rows else None
    if not cq_updated:
        cq_all = select_many("crawl_queue", order="updated_at.desc", limit=1)
        cq_updated = cq_all[0].get("updated_at") if cq_all else None

    print("crawl_queue:")
    print(f"  pending (total):       {pending if pending is not None else '—'}")
    print(f"  pending (due now):     {due_pending}")
    print(f"  processing:            {running if running is not None else '—'}")
    done_total = (completed or 0) + (done or 0) if completed is not None or done is not None else None
    print(f"  completed:             {done_total if done_total is not None else '—'}")
    print(f"  failed:                {failed if failed is not None else '—'}")
    print(f"  newest updated_at:     {_fmt_ts(cq_updated)}")
    print()

    # trend_keywords
    kw_total = _count_table(http, "trend_keywords")
    kw_created_rows = select_many("trend_keywords", order="created_at.desc", limit=1)
    print("trend_keywords:")
    print(f"  total:                 {kw_total if kw_total is not None else '—'}")
    print(f"  latest created_at:     {_fmt_ts(kw_created_rows[0].get('created_at') if kw_created_rows else None)}")
    print()

    # pin_products
    prod_total = _count_table(http, "pin_products")
    prod_phys = _count_table(http, "pin_products", {"product_type": "physical"})
    prod_digi = _count_table(http, "pin_products", {"product_type": "digital"})
    prod_null = _count_table(http, "pin_products", {"product_type": "is.null"})
    prod_rows = select_many("pin_products", order="scraped_at.desc", limit=1)
    print("pin_products:")
    print(f"  total:                 {prod_total if prod_total is not None else '—'}")
    print(f"  latest scraped_at:     {_fmt_ts(prod_rows[0].get('scraped_at') if prod_rows else None)}")
    print(f"  physical:              {prod_phys if prod_phys is not None else '—'}")
    print(f"  digital:               {prod_digi if prod_digi is not None else '—'}")
    print(f"  product_type null:     {prod_null if prod_null is not None else '—'}")
    print()

    # opportunities
    opp_total = _count_table(http, "opportunities")
    opp_rows = select_many("opportunities", order="updated_at.desc", limit=1)
    print("opportunities:")
    print(f"  total:                 {opp_total if opp_total is not None else '—'}")
    print(f"  latest updated_at:     {_fmt_ts(opp_rows[0].get('updated_at') if opp_rows else None)}")
    print()

    # pipeline locks
    try:
        locks = select_many("pipeline_locks", limit=50)
    except Exception:
        locks = []
    active_locks = [l for l in locks if l.get("expires_at") and (_parse_dt(l["expires_at"]) or now) > now]
    print("pipeline_locks:")
    print(f"  active:                {len(active_locks)}")
    for lk in active_locks[:5]:
        print(f"    • {lk.get('lock_name', '?')} expires {_fmt_ts(lk.get('expires_at'))}")
    print()

    # pipeline runs
    try:
        runs = select_many("pipeline_runs", order="started_at.desc", limit=10)
    except Exception:
        runs = []
    print("Latest pipeline_runs (10):")
    if not runs:
        print("  (none)")
    for row in runs:
        started = _parse_dt(row.get("started_at"))
        finished = _parse_dt(row.get("finished_at"))
        dur = ""
        if started and finished:
            dur = f"  {int((finished - started).total_seconds())}s"
        err = row.get("error_message") or row.get("error") or ""
        err_short = (str(err)[:80] + "…") if err and len(str(err)) > 80 else err
        print(
            f"  • {row.get('job_type', '?'):10} "
            f"{row.get('status', '?'):10} "
            f"started {_fmt_ts(row.get('started_at'))}{dur}"
            + (f"  err={err_short}" if err_short else "")
        )
    print()

    last_crawl = next((r for r in runs if r.get("job_type") == "crawl"), None)
    last_daily = next((r for r in runs if r.get("job_type") == "daily"), None)

    diagnosis = _diagnose(
        pending=pending,
        due_pending=due_pending,
        completed=done_total,
        failed=failed,
        max_pin_scraped=max_pin_scraped,
        pins_24h=pins_24h,
        pins_7d=pins_7d,
        last_crawl=last_crawl,
        last_daily=last_daily,
    )
    print("Diagnosis:")
    print(f"  {diagnosis}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
