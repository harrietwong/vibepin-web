"""Unit tests for run_worker.py job routing."""

import unittest
from unittest.mock import AsyncMock, patch

import run_worker


class TestRunWorker(unittest.IsolatedAsyncioTestCase):
    async def test_job_trends_records_stats(self):
        ctx = {"stats": {}}
        with patch.object(run_worker.pipeline, "step_interests", new_callable=AsyncMock) as interests:
            with patch.object(run_worker.pipeline, "step_trends", new_callable=AsyncMock) as trends:
                interests.return_value = [{"interest_slug": "home_decor"}]
                trends.return_value = 12
                await run_worker.job_trends(ctx, top_n=30)
        self.assertEqual(ctx["stats"]["keywords"], 12)

    async def test_job_crawl_delegates_to_pipeline(self):
        ctx = {"stats": {}}
        with patch.object(run_worker.pipeline, "step_crawl", new_callable=AsyncMock) as crawl:
            crawl.return_value = {"processed": 5, "pins": 100, "premium": 2}
            await run_worker.job_crawl(ctx, limit_keywords=80, concurrency=3)
        self.assertEqual(ctx["stats"]["processed"], 5)

    async def test_job_stl_score_runs_stl_and_score(self):
        ctx = {"stats": {}}
        with patch.object(run_worker.pipeline, "step_stl", new_callable=AsyncMock) as stl:
            with patch.object(run_worker.pipeline, "step_score", new_callable=AsyncMock) as score:
                stl.return_value = 0
                await run_worker.job_stl_score(ctx, stl_limit=100)
        stl.assert_awaited_once()
        score.assert_awaited_once()

    async def test_job_daily_runs_steps_in_order(self):
        ctx = {"stats": {}}
        calls = []

        async def fake_interests(*_args, **_kwargs):
            calls.append("interests")
            return [{"interest_slug": "home_decor"}]

        async def fake_trends(*_args, **_kwargs):
            calls.append("trends")

        async def fake_crawl(*_args, **_kwargs):
            calls.append("crawl")
            return {}

        async def fake_classify(*_args, **_kwargs):
            calls.append("classify")
            return {}

        async def fake_opportunities(*_args, **_kwargs):
            calls.append("opportunities")
            return {}

        with patch.object(run_worker.pipeline, "step_interests", side_effect=fake_interests), \
             patch.object(run_worker.pipeline, "step_trends", side_effect=fake_trends), \
             patch.object(run_worker.pipeline, "step_crawl", side_effect=fake_crawl), \
             patch.object(run_worker.pipeline, "step_classify", side_effect=fake_classify), \
             patch.object(run_worker.pipeline, "step_opportunities", side_effect=fake_opportunities):
            await run_worker.job_daily(ctx)
        self.assertEqual(calls, ["interests", "trends", "crawl", "classify", "opportunities"])

    def test_job_handlers_registered(self):
        self.assertIn("trends", run_worker.JOB_HANDLERS)
        self.assertIn("crawl", run_worker.JOB_HANDLERS)
        self.assertIn("stl-score", run_worker.JOB_HANDLERS)
        self.assertIn("daily", run_worker.JOB_HANDLERS)

    async def test_run_job_daily_skipped_when_locked(self):
        import argparse
        from contextlib import contextmanager

        @contextmanager
        def fake_pipeline_job(*_a, **_k):
            yield {"skipped": True, "run_id": "r1", "job_type": "daily"}

        args = argparse.Namespace(
            job="daily", top_n=30, limit_keywords=80, region="US",
            concurrency=3, stl_limit=300, created_by="cloud",
        )
        with patch.object(run_worker, "pipeline_job", fake_pipeline_job):
            code = await run_worker.run_job(args)
        self.assertEqual(code, 0)

    def test_refresh_pipeline_views_handles_missing(self):
        with patch("db.select_many", return_value=[]):
            stats = run_worker.refresh_pipeline_views()
        self.assertIn("views_checked", stats)

    async def test_harvest_apply_skipped_when_writer_lock_held(self):
        """A second harvest apply MUST NOT write while pin_products_writer.lock is held
        by another live process — it skips (return 0) before entering the write path."""
        import argparse
        import tempfile
        from pathlib import Path
        import joblock

        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(joblock, "LOCK_DIR", Path(tmp)):
                # "Process A" holds the cross-job writer lock (live PID = this process).
                holder = joblock.pin_products_writer_lock(job="processA")
                self.assertTrue(holder.acquire())
                try:
                    args = argparse.Namespace(
                        job="harvest-outbound-products", apply=True, since_hours=48,
                        source=None, category=None, limit=2000, created_by="test",
                    )
                    with patch.object(run_worker, "job_harvest_outbound",
                                      new_callable=AsyncMock) as jho, \
                         patch.object(run_worker, "pipeline_job") as pj:
                        code = await run_worker.run_job(args)
                    self.assertEqual(code, 0)
                    jho.assert_not_awaited()   # the second apply did NOT write
                    pj.assert_not_called()     # skipped before the pipeline_job write block
                finally:
                    holder.release()

    async def test_harvest_apply_runs_when_writer_lock_free(self):
        """Control: with the writer lock free, the harvest apply DOES run (the new guard
        does not over-block)."""
        import argparse
        import tempfile
        from contextlib import contextmanager
        from pathlib import Path
        import joblock

        @contextmanager
        def fake_pipeline_job(*_a, **_k):
            yield {"skipped": False, "run_id": "r1", "job_type": "harvest-outbound-products"}

        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(joblock, "LOCK_DIR", Path(tmp)):
                args = argparse.Namespace(
                    job="harvest-outbound-products", apply=True, since_hours=48,
                    source=None, category=None, limit=2000, created_by="test",
                )
                with patch.object(run_worker, "job_harvest_outbound",
                                  new_callable=AsyncMock) as jho, \
                     patch.object(run_worker, "pipeline_job", fake_pipeline_job):
                    code = await run_worker.run_job(args)
                self.assertEqual(code, 0)
                jho.assert_awaited_once()   # lock free → the writer runs
                # And the lock must be released afterwards (a follow-up run can acquire it).
                follow = joblock.pin_products_writer_lock(job="processB")
                self.assertTrue(follow.acquire())
                follow.release()


if __name__ == "__main__":
    unittest.main()
