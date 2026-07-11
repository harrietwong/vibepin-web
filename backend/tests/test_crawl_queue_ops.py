"""Unit tests for crawl_queue replenish and merge logic."""

import unittest
from datetime import datetime, timedelta, timezone

from crawl_queue_ops import (
    MAX_FAILED_ATTEMPTS,
    MIN_PENDING_FOR_CRAWL,
    STALE_CRAWL_DAYS,
    count_pending_items,
    is_stale_last_crawled,
    plan_crawl_queue_row,
)


class TestPlanCrawlQueueRow(unittest.TestCase):
    NOW = datetime(2026, 6, 8, 12, 0, 0, tzinfo=timezone.utc)
    NOW_ISO = NOW.isoformat()

    def test_insert_new_keyword(self):
        row = plan_crawl_queue_row(
            None,
            keyword="cozy decor",
            priority_score=42.0,
            source_interest="home_decor",
            category="home-decor",
            now_iso=self.NOW_ISO,
            now=self.NOW,
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["keyword"], "cozy decor")
        self.assertIn("next_crawl_at", row)

    def test_pending_keeps_pending_and_bumps_priority(self):
        existing = {"status": "pending", "priority_score": 10}
        row = plan_crawl_queue_row(
            existing,
            keyword="cozy decor",
            priority_score=42.0,
            source_interest="home_decor",
            category="home-decor",
            now_iso=self.NOW_ISO,
            now=self.NOW,
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["priority_score"], 42.0)

    def test_running_not_modified(self):
        for status in ("running", "processing"):
            row = plan_crawl_queue_row(
                {"status": status, "priority_score": 5},
                keyword="cozy decor",
                priority_score=99.0,
                source_interest="home_decor",
                category="home-decor",
                now_iso=self.NOW_ISO,
                now=self.NOW,
            )
            self.assertIsNone(row)

    def test_stale_done_requeued(self):
        old = (self.NOW - timedelta(days=STALE_CRAWL_DAYS + 1)).isoformat()
        row = plan_crawl_queue_row(
            {"status": "completed", "last_crawled_at": old, "attempts": 2},
            keyword="cozy decor",
            priority_score=50.0,
            source_interest="home_decor",
            category="home-decor",
            now_iso=self.NOW_ISO,
            now=self.NOW,
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["status"], "pending")
        self.assertEqual(row["attempts"], 0)

    def test_recent_done_skipped(self):
        recent = (self.NOW - timedelta(days=1)).isoformat()
        row = plan_crawl_queue_row(
            {"status": "done", "last_crawled_at": recent},
            keyword="cozy decor",
            priority_score=50.0,
            source_interest="home_decor",
            category="home-decor",
            now_iso=self.NOW_ISO,
            now=self.NOW,
        )
        self.assertIsNone(row)

    def test_failed_requeued_under_attempt_limit(self):
        row = plan_crawl_queue_row(
            {"status": "failed", "attempts": 2},
            keyword="cozy decor",
            priority_score=50.0,
            source_interest="home_decor",
            category="home-decor",
            now_iso=self.NOW_ISO,
            now=self.NOW,
            max_failed_attempts=MAX_FAILED_ATTEMPTS,
        )
        self.assertIsNotNone(row)
        assert row is not None
        self.assertEqual(row["status"], "pending")

    def test_failed_not_requeued_at_attempt_limit(self):
        row = plan_crawl_queue_row(
            {"status": "failed", "attempts": MAX_FAILED_ATTEMPTS},
            keyword="cozy decor",
            priority_score=50.0,
            source_interest="home_decor",
            category="home-decor",
            now_iso=self.NOW_ISO,
            now=self.NOW,
        )
        self.assertIsNone(row)

    def test_no_duplicate_keyword_in_plan(self):
        """plan_crawl_queue_row always keys on keyword string — one row per keyword."""
        row = plan_crawl_queue_row(
            None,
            keyword="unique kw",
            priority_score=1.0,
            source_interest="art",
            category="art",
            now_iso=self.NOW_ISO,
            now=self.NOW,
        )
        self.assertEqual(row["keyword"], "unique kw")


class TestCountPending(unittest.TestCase):
    def test_count_pending_items(self):
        def fake_select(table, filters=None, order=None, limit=None):
            self.assertEqual(table, "crawl_queue")
            self.assertEqual(filters, {"status": "pending"})
            return [{"keyword": "a"}, {"keyword": "b"}]

        self.assertEqual(count_pending_items(fake_select, due_only=False), 2)


class TestStaleHelper(unittest.TestCase):
    def test_null_last_crawled_is_stale(self):
        now = datetime.now(tz=timezone.utc)
        self.assertTrue(is_stale_last_crawled(None, now))


class TestConstants(unittest.TestCase):
    def test_min_pending_threshold(self):
        self.assertEqual(MIN_PENDING_FOR_CRAWL, 20)


if __name__ == "__main__":
    unittest.main()
