"""Tests for the pin-crawl residential-proxy-from-env wiring.

Covers:
  * _resolve_crawl_proxy: explicit arg wins; PINTEREST_CRAWL_PROXY_URL env fallback;
    None when neither; blank/whitespace env treated as None (unchanged behaviour).
  * step_crawl resolves the proxy and forwards it to PinterestSession.
  * the proxy VALUE is never logged (only presence is).
  * readiness reports PINTEREST_CRAWL_PROXY_URL by name and gates pin-crawl on it.

No network, no crawl, no DB writes, no secrets. Pure logic + source-contract checks.
"""
import os
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
import pipeline  # noqa: E402  (module load is stdlib-only at top level)

ENV = "PINTEREST_CRAWL_PROXY_URL"
PIPELINE_SRC = (BACKEND / "pipeline.py").read_text(encoding="utf-8")
READINESS_SRC = (BACKEND / "scripts" / "cloud_pipeline_readiness_check.py").read_text(encoding="utf-8")


class TestResolveCrawlProxy(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(ENV)
        os.environ.pop(ENV, None)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(ENV, None)
        else:
            os.environ[ENV] = self._saved

    def test_explicit_wins_over_env(self):
        os.environ[ENV] = "http://env-proxy:8080"
        self.assertEqual(pipeline._resolve_crawl_proxy("http://explicit:9999"),
                         "http://explicit:9999")

    def test_env_fallback_when_no_explicit(self):
        os.environ[ENV] = "http://res-proxy:7000"
        self.assertEqual(pipeline._resolve_crawl_proxy(None), "http://res-proxy:7000")

    def test_none_when_neither(self):
        self.assertIsNone(pipeline._resolve_crawl_proxy(None),
                          "no explicit + no env must stay proxy-less (unchanged behaviour)")

    def test_blank_env_is_none(self):
        os.environ[ENV] = "   "
        self.assertIsNone(pipeline._resolve_crawl_proxy(None),
                          "blank/whitespace env must be treated as unset")


class TestStepCrawlWiringContract(unittest.TestCase):
    def test_step_crawl_resolves_and_forwards_proxy(self):
        # step_crawl resolves the proxy via the helper and forwards it to the session.
        body = PIPELINE_SRC.split("async def step_crawl")[1]
        self.assertIn("_resolve_crawl_proxy(proxy)", body)
        self.assertIn("PinterestSession(proxy=proxy", body)

    def test_proxy_value_not_logged(self):
        # presence is logged ('configured'/'none'); the URL is never interpolated.
        self.assertIn("proxy={'configured' if proxy else 'none (direct)'}", PIPELINE_SRC)
        # no log/print call interpolates the raw proxy value.
        for bad in ("_info(f\"[crawl] proxy={proxy}", "print(proxy", "_info(proxy"):
            self.assertNotIn(bad, PIPELINE_SRC)

    def test_env_name_is_single_canonical(self):
        self.assertIn('CRAWL_PROXY_ENV = "PINTEREST_CRAWL_PROXY_URL"', PIPELINE_SRC)


class TestReadinessProxyGate(unittest.TestCase):
    def test_readiness_reports_and_gates_proxy(self):
        self.assertIn("PINTEREST_CRAWL_PROXY_URL", READINESS_SRC)
        self.assertIn("BLOCKED_PROXY_MISSING", READINESS_SRC)
        self.assertIn("proxy_present", READINESS_SRC)
        # pin-crawl readiness must depend on proxy presence.
        self.assertIn('if job == "pin-crawl":', READINESS_SRC)
        self.assertIn("ready = ready and proxy_present", READINESS_SRC)

    def test_readiness_compiles(self):
        import py_compile
        py_compile.compile(str(BACKEND / "scripts" / "cloud_pipeline_readiness_check.py"), doraise=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
