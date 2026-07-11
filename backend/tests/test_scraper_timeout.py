"""Timeout-protection tests for PinterestSession (scraper_v2).

These tests are fully OFFLINE — they never touch Pinterest, the proxy, or the
DB. Every network boundary (the curl_cffi session, the crawl_queue DB reads,
mark_queue_item) is mocked. They verify that a stalled/slow request now RAISES
within a bounded timeout and fails cleanly rather than hanging the crawler.
"""

import os
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import scraper_v2
from scraper_v2 import PinterestSession, _resolve_http_timeout


class _FakeTimeout(Exception):
    """Stand-in for a curl_cffi/libcurl timeout (message mirrors 'timed out')."""


class TestResolveHttpTimeout(unittest.TestCase):
    def test_default_is_30(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("PINTEREST_HTTP_TIMEOUT_SECONDS", None)
            self.assertEqual(_resolve_http_timeout(), 30.0)

    def test_env_override(self):
        with patch.dict(os.environ, {"PINTEREST_HTTP_TIMEOUT_SECONDS": "12"}):
            self.assertEqual(_resolve_http_timeout(), 12.0)

    def test_clamped_low_and_high(self):
        with patch.dict(os.environ, {"PINTEREST_HTTP_TIMEOUT_SECONDS": "1"}):
            self.assertEqual(_resolve_http_timeout(), 5.0)   # floor
        with patch.dict(os.environ, {"PINTEREST_HTTP_TIMEOUT_SECONDS": "9999"}):
            self.assertEqual(_resolve_http_timeout(), 120.0)  # ceiling

    def test_garbage_falls_back_to_30(self):
        with patch.dict(os.environ, {"PINTEREST_HTTP_TIMEOUT_SECONDS": "not-a-number"}):
            self.assertEqual(_resolve_http_timeout(), 30.0)


class TestSessionTimeoutWiring(unittest.TestCase):
    def test_make_session_passes_timeout(self):
        """Every request inherits the session-level timeout (the guaranteed chokepoint)."""
        with patch.dict(os.environ, {"PINTEREST_HTTP_TIMEOUT_SECONDS": "17"}):
            sess = PinterestSession(proxy=None)
        captured = {}

        def _fake_curl_session(**kwargs):
            captured.update(kwargs)
            return MagicMock()

        with patch.object(scraper_v2, "CurlSession", side_effect=_fake_curl_session):
            sess._make_session()
        self.assertEqual(captured.get("timeout"), 17.0)


class TestBootstrapTimeout(unittest.IsolatedAsyncioTestCase):
    async def test_bootstrap_timeout_fails_cleanly(self):
        """A stalled homepage GET raises inside self._timeout → _bootstrap returns,
        does not propagate, and leaves csrf/app_version empty (no hang)."""
        sess = PinterestSession(proxy=None)
        fake = MagicMock()
        fake.get = AsyncMock(side_effect=_FakeTimeout("Operation timed out after 30000 ms"))
        sess._session = fake

        await sess._bootstrap()  # must NOT raise

        fake.get.assert_awaited_once()
        # Every get call carries an explicit timeout (belt-and-suspenders).
        self.assertEqual(fake.get.await_args.kwargs.get("timeout"), sess._timeout)
        self.assertEqual(sess._csrf, "")
        self.assertEqual(sess._app_version, "")


class TestGetJsonTimeout(unittest.IsolatedAsyncioTestCase):
    async def test_get_json_timeout_returns_empty_no_infinite_retry(self):
        """A non-SSL timeout returns {} after exactly one attempt — no retry storm."""
        sess = PinterestSession(proxy=None)
        sess._delay = 0.0  # skip rate-limit sleep
        fake = MagicMock()
        fake.get = AsyncMock(side_effect=_FakeTimeout("Connection timed out"))
        sess._session = fake

        result = await sess._get_json("https://www.pinterest.com/resource/x/")

        self.assertEqual(result, {})
        fake.get.assert_awaited_once()  # timeout is not an SSL error → no rebuild/retry
        self.assertEqual(fake.get.await_args.kwargs.get("timeout"), sess._timeout)


class TestQueueMarkedFailedOnTimeout(unittest.IsolatedAsyncioTestCase):
    async def test_process_queue_item_marks_failed_not_stuck_processing(self):
        """When the session times out mid-crawl, the crawl_queue row is marked
        'failed' (recoverable) after 'processing' — never left stuck in 'processing'."""
        session = MagicMock()
        session.expand_keywords = AsyncMock(side_effect=_FakeTimeout("read timed out"))
        session.search_pins = AsyncMock()

        marks = []

        def _record_mark(keyword, status, error="", **kwargs):
            marks.append(status)

        # Import the db module exactly as scraper_v2 does (adds ROOT/db to path),
        # then patch select_one on it so the two crawl_queue reads stay offline.
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(scraper_v2.ROOT) / "db"))
        import db as db_mod  # noqa: E402

        with patch.object(scraper_v2, "mark_queue_item", side_effect=_record_mark), \
             patch.object(db_mod, "select_one", return_value=None):
            saved, premium = await scraper_v2.process_queue_item(
                keyword="digital planner template",
                source_interest="",
                category="digital-products",
                session=session,
                write_db=False,
            )

        self.assertEqual((saved, premium), (0, []))
        self.assertEqual(marks[0], "processing")
        self.assertEqual(marks[-1], "failed")
        self.assertNotEqual(marks[-1], "processing")  # not stuck
        session.search_pins.assert_not_awaited()      # failed before any pin fetch


if __name__ == "__main__":
    unittest.main()
