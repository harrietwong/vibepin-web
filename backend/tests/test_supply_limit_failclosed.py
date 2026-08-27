"""Independent discovery-scan and write-admission limits for Product Supply.

``--limit`` counts Source Pins inspected and may be as high as 100. The writer
keeps at most 50 rows for the run while every atomic database write remains at
MAX_BATCH=20. Values above MAX_SOURCE_SCAN fail closed at both entry points.

  * scripts/run_bootstrap_product_supply.py  (operator runner: SystemExit on over-cap)
  * run_worker.py --job product-supply-expand --engine shop-the-look (returns 2)

Offline: run_bootstrap is imported and its main() is driven with a stubbed preflight/worker
so nothing is spawned and nothing is written.
"""
import importlib.util
import argparse
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
for p in (str(BACKEND), str(BACKEND / "db"), str(BACKEND / "scripts")):
    if p not in sys.path:
        sys.path.insert(0, p)

import supply_core as core  # noqa: E402

_spec = importlib.util.spec_from_file_location(
    "run_bootstrap_product_supply", str(BACKEND / "scripts" / "run_bootstrap_product_supply.py"))
runner = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(runner)


class TestBootstrapDefaults(unittest.TestCase):
    def test_default_limit_is_max_batch(self):
        self.assertEqual(runner.DEFAULT_LIMIT, 20)
        self.assertEqual(runner.DEFAULT_LIMIT, core.MAX_BATCH)
        self.assertEqual(runner.MAX_BATCH, core.MAX_BATCH)
        self.assertEqual(runner.MAX_SOURCE_SCAN, 100)
        self.assertGreater(runner.MAX_SOURCE_SCAN, runner.MAX_BATCH)
        self.assertEqual(core.MAX_RUN_ADMISSIONS, 50)
        self.assertEqual(runner.MAX_RUN_ADMISSIONS, core.MAX_RUN_ADMISSIONS)
        self.assertEqual(core.MAX_BATCH, 20)

    def test_default_category_mix_sums_to_default_limit(self):
        total = sum(int(part.split(":")[1]) for part in runner.DEFAULT_CATEGORY_MIX.split(","))
        self.assertEqual(total, runner.DEFAULT_LIMIT,
                         "the default category mix must total DEFAULT_LIMIT")

    def test_normal_daily_run_has_no_implicit_frozen_source_report(self):
        self.assertIsNone(runner.DEFAULT_SOURCE_REPORT)
        args = argparse.Namespace(
            limit=20,
            category_mix=runner.DEFAULT_CATEGORY_MIX,
            since_hours=None,
            source_report=None,
        )
        cmd = runner._build_worker_cmd(args, apply=False)
        self.assertNotIn("--source-report", cmd)


class TestBootstrapFailClosed(unittest.TestCase):
    def _run_main(self, argv):
        old = sys.argv
        sys.argv = ["run_bootstrap_product_supply.py"] + argv
        try:
            return runner.main()
        finally:
            sys.argv = old

    def test_limit_over_source_scan_cap_fails_closed(self):
        with self.assertRaises(SystemExit) as ctx:
            self._run_main(["--limit", "101", "--timeout-seconds", "6000"])
        self.assertIn("exceeds MAX_SOURCE_SCAN", str(ctx.exception))

    def test_100_source_scan_requires_measured_timeout(self):
        with self.assertRaises(SystemExit) as ctx:
            self._run_main(["--limit", "100", "--timeout-seconds", "1200"])
        self.assertIn("require at least 5400", str(ctx.exception))

    def test_100_source_scan_passes_limit_and_timeout_validation(self):
        original = runner._run_preflight
        runner._run_preflight = lambda **_kw: ("WAIT", 10, {})
        try:
            rc = self._run_main([
                "--limit", "100", "--timeout-seconds", "5400",
                "--category-mix",
                "fashion:29,womens-fashion:22,home-decor:29,digital-products:20",
            ])
        finally:
            runner._run_preflight = original
        self.assertEqual(rc, 10, "100 reached preflight instead of failing limit validation")

    def test_zero_and_negative_limit_refused(self):
        for bad in ("0", "-5"):
            with self.assertRaises(SystemExit):
                self._run_main(["--limit", bad])

    def test_apply_over_source_cap_fails_before_any_confirm_processing(self):
        # Even a fully-confirmed apply must fail closed on an over-cap scan — the cap
        # check comes first, so no write intent can outrun it.
        with self.assertRaises(SystemExit) as ctx:
            self._run_main(["--apply", "--confirm", "APPLY_BOOTSTRAP_PRODUCTS",
                            "--limit", "101", "--timeout-seconds", "6000"])
        self.assertIn("exceeds MAX_SOURCE_SCAN", str(ctx.exception))


class TestRunWorkerShopTheLookGate(unittest.TestCase):
    """run_worker.run_job refuses an over-cap source scan with exit 2, before
    launching any Playwright/browser work."""

    def _build_args(self, limit, *, apply=False):
        import argparse
        ns = argparse.Namespace()
        ns.job = "product-supply-expand"
        ns.engine = "shop-the-look"
        ns.apply = apply
        ns.dry_run = not apply
        ns.since_hours = None
        ns.source = None
        ns.categories = None
        ns.category_mix = None
        ns.limit = limit
        ns.seed_pin_limit = 100
        ns.related_per_pin = 8
        ns.depth = 1
        ns.source_report = None
        ns.created_by = "test"
        return ns

    def test_over_source_scan_cap_limit_returns_2(self):
        import asyncio
        import run_worker
        for bad in (101, 500):
            rc = asyncio.run(run_worker.run_job(self._build_args(bad)))
            self.assertEqual(rc, 2, f"limit {bad} must be refused with exit 2")

    def test_over_source_scan_cap_apply_limit_returns_2(self):
        import asyncio
        import run_worker
        rc = asyncio.run(run_worker.run_job(self._build_args(101, apply=True)))
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main()
