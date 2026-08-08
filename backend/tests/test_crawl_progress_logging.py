"""Tests for pin-crawl progress observability (pure logging, no behaviour change).

Background: on 2026-08-08 the scheduled pin-crawl ran for the full 7200s timeout and
produced ZERO log lines between "starting" and "terminating" — every keyword was
launched at once into asyncio.gather(), which only returns when the slowest task is
done, and pipeline._info() prints without flushing (journald sees a block-buffered
pipe). This file pins down the four observability guarantees:

  1. every finished keyword emits a numbered progress line while the run continues
  2. a failing keyword's exception text is visible (never swallowed by gather)
  3. the heartbeat task is cancelled when the gather ends (no dangling task)
  4. the closing summary names the slowest keywords

No network, no DB, no real crawl: process_queue_item / PinterestSession /
crawl_queue_ops are all mocked at their source modules (step_crawl imports them
lazily inside the function body, so patching `pipeline.X` would not take effect).
"""
import asyncio
import contextlib
import io
import re
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
import pipeline  # noqa: E402

PIPELINE_SRC = (BACKEND / "pipeline.py").read_text(encoding="utf-8")


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


async def _run_step_crawl(keywords, process_impl, heartbeat_secs=1000.0):
    """Run step_crawl with everything external mocked; return captured stdout."""
    buf = io.StringIO()
    with patch("crawl_queue_ops.count_pending_items", return_value=len(keywords)), \
         patch("crawl_queue_ops.fetch_due_crawl_items", return_value=_items(keywords)), \
         patch("crawl_queue_ops.clamp_concurrency", side_effect=lambda c: c), \
         patch("scraper_v2.PinterestSession", _FakeSession), \
         patch("scraper_v2.process_queue_item", process_impl), \
         patch.object(pipeline, "_CRAWL_HEARTBEAT_SECS", heartbeat_secs):
        with contextlib.redirect_stdout(buf):
            result = await pipeline.step_crawl(
                concurrency=2, replenish=False, dry_run=True, limit_keywords=len(keywords)
            )
    return result, buf.getvalue()


class TestPerKeywordProgress(unittest.IsolatedAsyncioTestCase):
    async def test_every_completed_keyword_logs_a_numbered_line(self):
        async def fake_process(**kw):
            return 7, ["a", "b"]

        result, out = await _run_step_crawl(["alpha", "beta", "gamma"], fake_process)

        self.assertEqual(result["processed"], 3)
        for kw in ("alpha", "beta", "gamma"):
            self.assertRegex(
                out,
                rf"\[crawl\] \d+/3 {kw} ok pins=7 premium=2 took=\d+\.\d+s",
                f"missing per-keyword progress line for {kw}\n{out}",
            )
        # counter must run 1..3 exactly once each
        seen = sorted(int(m) for m in re.findall(r"\[crawl\] (\d+)/3 \w+ ", out))
        self.assertEqual(seen, [1, 2, 3], out)

    async def test_progress_lines_are_flushed(self):
        # The whole point: journald must see lines while the run is still going.
        # Contract check on the source, since redirect_stdout hides real flushing.
        self.assertIn("def _crawl_log(msg: str) -> None:", PIPELINE_SRC)
        self.assertIn("print(msg, flush=True)", PIPELINE_SRC)
        body = PIPELINE_SRC.split("async def step_crawl")[1]
        self.assertIn("_crawl_log(", body)


class TestFailuresAreVisible(unittest.IsolatedAsyncioTestCase):
    async def test_exception_text_appears_in_output(self):
        async def fake_process(**kw):
            if kw["keyword"] == "boom":
                raise RuntimeError("proxy tunnel collapsed")
            return 3, []

        result, out = await _run_step_crawl(["ok1", "boom", "ok2"], fake_process)

        self.assertEqual(result["processed"], 2)
        self.assertEqual(result["failed_keywords"], 1)
        self.assertIn("boom", out)
        self.assertIn("FAILED", out)
        self.assertIn("RuntimeError", out)
        self.assertIn("proxy tunnel collapsed", out,
                      "the exception message must not be swallowed by gather()")
        self.assertRegex(out, r"\[crawl\] \d+/3 boom FAILED took=\d+\.\d+s "
                              r"error=RuntimeError: proxy tunnel collapsed")

    async def test_failed_keyword_still_counts_toward_progress(self):
        async def fake_process(**kw):
            raise ValueError("nope")

        _, out = await _run_step_crawl(["k1", "k2"], fake_process)
        seen = sorted(int(m) for m in re.findall(r"\[crawl\] (\d+)/2 \w+ ", out))
        self.assertEqual(seen, [1, 2], out)


class TestHeartbeat(unittest.IsolatedAsyncioTestCase):
    async def test_heartbeat_names_in_flight_keywords(self):
        release = asyncio.Event()

        async def fake_process(**kw):
            if kw["keyword"] == "slowpoke":
                await release.wait()
            return 1, []

        async def unblock_soon():
            await asyncio.sleep(0.25)
            release.set()

        buf = io.StringIO()
        with patch("crawl_queue_ops.count_pending_items", return_value=2), \
             patch("crawl_queue_ops.fetch_due_crawl_items",
                   return_value=_items(["slowpoke", "quick"])), \
             patch("crawl_queue_ops.clamp_concurrency", side_effect=lambda c: c), \
             patch("scraper_v2.PinterestSession", _FakeSession), \
             patch("scraper_v2.process_queue_item", fake_process), \
             patch.object(pipeline, "_CRAWL_HEARTBEAT_SECS", 0.05):
            with contextlib.redirect_stdout(buf):
                unblocker = asyncio.create_task(unblock_soon())
                await pipeline.step_crawl(concurrency=2, replenish=False,
                                          dry_run=True, limit_keywords=2)
                await unblocker
        out = buf.getvalue()

        self.assertIn("[crawl] heartbeat", out, out)
        self.assertRegex(out, r"\[crawl\] heartbeat done=\d+/2 elapsed=\d+s in_flight=\d+:")
        self.assertIn("slowpoke (", out,
                      "the heartbeat must name the keyword that is still running")

    async def test_heartbeat_is_cancelled_and_leaks_no_task(self):
        async def fake_process(**kw):
            return 2, []

        before = {t for t in asyncio.all_tasks() if t is not asyncio.current_task()}
        await _run_step_crawl(["a", "b"], fake_process, heartbeat_secs=0.02)
        await asyncio.sleep(0.1)  # a leaked heartbeat would still be alive after this
        after = {t for t in asyncio.all_tasks() if t is not asyncio.current_task()}

        leaked = [t for t in after - before if not t.done()]
        self.assertEqual(leaked, [], f"heartbeat task leaked: {leaked}")

    async def test_heartbeat_cancelled_even_if_a_keyword_raises(self):
        async def fake_process(**kw):
            raise RuntimeError("kaboom")

        before = {t for t in asyncio.all_tasks() if t is not asyncio.current_task()}
        await _run_step_crawl(["a"], fake_process, heartbeat_secs=0.02)
        await asyncio.sleep(0.1)
        after = {t for t in asyncio.all_tasks() if t is not asyncio.current_task()}
        self.assertEqual([t for t in after - before if not t.done()], [])

    def test_heartbeat_cancellation_is_in_a_finally(self):
        body = PIPELINE_SRC.split("async def step_crawl")[1]
        self.assertIn("heartbeat.cancel()", body)
        self.assertIn("except asyncio.CancelledError:", body)


class TestSummary(unittest.IsolatedAsyncioTestCase):
    async def test_summary_reports_totals_and_slowest_keywords(self):
        # Gaps must exceed step_crawl's own (untouched) random.uniform(0.3, 0.8)
        # jitter, whose 0.5s spread would otherwise reshuffle small deltas.
        delays = {"slow1": 3.0, "slow2": 2.0, "slow3": 1.0, "fast": 0.0}

        async def fake_process(**kw):
            await asyncio.sleep(delays[kw["keyword"]])
            return 5, []

        result, out = await _run_step_crawl(
            ["fast", "slow3", "slow2", "slow1"], fake_process
        )

        self.assertEqual(result["processed"], 4)
        summary = [ln for ln in out.splitlines() if "[crawl] summary" in ln]
        self.assertEqual(len(summary), 1, out)
        line = summary[0]
        self.assertIn("total=4", line)
        self.assertIn("ok=4", line)
        self.assertIn("failed=0", line)
        self.assertIn("pins=20", line)
        self.assertRegex(line, r"elapsed=\d+\.\d+s")
        # slowest three, in descending order; "fast" must not be listed
        slowest = line.split("slowest=")[1]
        self.assertLess(slowest.index("slow1"), slowest.index("slow2"), line)
        self.assertLess(slowest.index("slow2"), slowest.index("slow3"), line)
        self.assertNotIn("fast", slowest, line)

    async def test_summary_marks_failed_keywords_in_slowest_list(self):
        async def fake_process(**kw):
            if kw["keyword"] == "hangy":
                await asyncio.sleep(0.2)
                raise TimeoutError("read timeout")
            return 1, []

        _, out = await _run_step_crawl(["hangy", "ok"], fake_process)
        line = [ln for ln in out.splitlines() if "[crawl] summary" in ln][0]
        self.assertIn("failed=1", line)
        self.assertIn("hangy", line.split("slowest=")[1])
        self.assertIn("(FAILED)", line)


class TestNoBehaviourChange(unittest.TestCase):
    """This change is observability-only: the crawl mechanics must be untouched."""

    def test_crawl_mechanics_unchanged(self):
        body = PIPELINE_SRC.split("async def step_crawl")[1]
        self.assertIn("sem = asyncio.Semaphore(concurrency)", body)
        self.assertIn("await asyncio.sleep(random.uniform(0.3, 0.8))", body)
        self.assertIn("await asyncio.gather(*tasks, return_exceptions=True)", body)
        self.assertIn("expand_related=True", body)
        self.assertIn("max_pins=max_pins", body)
        self.assertIn("clamp_concurrency", PIPELINE_SRC)


if __name__ == "__main__":
    unittest.main(verbosity=2)
