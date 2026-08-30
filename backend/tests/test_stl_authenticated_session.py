"""Tests for Shop-the-Look authenticated-session loading and honest failure reporting.

Background (measured, not assumed): the Pinterest Shop-the-Look module is
auth-gated. On the same 3 pins with the same code path, an anonymous context
produced 0 shop-keyword matches and 0 product JSON responses, while an
authenticated context produced 42-45 product JSON responses per pin. A run that
is unauthenticated / expired / non-rendering therefore reports "no products" for
pins that DO have products — which is how a rendering failure once got read as
"the data source is exhausted".

These tests lock in:
  * "Shop the Pin" (current UI wording) is detected, and the older wordings still are
  * a missing/unreadable session file degrades gracefully (warn, no crash) and
    marks the run unauthenticated
  * an expired session is surfaced explicitly, never as a clean zero
  * the renderFailure / pageSkeleton signal fires when a pin yields no cards,
    no tabs and no product JSON
  * a genuinely rendered + authenticated page with zero products is STILL
    reported as a trustworthy zero (no false positives)
  * no cookie/token values are ever logged

Playwright is fully mocked. No live network, no DB writes, no secrets.
"""
import asyncio
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "db"))

import shop_the_look_expand as stl  # noqa: E402


# --------------------------------------------------------------------------
# Module-wording detection
# --------------------------------------------------------------------------
class TestStlTextDetection(unittest.TestCase):
    def test_matches_shop_the_pin_current_wording(self):
        """The wording shipped in the live UI (2026-08-05) must be detected."""
        self.assertTrue(stl.STL_TEXT.search("Shop the Pin"))
        self.assertTrue(stl.STL_TEXT.search("shop the pin"))
        self.assertTrue(stl.STL_TEXT.search('<div aria-label="Shop the Pin">'))

    def test_existing_wordings_still_match(self):
        for wording in ("Shop the look", "shop similar", "More to shop",
                        "shop this", "buyable"):
            with self.subTest(wording=wording):
                self.assertTrue(stl.STL_TEXT.search(wording))

    def test_added_variants_match(self):
        for wording in ("Shop related", "Similar products", "shoppable"):
            with self.subTest(wording=wording):
                self.assertTrue(stl.STL_TEXT.search(wording))

    def test_unrelated_text_does_not_match(self):
        for wording in ("workshop the process", "no commerce here", "photography"):
            with self.subTest(wording=wording):
                self.assertIsNone(stl.STL_TEXT.search(wording))


# --------------------------------------------------------------------------
# Session file loading
# --------------------------------------------------------------------------
def _write_session(tmpdir: str, cookies: list[dict]) -> str:
    path = Path(tmpdir) / "sess.json"
    path.write_text(json.dumps({"cookies": cookies, "origins": []}), encoding="utf-8")
    return str(path)


class TestSessionLoading(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(stl.SESSION_PATH_ENV)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(stl.SESSION_PATH_ENV, None)
        else:
            os.environ[stl.SESSION_PATH_ENV] = self._saved

    def test_default_path_is_backend_pinterest_session_json(self):
        os.environ.pop(stl.SESSION_PATH_ENV, None)
        self.assertEqual(stl._stl_session_path().name, "pinterest_session.json")

    def test_env_var_overrides_path(self):
        os.environ[stl.SESSION_PATH_ENV] = "/custom/place/s.json"
        self.assertEqual(stl._stl_session_path(), Path("/custom/place/s.json"))

    def test_missing_file_degrades_gracefully(self):
        """A missing session file must NOT crash — it marks the run unauthenticated."""
        with tempfile.TemporaryDirectory() as tmp:
            os.environ[stl.SESSION_PATH_ENV] = str(Path(tmp) / "nope.json")
            status = stl._load_session_state()  # must not raise
        self.assertIsNone(status["storageState"])
        self.assertFalse(status["authenticated"])
        self.assertEqual(status["issue"], "session_file_missing")

    def test_unreadable_file_degrades_gracefully(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text("{not json at all", encoding="utf-8")
            os.environ[stl.SESSION_PATH_ENV] = str(bad)
            status = stl._load_session_state()  # must not raise
        self.assertIsNone(status["storageState"])
        self.assertFalse(status["authenticated"])
        self.assertTrue(status["issue"].startswith("session_file_unreadable"))

    def test_malformed_storage_state_degrades_gracefully(self):
        with tempfile.TemporaryDirectory() as tmp:
            bad = Path(tmp) / "bad.json"
            bad.write_text(json.dumps({"cookies": "not-a-list"}), encoding="utf-8")
            os.environ[stl.SESSION_PATH_ENV] = str(bad)
            status = stl._load_session_state()
        self.assertFalse(status["authenticated"])
        self.assertIn("malformed_storage_state", status["issue"])

    def test_valid_session_is_authenticated(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ[stl.SESSION_PATH_ENV] = _write_session(tmp, [
                {"name": "_auth", "value": "SECRETVALUE1"},
                {"name": "_pinterest_sess", "value": "SECRETVALUE2"},
                {"name": "csrftoken", "value": "SECRETVALUE3"},
            ])
            status = stl._load_session_state()
        self.assertTrue(status["authenticated"])
        self.assertIsNone(status["issue"])
        self.assertEqual(status["cookieCount"], 3)
        self.assertEqual(status["authCookiesPresent"], ["_auth", "_pinterest_sess"])

    def test_session_without_auth_cookies_is_unauthenticated(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ[stl.SESSION_PATH_ENV] = _write_session(tmp, [
                {"name": "csrftoken", "value": "x"},
            ])
            status = stl._load_session_state()
        self.assertFalse(status["authenticated"])
        self.assertEqual(status["issue"], "session_file_no_auth_cookies")

    def test_status_never_contains_cookie_values(self):
        """Status is logged — it must carry cookie NAMES only, never values."""
        with tempfile.TemporaryDirectory() as tmp:
            os.environ[stl.SESSION_PATH_ENV] = _write_session(tmp, [
                {"name": "_auth", "value": "SUPERSECRETTOKEN"},
                {"name": "_pinterest_sess", "value": "ANOTHERSECRET"},
            ])
            status = stl._load_session_state()
        loggable = {k: v for k, v in status.items() if k != "storageState"}
        blob = json.dumps(loggable)
        self.assertNotIn("SUPERSECRETTOKEN", blob)
        self.assertNotIn("ANOTHERSECRET", blob)


# --------------------------------------------------------------------------
# Session health check (expired session detection)
# --------------------------------------------------------------------------
class _FakePage:
    def __init__(self, url="https://www.pinterest.com/", html="", raise_on_content=None):
        self.url = url
        self._html = html
        self._raise = raise_on_content

    async def content(self):
        if self._raise:
            raise self._raise
        return self._html


class TestSessionHealthCheck(unittest.TestCase):
    def _verify(self, page):
        return asyncio.run(stl._verify_session_logged_in(page))

    def test_logged_in_marker_detected(self):
        res = self._verify(_FakePage(html='<div data-test-id="header-profile"></div>'))
        self.assertTrue(res["authValid"])

    def test_redirect_to_login_is_invalid(self):
        res = self._verify(_FakePage(url="https://www.pinterest.com/login/"))
        self.assertFalse(res["authValid"])
        self.assertEqual(res["signal"], "redirected_to_login")

    def test_unauth_header_is_invalid(self):
        res = self._verify(_FakePage(html='<div class="unauth-header">Log in</div>'))
        self.assertFalse(res["authValid"])
        self.assertEqual(res["signal"], "unauth_header_present")

    def test_probe_failure_is_unknown_not_false(self):
        """A failed probe must be None (unknown), never a confident False."""
        res = self._verify(_FakePage(raise_on_content=RuntimeError("boom")))
        self.assertIsNone(res["authValid"])
        self.assertTrue(res["signal"].startswith("probe_failed"))

    def test_no_marker_is_unknown(self):
        res = self._verify(_FakePage(html="<html><body>random</body></html>"))
        self.assertIsNone(res["authValid"])


# --------------------------------------------------------------------------
# renderFailure / pageSkeleton and honest zero reporting
# --------------------------------------------------------------------------
def _pin(**over):
    base = {
        "source": {"pin_id": "1", "category": "fashion", "save_count": 10},
        "issue": None,
        "shopModuleDetected": False,
        "shopTabClicked": False,
        "chipLabels": [],
        "visibleCardCount": 0,
        "tabCount": 0,
        "productJsonResponses": 0,
        "domEvalError": None,
        "pageSkeleton": False,
        "renderFailure": False,
        "candidates": [],
        "elapsedSec": 1.0,
    }
    base.update(over)
    return base


HEALTHY = {
    "sessionFileLoaded": True,
    "sessionPath": "/x/sess.json",
    "cookieCount": 10,
    "authCookiesPresent": ["_auth", "_pinterest_sess"],
    "authValid": True,
    "authSignal": "marker:header-profile",
    "issue": None,
}


class TestRenderFailureSignal(unittest.TestCase):
    """The scraper-side computation: does the skeleton signal fire correctly?"""

    def _extract(self, *, dom_cards, tabs, product_json, html):
        """Drive _extract_source_pin against a fully mocked page."""
        state = {"pin_id": None, "chip_label": None, "network": [],
                 "productJsonResponses": 0}

        class FakeLocator:
            async def inner_text(self_inner):
                return "some pin text"

        class FakeMouse:
            async def wheel(self_inner, x, y):
                return None

        class FakeTab:
            async def inner_text(self_inner):
                return "Shop"

            async def click(self_inner, timeout=None):
                return None

        class FakePage:
            url = "https://www.pinterest.com/pin/1/"
            mouse = FakeMouse()

            async def goto(self_inner, url, wait_until=None, timeout=None):
                # Simulate the network listener firing during navigation.
                state["productJsonResponses"] = product_json
                return None

            def locator(self_inner, sel):
                return FakeLocator()

            async def content(self_inner):
                return html

            async def evaluate(self_inner, script):
                return dom_cards

            async def query_selector_all(self_inner, sel):
                return [FakeTab() for _ in range(tabs)]

        async def _no_sleep(_):
            return None

        with patch.object(stl.asyncio, "sleep", _no_sleep):
            return asyncio.run(
                stl._extract_source_pin(FakePage(), {"pin_id": "1", "category": "fashion"}, state)
            )

    def test_skeleton_fires_when_nothing_rendered(self):
        """No cards, no tabs, no product JSON -> renderFailure, not a clean zero."""
        res = self._extract(dom_cards=[], tabs=0, product_json=0, html="<html></html>")
        self.assertTrue(res["pageSkeleton"])
        self.assertTrue(res["renderFailure"])
        self.assertEqual(res["issue"], "render_failure_or_unauthenticated")
        self.assertEqual(res["candidates"], [])

    def test_rendered_page_with_zero_products_is_not_a_render_failure(self):
        """A real shell that simply has no products must report an HONEST zero."""
        res = self._extract(
            dom_cards=[{"index": i, "href": None, "title": "t", "image_url": None, "price": None}
                       for i in range(6)],
            tabs=3, product_json=0, html="<html>Shop the Pin</html>",
        )
        self.assertFalse(res["pageSkeleton"])
        self.assertFalse(res["renderFailure"])
        self.assertIsNone(res["issue"])
        self.assertEqual(res["candidates"], [])

    def test_product_json_alone_prevents_skeleton(self):
        res = self._extract(dom_cards=[], tabs=0, product_json=42, html="<html></html>")
        self.assertFalse(res["pageSkeleton"])
        self.assertFalse(res["renderFailure"])
        self.assertEqual(res["productJsonResponses"], 42)

    def test_tabs_alone_prevent_skeleton(self):
        res = self._extract(dom_cards=[], tabs=2, product_json=0, html="<html></html>")
        self.assertFalse(res["pageSkeleton"])
        self.assertEqual(res["tabCount"], 2)

    def test_dom_eval_error_is_recorded_not_swallowed(self):
        """An evaluate() failure means we never looked — that must be visible."""
        state = {"pin_id": None, "chip_label": None, "network": [],
                 "productJsonResponses": 0}

        class FakeLocator:
            async def inner_text(self_inner):
                return "text"

        class FakeMouse:
            async def wheel(self_inner, x, y):
                return None

        class FakePage:
            url = "https://www.pinterest.com/pin/1/"
            mouse = FakeMouse()

            async def goto(self_inner, url, wait_until=None, timeout=None):
                return None

            def locator(self_inner, sel):
                return FakeLocator()

            async def content(self_inner):
                return "<html>Shop the Pin</html>"

            async def evaluate(self_inner, script):
                raise RuntimeError("execution context destroyed")

            async def query_selector_all(self_inner, sel):
                return []

        async def _no_sleep(_):
            return None

        with patch.object(stl.asyncio, "sleep", _no_sleep):
            res = asyncio.run(
                stl._extract_source_pin(FakePage(), {"pin_id": "1", "category": "fashion"}, state)
            )
        self.assertIsNotNone(res["domEvalError"])
        self.assertIn("dom_eval_failed", res["domEvalError"])
        self.assertIn("RuntimeError", res["domEvalError"])


class TestReportTrustVerdict(unittest.TestCase):
    """The report must make an untrustworthy zero impossible to read as real."""

    def _report(self, per_pin, session_health):
        with patch.object(stl, "_preflight_existing", return_value={
            "projectedInsertCount": 0, "projectedSkipExistingCount": 0,
            "conflictKeysChecked": 0, "insertCandidates": [],
        }), patch.object(stl, "_previous_spike_delta", return_value={"reportFound": False}):
            report, _ = stl._build_report(
                per_pin, {}, elapsed=1.0, apply=False,
                session_health=session_health,
                response_errors={"count": 0, "samples": []},
            )
        return report

    def test_expired_session_is_untrusted(self):
        health = {**HEALTHY, "authValid": False, "issue": "session_expired"}
        report = self._report([_pin(renderFailure=True, pageSkeleton=True)], health)
        self.assertEqual(report["dataQuality"]["resultTrust"], "untrusted:session_expired")
        self.assertFalse(report["dataQuality"]["zeroProductsIsEvidenceOfNoSupply"])
        self.assertEqual(report["sessionHealth"]["issue"], "session_expired")

    def test_unauthenticated_run_is_untrusted(self):
        health = {"sessionFileLoaded": False, "sessionPath": "/x/sess.json",
                  "cookieCount": 0, "authCookiesPresent": [], "authValid": None,
                  "authSignal": "no_conclusive_marker", "issue": "session_file_missing"}
        report = self._report([_pin(renderFailure=True, pageSkeleton=True)], health)
        self.assertEqual(report["dataQuality"]["resultTrust"], "untrusted:unauthenticated")
        self.assertFalse(report["dataQuality"]["zeroProductsIsEvidenceOfNoSupply"])

    def test_all_pins_failing_to_render_is_untrusted(self):
        per_pin = [_pin(renderFailure=True, pageSkeleton=True) for _ in range(3)]
        report = self._report(per_pin, HEALTHY)
        self.assertEqual(report["dataQuality"]["resultTrust"],
                         "untrusted:all_pins_failed_to_render")
        self.assertEqual(report["aggregate"]["renderFailureCount"], 3)

    def test_genuine_zero_on_rendered_authed_page_is_trusted(self):
        """No false positives: a real rendered, authed, empty pin stays a real zero."""
        per_pin = [_pin(visibleCardCount=8, tabCount=3, productJsonResponses=12,
                        shopModuleDetected=True) for _ in range(3)]
        report = self._report(per_pin, HEALTHY)
        self.assertEqual(report["dataQuality"]["resultTrust"], "trusted")
        self.assertTrue(report["dataQuality"]["zeroProductsIsEvidenceOfNoSupply"])
        self.assertEqual(report["aggregate"]["renderFailureCount"], 0)
        self.assertEqual(report["aggregate"]["uniqueAcceptedProducts"], 0)

    def test_partial_render_failure_is_flagged_partial(self):
        per_pin = [
            _pin(visibleCardCount=8, tabCount=3, productJsonResponses=12),
            _pin(renderFailure=True, pageSkeleton=True),
        ]
        report = self._report(per_pin, HEALTHY)
        self.assertEqual(report["dataQuality"]["resultTrust"],
                         "partial:some_pins_failed_to_render")
        self.assertEqual(report["aggregate"]["renderFailureCount"], 1)

    def test_all_pin_timeouts_are_untrusted_even_without_render_failure_flag(self):
        per_pin = [
            _pin(issue="goto_timeout:net::ERR_TUNNEL_CONNECTION_FAILED")
            for _ in range(3)
        ]
        report = self._report(per_pin, HEALTHY)
        self.assertEqual(
            report["dataQuality"]["resultTrust"],
            "untrusted:all_pins_timed_out",
        )
        self.assertEqual(report["aggregate"]["timeoutCount"], 3)
        self.assertEqual(report["aggregate"]["renderFailureCount"], 0)

    def test_one_pin_timeout_makes_the_run_partial(self):
        per_pin = [
            _pin(visibleCardCount=8, productJsonResponses=12),
            _pin(issue="goto_timeout:net::ERR_TUNNEL_CONNECTION_FAILED"),
        ]
        report = self._report(per_pin, HEALTHY)
        self.assertEqual(
            report["dataQuality"]["resultTrust"],
            "partial:some_pins_timed_out",
        )

    def test_whole_pin_timeout_is_counted_and_stage_is_preserved(self):
        per_pin = [
            _pin(visibleCardCount=8, productJsonResponses=12),
            _pin(
                issue="pin_timeout:120s",
                timeoutStage="tab_label",
                renderFailure=True,
                elapsedSec=120.01,
            ),
        ]
        report = self._report(per_pin, HEALTHY)
        self.assertEqual(report["aggregate"]["timeoutCount"], 1)
        self.assertEqual(report["aggregate"]["pinTimeoutCount"], 1)
        self.assertEqual(report["aggregate"]["pinTimeoutStages"], {"tab_label": 1})
        self.assertEqual(report["perPin"][1]["timeoutStage"], "tab_label")

    def test_unknown_auth_state_is_unverified_not_trusted(self):
        health = {**HEALTHY, "authValid": None, "authSignal": "no_conclusive_marker"}
        per_pin = [_pin(visibleCardCount=8, tabCount=3, productJsonResponses=12)]
        report = self._report(per_pin, health)
        self.assertEqual(report["dataQuality"]["resultTrust"], "unverified:auth_state_unknown")
        self.assertFalse(report["dataQuality"]["zeroProductsIsEvidenceOfNoSupply"])

    def test_response_errors_are_counted_in_report(self):
        with patch.object(stl, "_preflight_existing", return_value={
            "projectedInsertCount": 0, "projectedSkipExistingCount": 0,
            "conflictKeysChecked": 0, "insertCandidates": [],
        }), patch.object(stl, "_previous_spike_delta", return_value={"reportFound": False}):
            report, _ = stl._build_report(
                [_pin()], {}, elapsed=1.0, apply=False,
                session_health=HEALTHY,
                response_errors={"count": 7, "samples": ["ValueError:bad json"]},
            )
        self.assertEqual(report["responseErrors"]["count"], 7)
        self.assertEqual(report["responseErrors"]["samples"], ["ValueError:bad json"])

    def test_per_pin_carries_diagnostic_fields(self):
        per_pin = [_pin(visibleCardCount=4, tabCount=2, productJsonResponses=9,
                        domEvalError="dom_eval_failed:RuntimeError:x",
                        pageSkeleton=False, renderFailure=False)]
        report = self._report(per_pin, HEALTHY)
        entry = report["perPin"][0]
        self.assertEqual(entry["tabCount"], 2)
        self.assertEqual(entry["productJsonResponses"], 9)
        self.assertEqual(entry["domEvalError"], "dom_eval_failed:RuntimeError:x")
        self.assertFalse(entry["renderFailure"])
        self.assertEqual(report["aggregate"]["domEvalErrorCount"], 1)


# --------------------------------------------------------------------------
# End-to-end wiring: storage_state reaches new_context; warnings are printed
# --------------------------------------------------------------------------
class _FakeBrowser:
    def __init__(self, recorder):
        self._rec = recorder

    async def new_context(self, **kwargs):
        self._rec["context_kwargs"] = kwargs
        return _FakeContext()

    async def close(self):
        return None


class _FakeContext:
    async def new_page(self):
        return _FakeRunPage()


class _FakeRunPage:
    url = "https://www.pinterest.com/"

    def on(self, event, handler):
        return None

    async def goto(self, url, wait_until=None, timeout=None):
        return None

    async def content(self):
        return '<div data-test-id="header-profile"></div>'


class _FakeChromium:
    def __init__(self, recorder):
        self._rec = recorder

    async def launch(self, **kwargs):
        self._rec["launch_kwargs"] = kwargs
        return _FakeBrowser(self._rec)


class _FakePlaywright:
    def __init__(self, recorder):
        self.chromium = _FakeChromium(recorder)

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class TestRunWiring(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(stl.SESSION_PATH_ENV)
        self.rec: dict = {}

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(stl.SESSION_PATH_ENV, None)
        else:
            os.environ[stl.SESSION_PATH_ENV] = self._saved

    def _run(self, tmpdir):
        """Run the engine with zero source pins and a fully mocked Playwright."""
        fake_module = type("M", (), {"async_playwright": lambda: _FakePlaywright(self.rec)})
        with patch.dict(sys.modules, {"playwright.async_api": fake_module}), \
             patch.object(stl, "select_source_pins", return_value=([], {})), \
             patch.object(stl, "_load_previous_spike_ids", return_value=set()), \
             patch.object(stl, "_load_scraped_source_pin_ids", return_value=set()), \
             patch.object(stl, "_check_v28_schema", return_value=(True, [])), \
             patch.object(stl, "_preflight_existing", return_value={
                 "projectedInsertCount": 0, "projectedSkipExistingCount": 0,
                 "conflictKeysChecked": 0, "insertCandidates": [],
             }), \
             patch.object(stl, "_previous_spike_delta", return_value={"reportFound": False}), \
             patch.object(stl, "LOG_DIR", Path(tmpdir) / "logs"):
            buf = io.StringIO()
            with redirect_stdout(buf):
                report = asyncio.run(stl.run_shop_the_look_expand(
                    limit=0, category_mix={"fashion": 0}, apply=False))
            return report, buf.getvalue()

    def test_storage_state_passed_to_new_context_when_session_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ[stl.SESSION_PATH_ENV] = _write_session(tmp, [
                {"name": "_auth", "value": "SECRETA"},
                {"name": "_pinterest_sess", "value": "SECRETB"},
            ])
            report, out = self._run(tmp)

        ctx = self.rec["context_kwargs"]
        self.assertIn("storage_state", ctx)
        self.assertEqual(len(ctx["storage_state"]["cookies"]), 2)
        # Existing context options are preserved.
        self.assertEqual(ctx["locale"], "en-US")
        self.assertEqual(ctx["viewport"], {"width": 1380, "height": 1700})
        self.assertIn("user_agent", ctx)
        # Report says the session was loaded and verified.
        self.assertTrue(report["sessionHealth"]["sessionFileLoaded"])
        self.assertTrue(report["sessionHealth"]["authValid"])
        self.assertEqual(report["sessionHealth"]["authCookiesPresent"],
                         ["_auth", "_pinterest_sess"])
        # Cookie VALUES must never be printed.
        self.assertNotIn("SECRETA", out)
        self.assertNotIn("SECRETB", out)

    def test_missing_session_warns_and_continues_anonymously(self):
        with tempfile.TemporaryDirectory() as tmp:
            os.environ[stl.SESSION_PATH_ENV] = str(Path(tmp) / "absent.json")
            report, out = self._run(tmp)  # must not raise

        self.assertNotIn("storage_state", self.rec["context_kwargs"])
        self.assertIn("UNAUTHENTICATED", out)
        self.assertIn("auth-gated", out)
        self.assertFalse(report["sessionHealth"]["sessionFileLoaded"])
        self.assertEqual(report["sessionHealth"]["issue"], "session_file_missing")
        self.assertEqual(report["dataQuality"]["resultTrust"], "untrusted:unauthenticated")
        self.assertFalse(report["dataQuality"]["zeroProductsIsEvidenceOfNoSupply"])

    def test_expired_session_emits_loud_warning_and_marks_report(self):
        """The whole point: an expired session must never look like 'no products'."""
        class _ExpiredPage(_FakeRunPage):
            url = "https://www.pinterest.com/login/"

        class _ExpiredContext(_FakeContext):
            async def new_page(self):
                return _ExpiredPage()

        class _ExpiredBrowser(_FakeBrowser):
            async def new_context(self, **kwargs):
                self._rec["context_kwargs"] = kwargs
                return _ExpiredContext()

        class _ExpiredChromium(_FakeChromium):
            async def launch(self, **kwargs):
                self._rec["launch_kwargs"] = kwargs
                return _ExpiredBrowser(self._rec)

        class _ExpiredPw(_FakePlaywright):
            def __init__(self, rec):
                self.chromium = _ExpiredChromium(rec)

        with tempfile.TemporaryDirectory() as tmp:
            os.environ[stl.SESSION_PATH_ENV] = _write_session(tmp, [
                {"name": "_auth", "value": "STALE"},
                {"name": "_pinterest_sess", "value": "STALE2"},
            ])
            fake_module = type("M", (), {"async_playwright": lambda: _ExpiredPw(self.rec)})
            with patch.dict(sys.modules, {"playwright.async_api": fake_module}), \
                 patch.object(stl, "select_source_pins", return_value=([], {})), \
                 patch.object(stl, "_load_previous_spike_ids", return_value=set()), \
                 patch.object(stl, "_load_scraped_source_pin_ids", return_value=set()), \
                 patch.object(stl, "_check_v28_schema", return_value=(True, [])), \
                 patch.object(stl, "_preflight_existing", return_value={
                     "projectedInsertCount": 0, "projectedSkipExistingCount": 0,
                     "conflictKeysChecked": 0, "insertCandidates": [],
                 }), \
                 patch.object(stl, "_previous_spike_delta", return_value={"reportFound": False}), \
                 patch.object(stl, "LOG_DIR", Path(tmp) / "logs"):
                buf = io.StringIO()
                with redirect_stdout(buf):
                    report = asyncio.run(stl.run_shop_the_look_expand(
                        limit=0, category_mix={"fashion": 0}, apply=False))
                out = buf.getvalue()

        self.assertIn("SESSION EXPIRED", out)
        self.assertIn("auth-gated", out)
        self.assertEqual(report["sessionHealth"]["issue"], "session_expired")
        self.assertFalse(report["sessionHealth"]["authValid"])
        self.assertEqual(report["dataQuality"]["resultTrust"], "untrusted:session_expired")
        self.assertFalse(report["dataQuality"]["zeroProductsIsEvidenceOfNoSupply"])
        self.assertNotIn("STALE", out)


if __name__ == "__main__":
    unittest.main()
