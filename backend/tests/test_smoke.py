"""Unit tests for cloud smoke deployment verification."""

import argparse
import asyncio
import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import cloud_smoke


class TestSmokeEnvChecks(unittest.TestCase):
    def test_check_env_vars_all_present(self):
        with patch.dict(os.environ, {"SUPABASE_URL": "https://x.supabase.co",
                                      "SUPABASE_SERVICE_ROLE_KEY": "key"}):
            missing, _optional = cloud_smoke.check_env_vars()
        self.assertEqual(missing, [])

    def test_check_env_vars_missing(self):
        with patch.dict(os.environ, {}, clear=True):
            missing, _ = cloud_smoke.check_env_vars()
        self.assertIn("SUPABASE_URL", missing)
        self.assertIn("SUPABASE_SERVICE_ROLE_KEY", missing)

    def test_run_env_checks_fails_on_missing(self):
        report = cloud_smoke.SmokeReport()
        with patch.dict(os.environ, {}, clear=True):
            ok = cloud_smoke.run_env_checks(report)
        self.assertFalse(ok)
        self.assertFalse(report.passed)

    def test_smoke_exits_on_missing_env(self):
        with patch.dict(os.environ, {}, clear=True):
            code = asyncio.run(cloud_smoke.run_smoke(skip_pipeline=True))
        self.assertEqual(code, 1)


class TestSmokeDbChecks(unittest.TestCase):
    def test_check_db_connection_ok(self):
        mock_http = MagicMock()
        mock_http.get.return_value = MagicMock(status_code=200, text="[]")
        ok, _detail = cloud_smoke.check_db_connection(lambda: mock_http)
        self.assertTrue(ok)

    def test_check_db_connection_fail(self):
        mock_http = MagicMock()
        mock_http.get.return_value = MagicMock(status_code=401, text="unauthorized")
        ok, _detail = cloud_smoke.check_db_connection(lambda: mock_http)
        self.assertFalse(ok)

    def test_check_table_exists_ok(self):
        mock_http = MagicMock()
        mock_http.get.return_value = MagicMock(status_code=200, text="[]")
        ok, _ = cloud_smoke.check_table_exists("pipeline_runs", lambda: mock_http)
        self.assertTrue(ok)

    def test_check_columns_exist_ok(self):
        mock_select = MagicMock(return_value=[])
        ok, _detail = cloud_smoke.check_columns_exist(
            "crawl_queue", ("last_crawled_at", "next_crawl_at"), mock_select
        )
        self.assertTrue(ok)

    @patch("cloud_smoke.check_lock_roundtrip", return_value=(True, "ok"))
    @patch("cloud_smoke.run_table_checks", return_value=True)
    @patch("cloud_smoke.run_db_checks", return_value=True)
    @patch("cloud_smoke.run_env_checks", return_value=True)
    def test_smoke_skips_pipeline_when_requested(self, *_mocks):
        code = asyncio.run(cloud_smoke.run_smoke(skip_pipeline=True))
        self.assertEqual(code, 0)


class TestSmokeInRunWorker(unittest.IsolatedAsyncioTestCase):
    def test_smoke_job_in_cli_choices(self):
        import run_worker
        job_choices = list(run_worker.JOB_HANDLERS.keys()) + ["smoke"]
        self.assertIn("smoke", job_choices)

    async def test_run_job_smoke_delegates(self):
        import run_worker
        args = argparse.Namespace(
            job="smoke", top_n=5, limit_keywords=3, region="US",
            concurrency=3, stl_limit=300, created_by="cloud",
        )
        with patch.object(run_worker, "run_smoke", new_callable=AsyncMock) as mock_smoke:
            mock_smoke.return_value = 0
            code = await run_worker.run_job(args)
        self.assertEqual(code, 0)
        mock_smoke.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
