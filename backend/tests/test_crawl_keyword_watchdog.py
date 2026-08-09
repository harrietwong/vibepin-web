"""Regression tests for the 2026-08-09 pin-crawl permanent hang.

WHAT HAPPENED (observed on the VPS, concurrency=5, 150 keywords):
  [crawl] heartbeat done=48/150 elapsed=2942s in_flight=5:
    mlb game outfit woman (2091s), motorcycle photoshoot women (2064s), ...
Five keywords sat in flight for 33+ minutes each (median keyword: 108s), holding
all five concurrency slots. The heartbeat kept printing (event loop healthy),
/proc/<pid>/io showed zero bytes moving, and not one further keyword completed.

ROOT CAUSE (verified in curl_cffi 0.15.0 source, requests/session.py):
  AsyncSession.request() begins with `curl = await self.pop_curl()`, and
  pop_curl() is `await self.pool.get()` on an asyncio.LifoQueue bounded by
  max_clients=10. That await happens BEFORE the per-request timeout is applied
  to the handle, so the 30s HTTP timeout provably cannot interrupt it. And
  AsyncSession.close() drains the queue with get_nowait() without ever waking
  coroutines already parked in pool.get() — so closing a shared session (which
  _rebuild_session did, unsynchronised, from any of 5 workers) leaves those
  parked coroutines awaiting forever.

Two independent guarantees are pinned here:
  1. scraper_v2: every curl_cffi GET goes through a bounded chokepoint, and
     concurrent SSL rebuilds are serialised so a shared session is not torn down
     out from under its users.
  2. pipeline: whatever the cause, a keyword that overruns its budget is
     cancelled, counted as FAILED (never silently skipped), and gives its
     semaphore slot back so the rest of the run proceeds.

No network, no DB: process_queue_item / PinterestSession / crawl_queue_ops are
patched at their source modules because step_crawl imports them lazily inside
the function body.
"""
import asyncio
import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
import pipeline  # noqa: E402
import scraper_v2  # noqa: E402

SCRAPER_SRC = (BACKEND / "scraper_v2.py").read_text(encoding="utf-8")


class _FakeSession:
    """Stand-in for scraper_v2.PinterestSession (async context manager only)."""

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


def _items(keywords):
    return [
        {"keyword": kw, "source_interest": "home_decor", "category": "home"}
        for kw in keywords
    ]


async def _run_step_crawl(keywords, process_impl, concurrency=2, timeout_secs=0.2):
    """Run step_crawl with everything external mocked; return (stats, stdout, marks).

    The watchdog budget is injected by patching _resolve_keyword_timeout rather
    than via the env var: the real resolver clamps to a 30s floor (deliberately —
    see TestKeywordTimeoutResolution), which would make every test here take 30s.
    The clamp is production behaviour worth keeping; it is tested separately.
    """
    buf = io.StringIO()
    marks: list = []

    def _mark(keyword, status, error="", **kw):
        marks.append((keyword, status, error))

    with patch("crawl_queue_ops.count_pending_items", return_value=len(keywords)), \
         patch("crawl_queue_ops.fetch_due_crawl_items", return_value=_items(keywords)), \
         patch("crawl_queue_ops.clamp_concurrency", side_effect=lambda c: c), \
         patch("scraper_v2.PinterestSession", _FakeSession), \
         patch("scraper_v2.process_queue_item", process_impl), \
         patch("scraper_v2.mark_queue_item", _mark), \
         patch.object(pipeline, "_resolve_keyword_timeout", return_value=float(timeout_secs)), \
         patch.object(pipeline, "_CRAWL_HEARTBEAT_SECS", 1000.0):
        with contextlib.redirect_stdout(buf):
            result = await pipeline.step_crawl(
                concurrency=concurrency,
                replenish=False,
                dry_run=False,
                limit_keywords=len(keywords),
            )
    return result, buf.getvalue(), marks


class TestKeywordWatchdog(unittest.IsolatedAsyncioTestCase):
    """A hung keyword must be cancelled, counted, and must not block the run."""

    async def test_hung_keyword_is_cancelled_and_counted_as_failed(self):
        cancelled: list = []

        async def fake_process(**kw):
            if kw["keyword"] == "hangs":
                try:
                    await asyncio.Event().wait()   # never returns, exactly like the VPS
                except asyncio.CancelledError:
                    cancelled.append(kw["keyword"])
                    raise
            return 5, []

        stats, out, _ = await _run_step_crawl(
            ["hangs", "ok1", "ok2"], fake_process, concurrency=2, timeout_secs=0.2
        )

        # It really was cancelled, not merely abandoned.
        self.assertEqual(cancelled, ["hangs"])
        # Explicit failure accounting — the project red line.
        self.assertEqual(stats["failed_keywords"], 1, out)
        self.assertEqual(stats["timed_out_keywords"], 1, out)
        self.assertEqual(stats["errors"], 1, out)
        # And the other keywords still finished.
        self.assertEqual(stats["processed"], 2, out)
        self.assertEqual(stats["pins"], 10, out)

    async def test_timeout_is_named_in_the_log_and_summary(self):
        async def fake_process(**kw):
            if kw["keyword"] == "hangs":
                await asyncio.Event().wait()
            return 1, []

        stats, out, _ = await _run_step_crawl(
            ["hangs", "ok1"], fake_process, concurrency=2, timeout_secs=0.2
        )

        # The stuck keyword must be named on the flushed progress channel.
        self.assertIn("hangs TIMEOUT", out)
        self.assertIn("slot released", out)
        # ...and must show up in the closing summary, not hide in it.
        self.assertRegex(out, r"\[crawl\] summary .*failed=1 timed_out=1")

    async def test_semaphore_slot_is_released_so_later_keywords_run(self):
        """The failure mode was slot starvation: 5 hung keywords, 0 further completions.

        With concurrency=1 nothing after the hung keyword can run *at all* unless
        the slot is genuinely returned, so this is a direct test of the property.
        """
        finished: list = []

        async def fake_process(**kw):
            if kw["keyword"] == "hangs":
                await asyncio.Event().wait()
            finished.append(kw["keyword"])
            return 1, []

        stats, out, _ = await _run_step_crawl(
            ["hangs", "after1", "after2"], fake_process,
            concurrency=1, timeout_secs=0.2,
        )

        self.assertEqual(finished, ["after1", "after2"], out)
        self.assertEqual(stats["processed"], 2, out)
        self.assertEqual(stats["timed_out_keywords"], 1, out)

    async def test_every_slot_hung_still_drains_the_whole_queue(self):
        """Reproduces the VPS shape: all concurrency slots hang at once."""
        async def fake_process(**kw):
            if kw["keyword"].startswith("hang"):
                await asyncio.Event().wait()
            return 2, []

        keywords = ["hang1", "hang2", "hang3", "good1", "good2"]
        stats, out, _ = await _run_step_crawl(
            keywords, fake_process, concurrency=3, timeout_secs=0.2
        )

        # Before the fix this run never terminated; now every keyword is accounted for.
        self.assertEqual(stats["timed_out_keywords"], 3, out)
        self.assertEqual(stats["failed_keywords"], 3, out)
        self.assertEqual(stats["processed"], 2, out)

    async def test_timed_out_keyword_is_marked_failed_in_the_queue(self):
        """Cancellation raises CancelledError (BaseException), so process_queue_item's
        own `except Exception` cannot run — the row would rot in 'processing'."""
        async def fake_process(**kw):
            if kw["keyword"] == "hangs":
                await asyncio.Event().wait()
            return 1, []

        _, out, marks = await _run_step_crawl(
            ["hangs", "ok1"], fake_process, concurrency=2, timeout_secs=0.2
        )

        self.assertEqual(len(marks), 1, f"expected one queue write, got {marks}")
        keyword, status, error = marks[0]
        self.assertEqual(keyword, "hangs")
        self.assertEqual(status, "failed")
        self.assertIn("timeout", error.lower())

    async def test_normal_keywords_are_untouched_by_the_watchdog(self):
        """The ceiling must not perturb the happy path."""
        async def fake_process(**kw):
            await asyncio.sleep(0.01)
            return 4, ["p"]

        stats, out, marks = await _run_step_crawl(
            ["a", "b", "c"], fake_process, concurrency=2, timeout_secs=30
        )

        self.assertEqual(stats["processed"], 3, out)
        self.assertEqual(stats["failed_keywords"], 0, out)
        self.assertEqual(stats["timed_out_keywords"], 0, out)
        self.assertEqual(marks, [], "no queue writes expected on the happy path")


class TestKeywordTimeoutResolution(unittest.TestCase):
    """The ceiling is configurable but can never be disabled by a bad value."""

    def _resolve(self, raw):
        env = {} if raw is None else {"PINTEREST_KEYWORD_TIMEOUT_SECONDS": raw}
        with patch.dict("os.environ", env, clear=False):
            if raw is None:
                import os
                os.environ.pop("PINTEREST_KEYWORD_TIMEOUT_SECONDS", None)
            return pipeline._resolve_keyword_timeout()

    def test_default_is_300s(self):
        self.assertEqual(self._resolve(None), 300.0)

    def test_env_override_is_honoured(self):
        self.assertEqual(self._resolve("120"), 120.0)

    def test_garbage_falls_back_to_default(self):
        self.assertEqual(self._resolve("not-a-number"), 300.0)

    def test_value_is_clamped_so_it_can_never_be_effectively_infinite(self):
        self.assertEqual(self._resolve("999999"), 3600.0)
        self.assertEqual(self._resolve("0"), 30.0)
        self.assertEqual(self._resolve("-5"), 30.0)


class TestSessionRequestChokepoint(unittest.IsolatedAsyncioTestCase):
    """Root cause: the curl handle-pool acquire was an untimed await."""

    async def test_request_bounds_a_call_that_never_returns(self):
        """A get() that hangs forever (the pop_curl case) must raise, not block."""
        session = scraper_v2.PinterestSession()

        class _HangingSession:
            async def get(self, *a, **kw):
                await asyncio.Event().wait()

        session._session = _HangingSession()
        session._timeout = 0.01   # budget = timeout + margin

        with patch.object(scraper_v2.asyncio, "wait_for", wraps=asyncio.wait_for) as wf:
            with self.assertRaises((asyncio.TimeoutError, TimeoutError)):
                await asyncio.wait_for(
                    session._request("https://www.pinterest.com/"), timeout=5
                )
            self.assertTrue(wf.called, "_request must go through asyncio.wait_for")

    async def test_get_json_reports_a_stalled_pool_instead_of_hanging(self):
        """_get_json must degrade to {} with a NAMED error, never hang the worker."""
        session = scraper_v2.PinterestSession()
        session._timeout = 0.01
        session._delay = 0.0

        class _HangingSession:
            async def get(self, *a, **kw):
                await asyncio.Event().wait()

        session._session = _HangingSession()

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            data = await asyncio.wait_for(
                session._get_json("https://www.pinterest.com/x"), timeout=5
            )

        self.assertEqual(data, {})
        out = buf.getvalue()
        self.assertIn("GET failed", out)
        # A bare str(TimeoutError()) is empty; the type name must be printed.
        self.assertIn("TimeoutError", out)

    async def test_every_curl_get_goes_through_the_chokepoint(self):
        """No call site may bypass _request and reach the raw session directly."""
        body = SCRAPER_SRC.split("class PinterestSession")[1].split("\n# ── Build record")[0]
        # _request is the chokepoint itself: it holds the ONE legitimate raw call,
        # and that call is the one wrapped in wait_for. Everything else must route
        # through it.
        before, _, inside_request = body.partition("    async def _request(")
        chokepoint_body, _, after_request = inside_request.partition("\n    async def ")
        self.assertIn("asyncio.wait_for(", chokepoint_body,
                      "_request must bound the raw call with wait_for")
        offenders = [
            line.strip()
            for line in (before + after_request).splitlines()
            if "self._session.get(" in line
        ]
        self.assertEqual(
            offenders, [],
            "these bypass the bounded _request chokepoint:\n" + "\n".join(offenders),
        )


class TestConcurrentSessionRebuild(unittest.IsolatedAsyncioTestCase):
    """Rebuilding a SHARED session concurrently is what stranded the parked
    coroutines: close() empties the handle pool without waking pool.get() waiters."""

    def _session(self):
        session = scraper_v2.PinterestSession()
        session._timeout = 0.01
        closed: list = []

        class _Sess:
            def __init__(self, tag):
                self.tag = tag

            async def close(self):
                closed.append(self.tag)

        counter = {"n": 0}

        def _make():
            counter["n"] += 1
            return _Sess(counter["n"])

        session._make_session = _make            # type: ignore[method-assign]
        session._bootstrap = self._noop          # type: ignore[method-assign]
        session._session = _Sess(0)
        return session, closed

    @staticmethod
    async def _noop():
        return None

    async def test_simultaneous_rebuilds_do_not_stack(self):
        """Five workers hitting SSL at once must produce ONE rebuild, not five.

        Each extra rebuild is another close() of a session other coroutines are
        already parked on — i.e. another batch of permanently-hung awaits.
        """
        session, closed = self._session()
        with patch.object(scraper_v2.asyncio, "sleep", new=self._fast_sleep):
            gen = session._generation
            await asyncio.gather(*[
                session._rebuild_session(seen_generation=gen) for _ in range(5)
            ])

        self.assertEqual(session._ssl_rebuilds, 1,
                         "concurrent SSL errors must collapse into one rebuild")
        self.assertEqual(len(closed), 1, f"only the original session may be closed: {closed}")

    async def test_rebuild_publishes_new_session_before_closing_the_old(self):
        session, _ = self._session()
        order: list = []
        original_make = session._make_session

        def _make():
            order.append("make")
            return original_make()

        session._make_session = _make            # type: ignore[method-assign]
        old = session._session

        async def _close():
            order.append("close")

        old.close = _close                        # type: ignore[method-assign]

        with patch.object(scraper_v2.asyncio, "sleep", new=self._fast_sleep):
            await session._rebuild_session()

        self.assertEqual(order, ["make", "close"],
                         "the healthy session must be published before the old one dies")
        self.assertIsNot(session._session, old)

    async def test_generation_advances_so_stale_callers_skip_redundant_rebuilds(self):
        session, closed = self._session()
        with patch.object(scraper_v2.asyncio, "sleep", new=self._fast_sleep):
            await session._rebuild_session()
            self.assertEqual(session._generation, 1)
            # A coroutine still holding the pre-rebuild generation must not rebuild again.
            await session._rebuild_session(seen_generation=0)

        self.assertEqual(session._ssl_rebuilds, 1)
        self.assertEqual(len(closed), 1)

    # Bound to the real coroutine function, so patching scraper_v2.asyncio.sleep
    # cannot make this recurse into itself.
    _real_sleep = staticmethod(asyncio.sleep)

    @staticmethod
    async def _fast_sleep(_secs, *a, **kw):
        # Skip the 2s backoff inside _rebuild_session without slowing the suite;
        # still yields to the loop so interleaving is exercised.
        await TestConcurrentSessionRebuild._real_sleep(0)


if __name__ == "__main__":
    unittest.main()
