"""Unit tests for crawl-step replenish guard."""

import os
import sys
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# backend/db has no __init__.py, so a bare `import db` from backend/ resolves to
# the namespace PACKAGE (backend/db/) instead of backend/db/db.py, and
# `from db import update_where` then raises ImportError. Production entry points
# (run_worker.py) put backend/db on sys.path before importing pipeline, so they
# get the module; the test harness must do the same or it silently exercises the
# ImportError branch instead of the code under test.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "db"))

import crawl_queue_ops
import pipeline


class TestPipelineCrawlGuard(unittest.IsolatedAsyncioTestCase):
    async def test_crawl_runs_trends_when_pending_low(self):
        with patch.object(pipeline, "replenish_crawl_queue_if_needed", new_callable=AsyncMock) as replenish:
            replenish.return_value = 25
            with patch.object(pipeline, "_db_select", return_value=[]):
                result = await pipeline.step_crawl(replenish=True, limit_keywords=10)
            replenish.assert_awaited_once()
            self.assertEqual(result["processed"], 0)

    async def test_crawl_exits_cleanly_when_still_empty_after_replenish(self):
        with patch.object(pipeline, "replenish_crawl_queue_if_needed", new_callable=AsyncMock) as replenish:
            replenish.return_value = 0
            result = await pipeline.step_crawl(replenish=True)
            self.assertTrue(result.get("skipped"))
            self.assertEqual(result["processed"], 0)

    async def test_replenish_skipped_when_pending_high(self):
        with patch("crawl_queue_ops.count_pending_items", return_value=50):
            pending = await pipeline.replenish_crawl_queue_if_needed(min_pending=20)
            self.assertEqual(pending, 50)


class TestReplenishTracksRunConsumption(unittest.IsolatedAsyncioTestCase):
    """Regression: 2026-08-08..10 queue starvation.

    Production crawls 150 keywords/run but replenish only fired below a fixed
    20, so due pending fell 147 -> 150 -> 53 -> 0 across three days while every
    run exited 0. The replenish threshold must track the run's consumption.
    """

    def _patch_common(self, pending_sequence):
        """Patch count_pending_items to yield the given sequence of counts."""
        counts = iter(pending_sequence)
        last = [pending_sequence[-1]]

        def _count(*_a, **_kw):
            try:
                last[0] = next(counts)
            except StopIteration:
                pass
            return last[0]

        return patch("crawl_queue_ops.count_pending_items", side_effect=_count)

    async def test_replenishes_when_pending_below_run_limit(self):
        """pending=53, limit=150 -> must replenish (old code returned at 53>=20)."""
        requeue = MagicMock(return_value=97)
        with self._patch_common([53, 150]), \
                patch("db.update_where", MagicMock(return_value=[])), \
                patch("crawl_queue_ops.requeue_stale_completed_items", requeue), \
                patch.object(pipeline, "step_interests", new_callable=AsyncMock) as interests, \
                patch.object(pipeline, "step_trends", new_callable=AsyncMock) as trends:
            pending = await pipeline.replenish_crawl_queue_if_needed(
                min_pending=20, limit_keywords=150,
            )

        requeue.assert_called_once()
        # The requeue target must be the run's appetite, not the legacy 50.
        self.assertEqual(requeue.call_args.kwargs["min_due_pending"], 150)
        self.assertEqual(pending, 150)
        # Cheap path sufficed -> the expensive trends replenish must NOT run.
        interests.assert_not_awaited()
        trends.assert_not_awaited()

    async def test_no_replenish_when_pending_exceeds_run_limit(self):
        """pending=200, limit=150 -> queue already holds a full run, do nothing."""
        requeue = MagicMock(return_value=0)
        with self._patch_common([200]), \
                patch("crawl_queue_ops.requeue_stale_completed_items", requeue), \
                patch.object(pipeline, "step_interests", new_callable=AsyncMock) as interests, \
                patch.object(pipeline, "step_trends", new_callable=AsyncMock) as trends:
            pending = await pipeline.replenish_crawl_queue_if_needed(
                min_pending=20, limit_keywords=150,
            )

        self.assertEqual(pending, 200)
        requeue.assert_not_called()
        interests.assert_not_awaited()
        trends.assert_not_awaited()

    async def test_trends_replenish_runs_only_when_requeue_falls_short(self):
        """Stale requeue cannot close the gap -> fall through to trends."""
        requeue = MagicMock(return_value=5)
        with self._patch_common([10, 15, 150]), \
                patch("db.update_where", MagicMock(return_value=[])), \
                patch("crawl_queue_ops.requeue_stale_completed_items", requeue), \
                patch.object(pipeline, "step_interests", new_callable=AsyncMock) as interests, \
                patch.object(pipeline, "step_trends", new_callable=AsyncMock) as trends:
            interests.return_value = [{"interest_slug": "beauty"}]
            pending = await pipeline.replenish_crawl_queue_if_needed(
                min_pending=20, limit_keywords=150,
            )

        requeue.assert_called_once()
        interests.assert_awaited_once()
        trends.assert_awaited_once()
        self.assertEqual(pending, 150)

    async def test_stale_requeue_import_is_reachable(self):
        """`from db import update_where` inside replenish must actually resolve.

        The broad `except Exception` around the stale-requeue block turns an
        ImportError into a warning and a silent fall-through to the expensive
        trends path, so a broken import looks like "requeue didn't help".
        """
        import db  # noqa: F401  (must be the module, not the namespace package)
        self.assertTrue(
            hasattr(db, "update_where"),
            "db.update_where unresolvable — replenish's stale-requeue path would "
            "be dead and silently fall through to trends",
        )

    async def test_step_crawl_passes_its_limit_to_replenish(self):
        """The wiring that actually failed in production: step_crawl -> replenish."""
        with patch.object(pipeline, "replenish_crawl_queue_if_needed",
                          new_callable=AsyncMock) as replenish:
            replenish.return_value = 150
            with patch.object(pipeline, "_db_select", return_value=[]):
                await pipeline.step_crawl(replenish=True, limit_keywords=150)

        self.assertEqual(replenish.await_args.kwargs["limit_keywords"], 150)

    async def test_short_queue_is_reported_not_silent(self):
        """Running 53 of 150 must emit a warning, never look like a clean run."""
        due_rows = [
            {"keyword": f"kw{i}", "status": "pending", "next_crawl_at": None,
             "priority_score": 10, "attempts": 0, "created_at": "2026-01-01"}
            for i in range(53)
        ]
        warnings: list[str] = []
        with patch.object(pipeline, "replenish_crawl_queue_if_needed",
                          new_callable=AsyncMock) as replenish, \
                patch.object(pipeline, "_db_select", return_value=due_rows), \
                patch.object(pipeline, "_warn", side_effect=warnings.append), \
                patch("scraper_v2.PinterestSession", side_effect=RuntimeError("stop here")):
            replenish.return_value = 53
            with self.assertRaises(RuntimeError):
                await pipeline.step_crawl(replenish=True, limit_keywords=150)

        short = [w for w in warnings if "queue short" in w]
        self.assertTrue(short, f"expected a 'queue short' warning, got: {warnings}")
        self.assertIn("53 of 150", short[0])


class TestResolveReplenishTarget(unittest.TestCase):
    def test_target_is_run_limit_when_limit_exceeds_floor(self):
        self.assertEqual(
            crawl_queue_ops.resolve_replenish_target(limit_keywords=150, min_pending=20), 150)

    def test_target_is_floor_when_limit_is_small(self):
        self.assertEqual(
            crawl_queue_ops.resolve_replenish_target(limit_keywords=5, min_pending=20), 20)

    def test_unbounded_run_keeps_floor(self):
        # limit_keywords=0 means "crawl everything due" — no consumption figure.
        self.assertEqual(
            crawl_queue_ops.resolve_replenish_target(limit_keywords=0, min_pending=20), 20)

    def test_defaults_to_module_floor(self):
        self.assertEqual(
            crawl_queue_ops.resolve_replenish_target(),
            crawl_queue_ops.MIN_PENDING_FOR_CRAWL,
        )


class TestRequeueBoundedByShortfall(unittest.TestCase):
    """Requeue only what the run is short by — not a blanket 200 every time."""

    def _fake_db(self, due_pending: int, completed: int):
        pending_rows = [
            {"keyword": f"p{i}", "status": "pending", "next_crawl_at": None}
            for i in range(due_pending)
        ]
        completed_rows = [
            {"keyword": f"c{i}", "status": "completed",
             "last_crawled_at": "2026-01-01T00:00:00+00:00"}
            for i in range(completed)
        ]

        def select_many(table, filters=None, order=None, limit=None):
            status = (filters or {}).get("status")
            if status == "pending":
                return pending_rows
            if status == "completed":
                return completed_rows[: (limit or len(completed_rows))]
            return []

        updates: list = []

        def update_where(table, values, where):
            updates.append(where)
            return []

        return select_many, update_where, updates

    def test_requeues_only_the_shortfall(self):
        select_many, update_where, updates = self._fake_db(due_pending=53, completed=1000)
        n = crawl_queue_ops.requeue_stale_completed_items(
            select_many, update_where, min_due_pending=150,
        )
        self.assertEqual(n, 97, "should requeue 150-53=97, not the full 200 cap")
        self.assertEqual(len(updates), 97)

    def test_requeue_still_capped_by_max_requeue(self):
        select_many, update_where, _ = self._fake_db(due_pending=0, completed=1000)
        n = crawl_queue_ops.requeue_stale_completed_items(
            select_many, update_where, min_due_pending=5000,
        )
        self.assertEqual(n, crawl_queue_ops.MAX_REQUEUE_PER_RUN)

    def test_no_requeue_when_queue_already_deep_enough(self):
        select_many, update_where, updates = self._fake_db(due_pending=200, completed=1000)
        n = crawl_queue_ops.requeue_stale_completed_items(
            select_many, update_where, min_due_pending=150,
        )
        self.assertEqual(n, 0)
        self.assertEqual(updates, [])


if __name__ == "__main__":
    unittest.main()
