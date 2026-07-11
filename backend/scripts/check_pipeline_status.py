#!/usr/bin/env python3
"""
check_pipeline_status.py — Print pipeline health for cloud or local debugging.

Usage:
  python scripts/check_pipeline_status.py
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from pathlib import Path

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


def _fmt_ts(value: str | None) -> str:
    if not value:
        return "—"
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.strftime("%Y-%m-%d %H:%M UTC")
    except Exception:
        return value


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
        return None
    except Exception:
        return None


def _latest_run(select_many, job_type: str) -> dict | None:
    try:
        rows = select_many(
            "pipeline_runs",
            filters={"job_type": job_type},
            order="started_at.desc",
            limit=1,
        )
        return rows[0] if rows else None
    except Exception:
        return None


def _last_success(select_many, job_type: str) -> dict | None:
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


def _max_scraped_at(select_many, table: str, column: str = "scraped_at") -> str | None:
    try:
        rows = select_many(table, order=f"{column}.desc", limit=1)
        if rows:
            return rows[0].get(column)
    except Exception:
        pass
    return None


def main() -> int:
    url = (os.environ.get("SUPABASE_URL") or "").strip()
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
    if not url or not key:
        print("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY")
        print("   Set env vars and re-run: python scripts/check_pipeline_status.py")
        return 1

    try:
        from db import _get_http, select_many  # type: ignore
    except Exception as exc:
        print(f"❌ Cannot load db module: {exc}")
        return 1

    http = _get_http()

    print("VibePin Pipeline Status")
    print("=" * 40)

    # Recent runs (any status)
    try:
        recent = select_many("pipeline_runs", order="started_at.desc", limit=8)
    except Exception as exc:
        print(f"⚠ pipeline_runs unavailable: {exc}")
        recent = []

    if recent:
        print("\nLast pipeline_runs:")
        for row in recent:
            print(
                f"  • {row.get('job_type', '?'):10} "
                f"{row.get('status', '?'):10} "
                f"started {_fmt_ts(row.get('started_at'))} "
                f"finished {_fmt_ts(row.get('finished_at'))}"
            )
    else:
        print("\nLast pipeline_runs: (none yet)")

    for job in ("trends", "crawl", "stl-score", "daily", "smoke"):
        run = _last_success(select_many, job)
        if run:
            print(
                f"\nLast successful {job}:"
                f" {_fmt_ts(run.get('finished_at'))}"
                f"  keywords={run.get('keywords_processed', 0)}"
                f"  rows={run.get('rows_processed', 0)}"
            )
        elif job in ("trends", "crawl", "stl-score"):
            latest = _latest_run(select_many, job)
            if latest:
                print(
                    f"\nLast successful {job}: (none)"
                    f"  latest attempt: {latest.get('status')} at {_fmt_ts(latest.get('started_at'))}"
                )
            else:
                print(f"\nLast successful {job}: (none)")

    pending = _count_table(http, "crawl_queue", {"status": "pending"})
    completed = _count_table(http, "crawl_queue", {"status": "completed"})
    failed = _count_table(http, "crawl_queue", {"status": "failed"})
    done = _count_table(http, "crawl_queue", {"status": "done"})

    print("\ncrawl_queue:")
    print(f"  pending:   {pending if pending is not None else '—'}")
    done_total = (completed or 0) + (done or 0) if completed is not None or done is not None else None
    print(f"  completed: {done_total if done_total is not None else '—'}")
    print(f"  failed:    {failed if failed is not None else '—'}")

    products = _count_table(http, "pin_products")
    pins = _count_table(http, "pin_samples")
    keywords = _count_table(http, "trend_keywords")

    print("\nData counts:")
    print(f"  product ideas (pin_products): {products if products is not None else '—'}")
    print(f"  pin ideas (pin_samples):      {pins if pins is not None else '—'}")
    print(f"  trend_keywords:                 {keywords if keywords is not None else '—'}")

    prod_scraped = _max_scraped_at(select_many, "pin_products")
    pin_scraped = _max_scraped_at(select_many, "pin_samples")
    kw_updated = _max_scraped_at(select_many, "trend_keywords", "updated_at")

    print("\nLast updated timestamps:")
    print(f"  pin_products.scraped_at:   {_fmt_ts(prod_scraped)}")
    print(f"  pin_samples.scraped_at:    {_fmt_ts(pin_scraped)}")
    print(f"  trend_keywords.updated_at: {_fmt_ts(kw_updated)}")

    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
