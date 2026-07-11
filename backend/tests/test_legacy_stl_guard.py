"""Tests for the retired legacy STL pin_products writer guard.

Covers:
  * shop_the_look._legacy_db_write_allowed (flag + env opt-in)
  * pipeline._legacy_stl_writer_allowed     (flag + env opt-in)
  * pipeline.step_stl skip-safety: a real run without opt-in never launches the
    subprocess; dry-run is unaffected; with opt-in the child --db opt-in is passed.

None of these tests run Playwright or write the database.
"""

import argparse
import os
import unittest
from unittest.mock import patch

import pipeline

try:
    import shop_the_look  # noqa: E402 — imports playwright at module top
    _HAVE_STL = True
except Exception:  # pragma: no cover - environment without playwright
    shop_the_look = None  # type: ignore
    _HAVE_STL = False


def _clean_env():
    """Return a patch.dict context that removes both legacy opt-in env vars."""
    env = dict(os.environ)
    env.pop("VIBEPIN_ALLOW_LEGACY_STL_DB", None)
    env.pop("VIBEPIN_ALLOW_LEGACY_STL", None)
    return patch.dict(os.environ, env, clear=True)


@unittest.skipUnless(_HAVE_STL, "shop_the_look (playwright) not importable")
class TestShopTheLookDbGuard(unittest.TestCase):
    def test_db_without_allow_refuses(self):
        args = argparse.Namespace(db=True, allow_legacy_db_write=False)
        with _clean_env():
            self.assertFalse(shop_the_look._legacy_db_write_allowed(args))

    def test_db_with_flag_allows(self):
        args = argparse.Namespace(db=True, allow_legacy_db_write=True)
        with _clean_env():
            self.assertTrue(shop_the_look._legacy_db_write_allowed(args))

    def test_db_with_env_allows(self):
        args = argparse.Namespace(db=True, allow_legacy_db_write=False)
        with _clean_env():
            os.environ["VIBEPIN_ALLOW_LEGACY_STL_DB"] = "1"
            self.assertTrue(shop_the_look._legacy_db_write_allowed(args))

    def test_missing_attr_is_safe(self):
        # An args object that never defined the flag must not crash; defaults off.
        args = argparse.Namespace(db=True)
        with _clean_env():
            self.assertFalse(shop_the_look._legacy_db_write_allowed(args))


class TestPipelineStlWriterGate(unittest.TestCase):
    def test_default_refuses(self):
        with _clean_env():
            self.assertFalse(pipeline._legacy_stl_writer_allowed(False))

    def test_flag_allows(self):
        with _clean_env():
            self.assertTrue(pipeline._legacy_stl_writer_allowed(True))

    def test_env_allows(self):
        with _clean_env():
            os.environ["VIBEPIN_ALLOW_LEGACY_STL"] = "1"
            self.assertTrue(pipeline._legacy_stl_writer_allowed(False))


class TestStepStlSkipSafe(unittest.IsolatedAsyncioTestCase):
    async def test_real_run_without_optin_skips_without_subprocess(self):
        with _clean_env(), patch("subprocess.run") as run:
            rc = await pipeline.step_stl(limit=300, dry_run=False)
        self.assertEqual(rc, 0)
        run.assert_not_called()  # no Pinterest, no DB write

    async def test_dry_run_is_not_blocked(self):
        class _Fake:
            returncode = 0
            stdout = ""
        with _clean_env(), patch("subprocess.run", return_value=_Fake()) as run:
            rc = await pipeline.step_stl(limit=10, dry_run=True)
        self.assertEqual(rc, 0)
        run.assert_called_once()
        cmd = run.call_args.args[0]
        self.assertIn("--dry-run", cmd)
        self.assertNotIn("--db", cmd)  # dry-run never writes

    async def test_optin_passes_child_allow_flag(self):
        class _Fake:
            returncode = 0
            stdout = ""
        with _clean_env(), patch("subprocess.run", return_value=_Fake()) as run:
            rc = await pipeline.step_stl(limit=10, dry_run=False, allow_legacy=True)
        self.assertEqual(rc, 0)
        run.assert_called_once()
        cmd = run.call_args.args[0]
        self.assertIn("--db", cmd)
        self.assertIn("--allow-legacy-db-write", cmd)  # both guard layers agree


if __name__ == "__main__":
    unittest.main()
