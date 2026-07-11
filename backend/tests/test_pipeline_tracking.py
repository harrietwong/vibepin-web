"""Unit tests for pipeline locks and run tracking."""

import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import MagicMock, patch

from pipeline_tracking import (
    LOCK_TIMEOUTS_SEC,
    acquire_lock,
    is_lock_held,
    pipeline_job,
    start_run,
    finish_run,
    worker_identity,
)


class TestPipelineTracking(unittest.TestCase):
    def test_lock_timeouts_defined(self):
        self.assertIn("trends", LOCK_TIMEOUTS_SEC)
        self.assertIn("crawl", LOCK_TIMEOUTS_SEC)
        self.assertIn("daily", LOCK_TIMEOUTS_SEC)

    def test_worker_identity_format(self):
        ident = worker_identity("cloud")
        self.assertTrue(ident.startswith("cloud:"))

    @patch("pipeline_tracking._purge_expired_locks")
    @patch("pipeline_tracking._db")
    def test_acquire_lock_when_free(self, mock_db, _purge):
        mock_upsert, _, mock_select_one, _ = MagicMock(), MagicMock(), MagicMock(), MagicMock()
        mock_db.return_value = (mock_upsert, MagicMock(), mock_select_one, MagicMock())
        mock_select_one.return_value = {"lock_name": "crawl", "locked_by": "cloud:host:1"}

        with patch("pipeline_tracking.is_lock_held", return_value=False):
            ok = acquire_lock("crawl", "cloud:host:1", run_id="run-1")
        self.assertTrue(ok)
        mock_upsert.assert_called_once()

    @patch("pipeline_tracking._purge_expired_locks")
    @patch("pipeline_tracking.is_lock_held", return_value=True)
    def test_acquire_lock_blocked_when_held(self, _held, _purge):
        ok = acquire_lock("trends", "cloud:host:1")
        self.assertFalse(ok)

    @patch("pipeline_tracking.start_run")
    @patch("pipeline_tracking.finish_run")
    @patch("pipeline_tracking.acquire_lock", return_value=False)
    @patch("pipeline_tracking.release_lock")
    def test_pipeline_job_skipped_when_locked(self, _rel, _acq, mock_finish, mock_start):
        mock_start.return_value = {"id": "r1", "started_at": "2026-06-08T12:00:00+00:00"}
        with pipeline_job("crawl", created_by="cloud") as ctx:
            self.assertTrue(ctx.get("skipped"))
        mock_finish.assert_called_once()
        args = mock_finish.call_args
        self.assertEqual(args[0][1], "skipped")


if __name__ == "__main__":
    unittest.main()
