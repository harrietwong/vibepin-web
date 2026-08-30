"""Unit tests for run_worker.py job routing."""

import sys
import types
import unittest
from contextlib import contextmanager
from unittest.mock import AsyncMock, Mock, patch

import run_worker


def _trusted_supply_report() -> dict:
    return {
        "dataQuality": {"resultTrust": "trusted", "authenticatedRun": True},
        "aggregate": {
            "renderFailureCount": 0,
            "timeoutCount": 0,
            "sourcePinsScanned": 1,
            "uniqueAcceptedProducts": 0,
        },
        "sourceSelection": {"selectedTotal": 1},
    }


class TestRunWorker(unittest.IsolatedAsyncioTestCase):
    async def test_product_supply_rejects_untrusted_runtime_report(self):
        import shop_the_look_expand

        report = _trusted_supply_report()
        report["dataQuality"]["resultTrust"] = "partial:some_pins_timed_out"
        report["aggregate"]["timeoutCount"] = 1
        with patch.object(
            shop_the_look_expand,
            "run_shop_the_look_expand",
            new=AsyncMock(return_value=report),
        ):
            with self.assertRaises(run_worker.ProductSupplyReportUntrusted):
                await run_worker.job_product_supply_expand(
                    {}, engine="shop-the-look", limit=1, apply=False
                )

    async def test_product_supply_accepts_trusted_runtime_report(self):
        import shop_the_look_expand

        report = _trusted_supply_report()
        with patch.object(
            shop_the_look_expand,
            "run_shop_the_look_expand",
            new=AsyncMock(return_value=report),
        ):
            result = await run_worker.job_product_supply_expand(
                {}, engine="shop-the-look", limit=1, apply=False
            )
        self.assertIs(result, report)
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

    async def test_classify_chain_runs_all_three_stages_in_order(self):
        calls = []

        def stage(name, result):
            return Mock(side_effect=lambda **_kwargs: calls.append(name) or result)

        reference = stage("reference", {"written": 2})
        products = stage("products", {"written": 3})
        opportunities = stage("opportunities", None)
        modules = {
            "classify_reference_pins": types.SimpleNamespace(run=reference),
            "classify_product_signals": types.SimpleNamespace(run=products),
            "generate_opportunities": types.SimpleNamespace(run=opportunities),
            "trend_seed_pipeline": types.SimpleNamespace(P0_CATEGORIES={"fashion", "digital-products"}),
        }
        ctx = {}
        with patch.dict(sys.modules, modules):
            await run_worker.job_classify_chain(ctx, since_hours=26, opp_limit=123)

        self.assertEqual(calls, ["reference", "products", "opportunities"])
        self.assertTrue(ctx["stats"]["chainOk"])
        opportunities.assert_called_once_with(category=None, limit=123, dry_run=False)

    async def test_classify_chain_defers_opportunities_and_fails_if_upstream_fails(self):
        calls = []

        def broken_reference(**_kwargs):
            calls.append("reference")
            raise RuntimeError("reference failed")

        def products(**_kwargs):
            calls.append("products")
            return {"written": 1}

        opportunities = Mock(side_effect=lambda **_kwargs: calls.append("opportunities"))
        modules = {
            "classify_reference_pins": types.SimpleNamespace(run=broken_reference),
            "classify_product_signals": types.SimpleNamespace(run=products),
            "generate_opportunities": types.SimpleNamespace(run=opportunities),
            "trend_seed_pipeline": types.SimpleNamespace(P0_CATEGORIES={"fashion"}),
        }
        ctx = {}
        with patch.dict(sys.modules, modules), self.assertRaisesRegex(
            RuntimeError, "classify-chain incomplete"
        ):
            await run_worker.job_classify_chain(ctx)

        self.assertEqual(calls, ["reference", "products"])
        opportunities.assert_not_called()
        self.assertEqual(
            [step["status"] for step in ctx["stats"]["chain"]],
            ["failed", "ok", "deferred"],
        )

    async def test_run_job_routes_classify_chain_under_its_own_lock(self):
        seen = []

        @contextmanager
        def fake_pipeline_job(job_type, **_kwargs):
            seen.append(job_type)
            yield {"skipped": False, "stats": {}}

        args = types.SimpleNamespace(
            job="classify-chain",
            created_by="cloud",
            since_hours=26,
            limit=2000,
        )
        with patch.object(run_worker, "pipeline_job", fake_pipeline_job), patch.object(
            run_worker, "job_classify_chain", new_callable=AsyncMock
        ) as chain:
            code = await run_worker.run_job(args)

        self.assertEqual(code, 0)
        self.assertEqual(seen, ["classify-chain"])
        chain.assert_awaited_once()

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


class TestUnverifiedPreconditionExitCode(unittest.TestCase):
    """"Could not verify" must be distinguishable from "verified broken".

    A transient DB outage during the schema probe used to exit 1 with the same
    text as a genuine missing column, so no wrapper or operator could tell a
    retryable blip from a real schema defect.
    """

    @staticmethod
    def _raise_after_closing(exc):
        """Stand in for asyncio.run: close the coroutine, then raise.

        Closing avoids a spurious "coroutine was never awaited" warning while
        still simulating the failure surfacing out of asyncio.run().
        """
        def fake_run(coro, *_a, **_k):
            coro.close()
            raise exc
        return fake_run

    def _run_main_with(self, exc):
        argv = ["run_worker.py", "--job", "product-supply-expand"]
        with patch.object(sys, "argv", argv), \
             patch.object(run_worker.asyncio, "run", self._raise_after_closing(exc)), \
             patch.object(run_worker.pipeline, "_err"):
            return run_worker.main()

    def test_schema_check_unavailable_exits_75(self):
        from shop_the_look_expand import SchemaCheckUnavailable
        code = self._run_main_with(SchemaCheckUnavailable("db unreachable"))
        self.assertEqual(code, run_worker.EXIT_PRECONDITION_UNVERIFIED)
        self.assertEqual(code, 75)

    def test_genuine_failure_still_exits_1(self):
        code = self._run_main_with(RuntimeError(
            "v28 migration has not been applied — missing columns: ['seed_keyword']."))
        self.assertEqual(code, 1)

    def test_untrusted_supply_receipt_exits_76(self):
        code = self._run_main_with(run_worker.ProductSupplyReportUntrusted(
            "partial:some_pins_timed_out"
        ))
        self.assertEqual(code, run_worker.EXIT_PRODUCT_SUPPLY_UNTRUSTED)
        self.assertEqual(code, 76)

    def test_the_two_outcomes_have_different_exit_codes(self):
        from shop_the_look_expand import SchemaCheckUnavailable
        unverified = self._run_main_with(SchemaCheckUnavailable("db unreachable"))
        real_defect = self._run_main_with(RuntimeError("missing columns: ['x']"))
        self.assertNotEqual(unverified, real_defect)

    def test_unverified_message_does_not_blame_the_migration(self):
        from shop_the_look_expand import SchemaCheckUnavailable
        argv = ["run_worker.py", "--job", "product-supply-expand"]
        with patch.object(sys, "argv", argv), \
             patch.object(run_worker.asyncio, "run",
                          self._raise_after_closing(SchemaCheckUnavailable(
                              "unable to confirm schema (database connection failed)"))), \
             patch.object(run_worker.pipeline, "_err") as err:
            run_worker.main()
        logged = " ".join(str(c) for c in err.call_args_list)
        self.assertNotIn("has not been applied", logged)
        self.assertNotIn("migrate_v28", logged)


if __name__ == "__main__":
    unittest.main()
