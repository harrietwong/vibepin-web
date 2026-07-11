"""Tests for Pinterest v5 trends provider parsing and health blocker logic."""

import os
import unittest
from unittest.mock import AsyncMock, patch

from pinterest_trends_v5_provider import (
    V5FetchResult,
    _parse_v5_items,
    audit_config,
    build_v5_url,
    resolve_v5_access_token,
)
from trend_provider_health import _compute_blocker, _select_primary


class TestV5Parse(unittest.TestCase):
    def test_parse_items_shape(self):
        data = {
            "items": [
                {
                    "keyword": "boho decor",
                    "pct_growth_yoy": 150,
                    "pct_growth_wow": 5,
                    "pct_growth_mom": 20,
                    "search_volume_level": "high",
                    "time_series": [10, 20, 30, 40],
                }
            ]
        }
        rows = _parse_v5_items(data)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["keyword"], "boho decor")
        self.assertEqual(rows[0]["trend_source"], "pinterest_trends_v5")
        self.assertEqual(rows[0]["volume_score"], 3)

    def test_build_url(self):
        url = build_v5_url("US", "growing", limit=5)
        self.assertIn("/v5/trends/keywords/US/top/growing", url)
        self.assertIn("limit=5", url)


class TestHealthBlocker(unittest.TestCase):
    def test_blocker_when_no_v5_and_l1_l2_404(self):
        health = {
            "official_v5": {"enabled": True, "authPresent": False, "sampleCount": 0, "status": "unavailable_auth_or_access"},
            "internal_l1": {"enabled": True, "sampleCount": 0, "httpStatus": 404},
            "internal_l2": {"enabled": True, "sampleCount": 0, "httpStatus": 404},
            "l3_typeahead": {"enabled": True, "sampleCount": 4, "status": "ok"},
            "selectedPrimaryProvider": "l3_typeahead",
        }
        blocker, reason = _compute_blocker(health)
        self.assertTrue(blocker)
        self.assertIn("official_v5", reason or "")

    def test_no_blocker_when_v5_ok(self):
        health = {
            "official_v5": {"enabled": True, "authPresent": True, "sampleCount": 3, "status": "ok"},
            "internal_l1": {"enabled": False, "sampleCount": 0},
            "internal_l2": {"enabled": False, "sampleCount": 0},
            "l3_typeahead": {"enabled": True, "sampleCount": 0},
        }
        health["selectedPrimaryProvider"] = _select_primary(health)
        blocker, _ = _compute_blocker(health)
        self.assertFalse(blocker)

    def test_blocker_when_l1l2_disabled_no_v5_auth(self):
        """Actual production case: L1/L2 disabled (not 404), v5 has no token."""
        health = {
            "official_v5": {"enabled": True, "authPresent": False, "sampleCount": 0, "status": "unavailable_auth_or_access"},
            "internal_l1": {"enabled": False, "sampleCount": 0, "httpStatus": None},
            "internal_l2": {"enabled": False, "sampleCount": 0, "httpStatus": None},
            "l3_typeahead": {"enabled": True, "sampleCount": 4, "status": "ok"},
        }
        health["selectedPrimaryProvider"] = _select_primary(health)
        self.assertEqual(health["selectedPrimaryProvider"], "l3_typeahead")
        blocker, reason = _compute_blocker(health)
        self.assertTrue(blocker)
        self.assertIsNotNone(reason)

    def test_l3_does_not_clear_blocker(self):
        """L3 sampleCount > 0 must not make blocker=False when v5 is unauthorized."""
        health = {
            "official_v5": {"enabled": True, "authPresent": False, "sampleCount": 0, "status": "unavailable_auth_or_access"},
            "internal_l1": {"enabled": False, "sampleCount": 0, "httpStatus": None},
            "internal_l2": {"enabled": False, "sampleCount": 0, "httpStatus": None},
            "l3_typeahead": {"enabled": True, "sampleCount": 50, "status": "ok"},
        }
        health["selectedPrimaryProvider"] = _select_primary(health)
        blocker, _ = _compute_blocker(health)
        self.assertTrue(blocker, "L3 having samples must not resolve provider blocker")


class TestTokenResolution(unittest.TestCase):
    def _resolve_with_token(self, value: str) -> tuple:
        with patch.dict(os.environ, {"PINTEREST_TRENDS_ACCESS_TOKEN": value}, clear=False):
            return resolve_v5_access_token()

    def test_placeholder_token_rejected(self):
        for bad in ("placeholder", "changeme", "your-token"):
            token, _ = self._resolve_with_token(bad)
            self.assertIsNone(token, f"Placeholder token {bad!r} must not be treated as valid")

    def test_real_token_accepted(self):
        token, source = self._resolve_with_token("pina_real_abc123")
        self.assertEqual(token, "pina_real_abc123")
        self.assertIn("PINTEREST_TRENDS_ACCESS_TOKEN", source)

    def test_empty_token_rejected(self):
        token, _ = self._resolve_with_token("")
        self.assertIsNone(token)


class TestJobStatusLogic(unittest.TestCase):
    def _compute_job_status(self, seeds_scored: int, queue_written: int, blocker: bool, allow_degraded: bool = False, authoritative_scored: int = 0, l3_count: int = 0) -> str:
        """Mirror the job-status logic from pipeline.step_trends."""
        if blocker:
            return "blocked_provider"
        if seeds_scored == 0 and queue_written == 0:
            return "no_usable_seeds"
        if authoritative_scored == 0 and l3_count > 0 and allow_degraded:
            return "degraded_fallback"
        return "successful"

    def test_no_usable_seeds_when_zero_scored_and_zero_queue(self):
        status = self._compute_job_status(seeds_scored=0, queue_written=0, blocker=False)
        self.assertEqual(status, "no_usable_seeds")

    def test_blocked_provider_takes_priority_over_no_seeds(self):
        status = self._compute_job_status(seeds_scored=0, queue_written=0, blocker=True)
        self.assertEqual(status, "blocked_provider")

    def test_successful_when_seeds_and_queue(self):
        status = self._compute_job_status(seeds_scored=5, queue_written=3, blocker=False, authoritative_scored=5)
        self.assertEqual(status, "successful")

    def test_degraded_fallback_when_l3_writes_allowed(self):
        status = self._compute_job_status(seeds_scored=4, queue_written=2, blocker=False, allow_degraded=True, authoritative_scored=0, l3_count=4)
        self.assertEqual(status, "degraded_fallback")


class TestCleanupScriptStructure(unittest.TestCase):
    def test_cleanup_imports_request_not_get_http(self):
        """Cleanup script must import _request (retry-safe), not _get_http (direct)."""
        import ast
        import pathlib
        src = pathlib.Path(__file__).parent.parent / "scripts" / "cleanup_e2e_fixture_seeds.py"
        tree = ast.parse(src.read_text(encoding="utf-8"))
        imported_names: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module == "db":
                for alias in node.names:
                    imported_names.add(alias.name)
        self.assertIn("_request", imported_names, "cleanup script must import _request from db")
        self.assertNotIn("_get_http", imported_names, "cleanup script must not import _get_http directly")


if __name__ == "__main__":
    unittest.main()
