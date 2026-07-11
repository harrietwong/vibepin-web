"""Tests for crawl_queue scheduling with refreshCadence."""

from __future__ import annotations

from datetime import datetime, timezone, timedelta

from crawl_queue_ops import plan_crawl_queue_row, compute_success_next_crawl_at


def test_plan_crawl_queue_row_respects_next_crawl_at():
    now = datetime(2026, 6, 8, 12, 0, tzinfo=timezone.utc)
    now_iso = now.isoformat()
    future = (now + timedelta(days=3)).isoformat()
    row = plan_crawl_queue_row(
        None,
        keyword="test keyword",
        priority_score=40,
        source_interest="home_decor",
        category="home-decor",
        now_iso=now_iso,
        next_crawl_at=future,
    )
    assert row is not None
    assert row["next_crawl_at"] == future


def test_compute_success_next_crawl_at_uses_cadence():
    now = datetime(2026, 6, 8, 12, 0, tzinfo=timezone.utc)
    weekly = compute_success_next_crawl_at(30, now, refresh_cadence="weekly")
    dt = datetime.fromisoformat(weekly)
    assert (dt - now).days == 7
