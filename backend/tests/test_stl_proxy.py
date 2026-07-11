"""Tests for Shop-the-Look (Product-Supply) Playwright proxy-from-env wiring.

Covers _stl_proxy_option():
  * parses PINTEREST_CRAWL_PROXY_URL into Playwright {server, username, password}
  * percent-encoded credentials are unquoted
  * no credentials in URL -> server only
  * unset/blank env -> None (direct, unchanged behaviour)
  * credentials never leak into the `server` field

No network, no Playwright launch, no DB writes, no secrets. Run on the VPS where
db/product_harvest import cleanly.
"""
import os
import sys
import unittest
from pathlib import Path

BACKEND = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(BACKEND / "db"))
import shop_the_look_expand as stl  # noqa: E402

ENV = "PINTEREST_CRAWL_PROXY_URL"


class TestStlProxyOption(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.get(ENV)
        os.environ.pop(ENV, None)

    def tearDown(self):
        if self._saved is None:
            os.environ.pop(ENV, None)
        else:
            os.environ[ENV] = self._saved

    def test_full_url_with_credentials(self):
        os.environ[ENV] = "http://user:pass@proxyhost:3128"
        opt = stl._stl_proxy_option()
        self.assertEqual(opt, {"server": "http://proxyhost:3128",
                               "username": "user", "password": "pass"})

    def test_percent_encoded_credentials_unquoted(self):
        os.environ[ENV] = "http://u%40s:p%3Aw@proxyhost:8080"
        opt = stl._stl_proxy_option()
        self.assertEqual(opt["username"], "u@s")
        self.assertEqual(opt["password"], "p:w")
        self.assertEqual(opt["server"], "http://proxyhost:8080")

    def test_no_credentials_server_only(self):
        os.environ[ENV] = "http://proxyhost:3128"
        opt = stl._stl_proxy_option()
        self.assertEqual(opt, {"server": "http://proxyhost:3128"})

    def test_unset_is_none(self):
        self.assertIsNone(stl._stl_proxy_option())

    def test_blank_is_none(self):
        os.environ[ENV] = "   "
        self.assertIsNone(stl._stl_proxy_option())

    def test_credentials_never_in_server_field(self):
        os.environ[ENV] = "http://secretuser:secretpass@proxyhost:3128"
        opt = stl._stl_proxy_option()
        self.assertNotIn("secretuser", opt["server"])
        self.assertNotIn("secretpass", opt["server"])
        self.assertNotIn("@", opt["server"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
