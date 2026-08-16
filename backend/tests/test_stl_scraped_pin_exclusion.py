"""The STL source selector must stop handing back pins it already scraped.

THE BUG THESE TESTS PIN DOWN (measured 2026-08-07 against production):

    pin_samples pool          26,124 pins
    ever scraped for products    260 pins  ( 1%)
    never scraped             25,864 pins  (99%)

Three consecutive runs nonetheless selected the SAME pin ids (492649954992465,
11259067814597151, 844493676706223, ...) and produced single-digit new rows out
of dozens of candidates — the products were already in the database. The cause
was that the only exclusion list came from a local JSON log
(``logs/shop_the_look_spike.json``), which is per-machine and easily lost,
while the authoritative record — ``pin_products.source_pin_id`` — was never
consulted. On top of that, ``select_source_pins`` had a last-resort ``take(...,
allow_overlap=True)`` that re-admitted avoided pins whenever a category came up
short, so even a correct exclusion list would have self-defeated at exactly the
moment it mattered.
"""

import json
import sys
import unittest
from unittest.mock import MagicMock, patch

import httpx

import shop_the_look_expand as stl


def _fake_response(rows: list[dict]) -> MagicMock:
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = rows
    return resp


class TestScrapedSourcePinLoaderPaginates(unittest.TestCase):
    """PostgREST caps one response at 1000 rows; pin_products holds 3700+.

    A non-paging read would silently return the first 1000 rows and the
    exclusion list would be quietly incomplete — the same class of silent
    truncation that made this bug invisible for weeks. These tests drive the
    REAL paging loop in db.DB.select_many by faking the HTTP layer only.
    """

    def test_reads_all_2500_ids_across_three_pages(self):
        ids = [f"pin{n:06d}" for n in range(2500)]
        pages = [
            [{"source_pin_id": i} for i in ids[0:1000]],
            [{"source_pin_id": i} for i in ids[1000:2000]],
            [{"source_pin_id": i} for i in ids[2000:2500]],
        ]
        calls: list[dict] = []

        def fake_request(method, table, **kwargs):
            calls.append({"method": method, "table": table,
                          "params": dict(kwargs.get("params") or {})})
            return _fake_response(pages[len(calls) - 1])

        with patch("db._request", side_effect=fake_request):
            got = stl._load_scraped_source_pin_ids()

        self.assertEqual(len(got), 2500,
                         "loader must page past the 1000-row PostgREST cap")
        self.assertEqual(got, set(ids))
        # Three GETs, walking the offset — not one truncated read.
        self.assertEqual(len(calls), 3, [c["params"] for c in calls])
        self.assertTrue(all(c["method"] == "get" for c in calls))
        self.assertTrue(all(c["table"] == "pin_products" for c in calls))
        self.assertEqual([c["params"].get("offset") for c in calls],
                         ["0", "1000", "2000"])
        self.assertEqual([c["params"].get("limit") for c in calls],
                         ["1000", "1000", "1000"])

    def test_queries_only_non_null_source_pin_ids(self):
        with patch("db._request", return_value=_fake_response([])) as req:
            stl._load_scraped_source_pin_ids()
        params = req.call_args.kwargs["params"]
        self.assertEqual(params.get("source_pin_id"), "not.is.null")
        self.assertEqual(params.get("select"), "source_pin_id")

    def test_null_and_blank_ids_are_dropped(self):
        rows = [{"source_pin_id": "a"}, {"source_pin_id": None},
                {"source_pin_id": ""}, {"source_pin_id": 12345}]
        with patch("db._request", return_value=_fake_response(rows)):
            got = stl._load_scraped_source_pin_ids()
        self.assertEqual(got, {"a", "12345"})


class TestScrapedPinLoaderFailsLoud(unittest.TestCase):
    """A failed read must NOT return an empty set.

    An empty set is indistinguishable from "nothing has ever been scraped", so
    the run would sail on and re-scrape the highest-save pins it just finished
    harvesting — the exact bug, restored, but now invisible. Project red line:
    failure must be explicit.
    """

    def test_transport_error_raises_instead_of_returning_empty(self):
        with patch("db._request", side_effect=httpx.ConnectError("boom")):
            with self.assertRaises(stl.ScrapedPinHistoryUnavailable) as ctx:
                stl._load_scraped_source_pin_ids()
        msg = str(ctx.exception)
        self.assertIn("pin_products", msg)
        self.assertIn("ConnectError", msg)

    def test_http_error_status_raises(self):
        bad = MagicMock()
        bad.status_code = 500
        bad.text = "upstream exploded"
        with patch("db._request", return_value=bad):
            with self.assertRaises(stl.ScrapedPinHistoryUnavailable):
                stl._load_scraped_source_pin_ids()

    def test_never_returns_empty_set_on_failure(self):
        """Directly asserts the anti-pattern: no failure path yields set()."""
        for exc in (httpx.ReadTimeout("t"), RuntimeError("select failed [500]"),
                    OSError("socket")):
            with self.subTest(exc=type(exc).__name__):
                with patch("db._request", side_effect=exc):
                    try:
                        result = stl._load_scraped_source_pin_ids()
                    except stl.ScrapedPinHistoryUnavailable:
                        continue
                    self.fail(
                        f"loader swallowed {type(exc).__name__} and returned "
                        f"{result!r} — a silent empty exclusion list re-enables "
                        "repeat scraping"
                    )

    def test_run_aborts_before_the_browser_starts(self):
        """The failure must stop the run, not degrade it. ~25 minutes of
        crawling spent re-scraping known pins is worse than not running."""
        import asyncio
        from contextlib import ExitStack

        with ExitStack() as stack:
            stack.enter_context(patch.object(stl, "_load_previous_spike_ids",
                                             return_value=set()))
            stack.enter_context(patch.object(
                stl, "_load_scraped_source_pin_ids",
                side_effect=stl.ScrapedPinHistoryUnavailable("db down"),
            ))
            select_mock = stack.enter_context(
                patch.object(stl, "select_source_pins", return_value=([], {})))
            fake_pw = MagicMock()
            stack.enter_context(patch.dict(
                sys.modules,
                {"playwright.async_api": type("M", (), {"async_playwright": fake_pw})},
            ))
            with self.assertRaises(stl.ScrapedPinHistoryUnavailable):
                asyncio.run(stl.run_shop_the_look_expand(apply=False))

        select_mock.assert_not_called()
        fake_pw.assert_not_called()


class TestExclusionActuallyExcludes(unittest.TestCase):
    """Selection must skip avoided pins even though they sort first.

    _query_sources orders by save_count.desc, so the already-scraped pins are
    precisely the ones at the top of every result set. If the exclusion were
    applied anywhere but before the take, the highest-save spent pins would win
    again.
    """

    @staticmethod
    def _rows(n: int, *, prefix: str = "p", start_saves: int = 10_000) -> list[dict]:
        return [{"pin_id": f"{prefix}{i}", "category": "home-decor",
                 "save_count": start_saves - i, "title": "chair",
                 "description": "", "is_ecommerce": False}
                for i in range(n)]

    def _select(self, rows, *, wanted, avoid):
        with patch.object(stl, "_query_sources", return_value=list(rows)):
            return stl.select_source_pins(
                category_mix={"home-decor": wanted},
                avoid_pin_ids=set(avoid),
            )

    def test_already_scraped_pins_are_not_selected(self):
        rows = self._rows(20)
        avoid = {"p0", "p1", "p2", "p3", "p4"}  # the five highest-save pins
        selected, meta = self._select(rows, wanted=5, avoid=avoid)

        picked = {r["pin_id"] for r in selected}
        self.assertEqual(len(picked), 5)
        self.assertFalse(picked & avoid,
                         f"avoided pins leaked into the selection: {picked & avoid}")
        self.assertEqual(picked, {"p5", "p6", "p7", "p8", "p9"})
        self.assertEqual(meta["byCategory"]["home-decor"]["overlap"], 0)

    def test_selection_advances_across_consecutive_runs(self):
        """Run 2 must not re-offer run 1's pins — the observed symptom."""
        rows = self._rows(30)
        first, _ = self._select(rows, wanted=10, avoid=set())
        first_ids = {r["pin_id"] for r in first}

        second, _ = self._select(rows, wanted=10, avoid=first_ids)
        second_ids = {r["pin_id"] for r in second}

        self.assertEqual(len(second_ids), 10)
        self.assertFalse(first_ids & second_ids,
                         "consecutive runs selected the same pins again")


class TestNoRepeatScrapeFallback(unittest.TestCase):
    """When a category runs short, under-select and SAY SO.

    The removed `take(pool + fallback, allow_overlap=True)` used to top the
    quota up with already-scraped pins. That made every category look full
    while the crawler burned ~53 s/pin on pins whose products were already in
    the database.
    """

    def _short_pool(self, avoid):
        rows = [{"pin_id": f"p{i}", "category": "home-decor",
                 "save_count": 100 - i, "title": "", "description": "",
                 "is_ecommerce": False} for i in range(10)]
        with patch.object(stl, "_query_sources", return_value=rows):
            return stl.select_source_pins(
                category_mix={"home-decor": 8}, avoid_pin_ids=set(avoid)
            )

    def test_under_selects_rather_than_repeating(self):
        avoid = {f"p{i}" for i in range(7)}  # only p7, p8, p9 remain
        selected, meta = self._short_pool(avoid)

        picked = {r["pin_id"] for r in selected}
        self.assertEqual(picked, {"p7", "p8", "p9"})
        self.assertFalse(picked & avoid, "fell back to re-scraping avoided pins")
        self.assertEqual(meta["selectedTotal"], 3)
        self.assertEqual(meta["byCategory"]["home-decor"]["overlap"], 0)

    def test_exhaustion_is_reported_per_category(self):
        avoid = {f"p{i}" for i in range(7)}
        _selected, meta = self._short_pool(avoid)

        exhaustion = meta["selectionExhaustion"]
        cat = exhaustion["byCategory"]["home-decor"]
        self.assertEqual(cat["requested"], 8)
        self.assertEqual(cat["candidatesBeforeExclusion"], 10)
        self.assertEqual(cat["candidatesAfterExclusion"], 3)
        self.assertEqual(cat["excludedAlreadyScraped"], 7)
        self.assertEqual(cat["selected"], 3)
        self.assertEqual(cat["shortfall"], 5)
        self.assertEqual(exhaustion["totalShortfall"], 5)
        self.assertEqual(exhaustion["exhaustedCategories"], ["home-decor"])
        self.assertIs(exhaustion["repeatScrapeFallbackUsed"], False)

    def test_shortfall_is_logged_loudly(self):
        avoid = {f"p{i}" for i in range(7)}
        with patch("builtins.print") as printed:
            self._short_pool(avoid)
        text = " ".join(str(c.args[0]) for c in printed.call_args_list if c.args)
        self.assertIn("home-decor", text)
        self.assertIn("requested 8", text)
        self.assertIn("shortfall 5", text)

    def test_full_category_reports_zero_shortfall(self):
        selected, meta = self._short_pool(set())
        self.assertEqual(len(selected), 8)
        cat = meta["selectionExhaustion"]["byCategory"]["home-decor"]
        self.assertEqual(cat["shortfall"], 0)
        self.assertEqual(cat["candidatesAfterExclusion"], 10)
        self.assertEqual(meta["selectionExhaustion"]["exhaustedCategories"], [])

    def test_candidate_counts_do_not_double_count_pool_and_fallback(self):
        """_query_sources is called twice (bootstrap-only, then unfiltered) and
        the two result sets overlap. Counting them naively would report 20
        candidates for a 10-pin category and make exhaustion unreadable."""
        _selected, meta = self._short_pool(set())
        cat = meta["selectionExhaustion"]["byCategory"]["home-decor"]
        self.assertEqual(cat["candidatesBeforeExclusion"], 10)


class TestSpikeLogAndDatabaseUnion(unittest.TestCase):
    """Both memories are used. Neither replaces the other.

    The spike log still knows what the machine that wrote it scraped; the
    database knows what every machine scraped. Dropping either loses history.
    """

    def _run_selection(self, *, spike_ids, db_ids):
        import asyncio
        from contextlib import ExitStack

        captured: dict = {}

        class _StopSelection(Exception):
            """Cut the run off the moment selection is reached — we only care
            about what was passed in, not about crawling."""

        def fake_select(**kwargs):
            captured.update(kwargs)
            raise _StopSelection()

        with ExitStack() as stack:
            stack.enter_context(patch.object(stl, "_load_previous_spike_ids",
                                             return_value=set(spike_ids)))
            stack.enter_context(patch.object(stl, "_load_scraped_source_pin_ids",
                                             return_value=set(db_ids)))
            stack.enter_context(patch.object(stl, "select_source_pins",
                                             side_effect=fake_select))
            stack.enter_context(patch.dict(
                sys.modules,
                {"playwright.async_api": type("M", (), {"async_playwright": MagicMock()})},
            ))
            with self.assertRaises(_StopSelection):
                asyncio.run(stl.run_shop_the_look_expand(apply=False))
        return captured

    def test_avoid_set_is_the_union(self):
        captured = self._run_selection(spike_ids={"a", "b"}, db_ids={"b", "c", "d"})
        self.assertEqual(captured["avoid_pin_ids"], {"a", "b", "c", "d"})

    def test_database_ids_alone_are_enough(self):
        """The spike log is routinely absent on a fresh host; the DB must still
        drive the exclusion."""
        captured = self._run_selection(spike_ids=set(), db_ids={"x", "y"})
        self.assertEqual(captured["avoid_pin_ids"], {"x", "y"})

    def test_spike_log_ids_are_not_dropped(self):
        """Regression guard: the DB read must not REPLACE the log-based set."""
        captured = self._run_selection(spike_ids={"legacy1"}, db_ids=set())
        self.assertIn("legacy1", captured["avoid_pin_ids"])

    def test_provenance_is_reported(self):
        captured = self._run_selection(spike_ids={"a", "b"}, db_ids={"b", "c", "d"})
        sources = captured["avoid_sources"]
        self.assertEqual(sources["spikeLog"], 2)
        self.assertEqual(sources["database"], 3)
        self.assertEqual(sources["overlap"], 1)
        self.assertEqual(sources["union"], 4)

    def test_avoid_sources_reaches_the_selection_meta(self):
        with patch.object(stl, "_query_sources", return_value=[]):
            _sel, meta = stl.select_source_pins(
                category_mix={"home-decor": 1},
                avoid_pin_ids={"a"},
                avoid_sources={"spikeLog": 0, "database": 1, "union": 1},
            )
        self.assertEqual(meta["avoidSources"]["database"], 1)


class TestFrozenSourceReportSkipsTheDatabase(unittest.TestCase):
    """--source-report freezes the source set on purpose (audit trail). That
    path must not query pin_products at all: it does not select."""

    def test_source_report_path_does_not_load_scraped_ids(self):
        import asyncio
        import tempfile
        from contextlib import ExitStack
        from pathlib import Path

        report = {
            "engine": "shop-the-look",
            "mode": "dry-run",
            "perPin": [{"sourcePinId": "1", "category": "home-decor", "saveCount": 5}],
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "report.json"
            path.write_text(json.dumps(report), encoding="utf-8")

            class _StopBeforeBrowser(Exception):
                pass

            with ExitStack() as stack:
                loader = stack.enter_context(
                    patch.object(stl, "_load_scraped_source_pin_ids", return_value=set()))
                # Stop the run the moment it reaches the browser: this test is
                # about what happens BEFORE that, and it must never touch the
                # network or the real session file.
                stack.enter_context(patch.object(
                    stl, "_load_session_state", side_effect=_StopBeforeBrowser))
                stack.enter_context(patch.dict(
                    sys.modules,
                    {"playwright.async_api": type("M", (), {"async_playwright": MagicMock()})},
                ))
                with self.assertRaises(_StopBeforeBrowser):
                    asyncio.run(stl.run_shop_the_look_expand(
                        limit=1,
                        category_mix={"home-decor": 1},
                        source_report_path=path,
                    ))
                loader.assert_not_called()


if __name__ == "__main__":
    unittest.main()
