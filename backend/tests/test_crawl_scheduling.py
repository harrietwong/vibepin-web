"""Unit tests for incremental crawl scheduling."""

import unittest
from datetime import datetime, timedelta, timezone

from crawl_queue_ops import (
    compute_completion_update,
    compute_failure_update,
    compute_success_next_crawl_at,
    is_due_for_crawl,
    priority_tier,
    select_due_crawl_items,
    sort_crawl_queue_items,
    clamp_concurrency,
    MAX_CRAWL_CONCURRENCY,
    DEFAULT_CRAWL_CONCURRENCY,
)


class TestCrawlScheduling(unittest.TestCase):
    NOW = datetime(2026, 6, 8, 12, 0, 0, tzinfo=timezone.utc)

    def test_priority_tiers(self):
        self.assertEqual(priority_tier(60), "high")
        self.assertEqual(priority_tier(30), "medium")
        self.assertEqual(priority_tier(5), "low")

    def test_success_next_crawl_high_priority_1_day(self):
        nca = compute_success_next_crawl_at(60, self.NOW)
        dt = datetime.fromisoformat(nca.replace("Z", "+00:00"))
        self.assertEqual((dt - self.NOW).days, 1)

    def test_success_next_crawl_low_priority_7_days(self):
        nca = compute_success_next_crawl_at(5, self.NOW)
        dt = datetime.fromisoformat(nca.replace("Z", "+00:00"))
        self.assertEqual((dt - self.NOW).days, 7)

    def test_failure_backoff_requeues_pending(self):
        upd = compute_failure_update(1, self.NOW, error="timeout")
        self.assertEqual(upd["status"], "pending")
        self.assertEqual(upd["attempts"], 2)
        self.assertIn("next_crawl_at", upd)

    def test_failure_max_attempts_marks_failed(self):
        upd = compute_failure_update(3, self.NOW, error="timeout")
        self.assertEqual(upd["status"], "failed")
        self.assertEqual(upd["attempts"], 4)

    def test_completion_sets_last_crawled_and_next(self):
        upd = compute_completion_update(50, self.NOW)
        self.assertEqual(upd["status"], "completed")
        self.assertIn("last_crawled_at", upd)
        self.assertIn("next_crawl_at", upd)
        self.assertEqual(upd["attempts"], 0)

    def test_is_due_null_next_crawl_at(self):
        self.assertTrue(is_due_for_crawl({"status": "pending"}, self.NOW))

    def test_is_not_due_future_next_crawl_at(self):
        future = (self.NOW + timedelta(hours=2)).isoformat()
        self.assertFalse(is_due_for_crawl(
            {"status": "pending", "next_crawl_at": future}, self.NOW))

    def test_select_orders_by_priority_then_attempts(self):
        items = [
            {"status": "pending", "keyword": "a", "priority_score": 10, "attempts": 2, "created_at": "2026-06-01"},
            {"status": "pending", "keyword": "b", "priority_score": 50, "attempts": 0, "created_at": "2026-06-02"},
            {"status": "pending", "keyword": "c", "priority_score": 50, "attempts": 1, "created_at": "2026-06-01"},
        ]
        selected = select_due_crawl_items(items, now=self.NOW, limit=2)
        self.assertEqual(selected[0]["keyword"], "b")
        self.assertEqual(selected[1]["keyword"], "c")

    def test_clamp_concurrency(self):
        self.assertEqual(clamp_concurrency(3), 3)
        self.assertEqual(clamp_concurrency(99), MAX_CRAWL_CONCURRENCY)
        self.assertEqual(clamp_concurrency(0), 1)
        self.assertEqual(DEFAULT_CRAWL_CONCURRENCY, 3)


if __name__ == "__main__":
    unittest.main()
