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
from trend_provider_health import (
    _compute_blocker,
    _probe_transient,
    _select_primary,
    summarize_actual_run,
)


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


class TestBlockerUsesActualRunNotProbe(unittest.TestCase):
    """2026-08-10 regression: the trailing limit=5 probe ate an HTTP 429 while the
    run itself had already pulled 1932 official_v5 keywords (53 after filters) and
    ZERO L3. The job died claiming "only L3 typeahead available — estimated data".

    The red line (never serve L3 estimates as authoritative trends) must survive
    every change here: it is only the *evidence* the blocker reads that moves, from
    "did one small probe request succeed" to "what did the run actually produce".
    """

    def _health_probe_rate_limited(self) -> dict:
        """Verbatim shape of the 2026-08-10 01:04Z providerHealth block."""
        health = {
            "official_v5": {
                "enabled": True,
                "authPresent": True,
                "sampleCount": 0,
                "status": "http_error",
                "httpStatus": 429,
                "error": "HTTP 429",
                "usableSeedCount": 0,
            },
            "internal_l1": {"enabled": False, "sampleCount": 0, "httpStatus": None},
            "internal_l2": {"enabled": False, "sampleCount": 0, "httpStatus": None},
            "l3_typeahead": {"enabled": True, "sampleCount": 4, "status": "ok"},
        }
        health["selectedPrimaryProvider"] = _select_primary(health)
        return health

    def test_rate_limited_probe_with_official_seeds_does_not_block(self):
        """Case 1: probe 429 (sampleCount=0) + run got 53 official seeds -> NO blocker."""
        health = self._health_probe_rate_limited()
        self.assertEqual(health["selectedPrimaryProvider"], "l3_typeahead")

        actual_run = summarize_actual_run(
            provider_run_summary={
                "official_v5_count": 1932,
                "l1_count": 0,
                "l2_count": 0,
                "l3_count": 0,
                "primary_provider": "official_v5",
                "blocker": False,
                "blocker_reason": None,
            },
            authoritative_scored=53,
            source_counts={"official_v5": 53, "L1": 0, "L2": 0, "L3": 0},
        )
        blocker, reason = _compute_blocker(health, actual_run)
        self.assertFalse(blocker, "official seeds actually landed; a throttled probe must not fail the job")
        self.assertIsNone(reason)

    def test_rate_limited_probe_with_only_l3_still_blocks(self):
        """Case 2: probe 429 + run produced ONLY L3 -> blocker. Red line held."""
        health = self._health_probe_rate_limited()
        actual_run = summarize_actual_run(
            provider_run_summary={
                "official_v5_count": 0,
                "l1_count": 0,
                "l2_count": 0,
                "l3_count": 40,
                "primary_provider": "l3_typeahead",
                "blocker": False,
            },
            authoritative_scored=0,
            source_counts={"L3": 40},
        )
        blocker, reason = _compute_blocker(health, actual_run)
        self.assertTrue(blocker, "L3-only output must never be served as authoritative trends")
        self.assertIn("0 official seeds", reason or "")
        self.assertIn("L3", reason or "")

    def test_healthy_probe_still_does_not_block(self):
        """Case 3: probe healthy -> unchanged behaviour, with or without run data."""
        health = {
            "official_v5": {"enabled": True, "authPresent": True, "sampleCount": 3, "status": "ok"},
            "internal_l1": {"enabled": False, "sampleCount": 0},
            "internal_l2": {"enabled": False, "sampleCount": 0},
            "l3_typeahead": {"enabled": True, "sampleCount": 0},
        }
        health["selectedPrimaryProvider"] = _select_primary(health)
        self.assertFalse(_compute_blocker(health)[0])

        actual_run = summarize_actual_run(
            provider_run_summary={"official_v5_count": 800, "primary_provider": "official_v5"},
            authoritative_scored=20,
            source_counts={"official_v5": 20},
        )
        self.assertFalse(_compute_blocker(health, actual_run)[0])

    def test_access_denied_blocks_even_with_official_seeds_fetched(self):
        """Case 4a: 401/403 during the real run -> blocker, and it outranks seed counts."""
        health = self._health_probe_rate_limited()
        actual_run = summarize_actual_run(
            provider_run_summary={
                "official_v5_count": 84,
                "primary_provider": "official_v5",
                "blocker": True,
                "blocker_reason": "HTTP 401 — Trends API access denied or token invalid",
            },
            authoritative_scored=12,
            source_counts={"official_v5": 12},
        )
        blocker, reason = _compute_blocker(health, actual_run)
        self.assertTrue(blocker, "an access-denied run must block regardless of partial seeds")
        self.assertIn("access denied", (reason or "").lower())

    def test_probe_401_with_no_run_output_still_blocks(self):
        """Case 4b: probe says 401 (permanent) and the run produced nothing -> blocker."""
        health = {
            "official_v5": {
                "enabled": True,
                "authPresent": True,
                "sampleCount": 0,
                "status": "unavailable_auth_or_access",
                "httpStatus": 401,
                "error": "HTTP 401 — Trends API access denied or token invalid",
            },
            "internal_l1": {"enabled": False, "sampleCount": 0, "httpStatus": None},
            "internal_l2": {"enabled": False, "sampleCount": 0, "httpStatus": None},
            "l3_typeahead": {"enabled": True, "sampleCount": 4, "status": "ok"},
        }
        health["selectedPrimaryProvider"] = _select_primary(health)
        empty_run = summarize_actual_run(
            provider_run_summary={"official_v5_count": 0, "l3_count": 0, "primary_provider": None},
            authoritative_scored=0,
            source_counts={},
        )
        blocker, reason = _compute_blocker(health, empty_run)
        self.assertTrue(blocker)
        self.assertIsNotNone(reason)

    def test_probe_404_is_permanent_not_transient(self):
        """404 on the v5 endpoint is not something a retry fixes -> stays a hard blocker."""
        health = {
            "official_v5": {
                "enabled": True,
                "authPresent": True,
                "sampleCount": 0,
                "status": "http_error",
                "httpStatus": 404,
                "error": "HTTP 404",
            },
            "internal_l1": {"enabled": False, "sampleCount": 0, "httpStatus": None},
            "internal_l2": {"enabled": False, "sampleCount": 0, "httpStatus": None},
            "l3_typeahead": {"enabled": True, "sampleCount": 4, "status": "ok"},
        }
        health["selectedPrimaryProvider"] = _select_primary(health)
        self.assertFalse(_probe_transient(health["official_v5"]))
        blocker, reason = _compute_blocker(health)
        self.assertTrue(blocker)
        self.assertNotIn("transient", (reason or "").lower())

    def test_empty_run_falls_back_to_probe_verdict(self):
        """No layer produced anything: fall through to the probe, but the 429 reason
        must not claim official_v5 is unavailable — it says the probe couldn't tell."""
        health = self._health_probe_rate_limited()
        empty_run = summarize_actual_run(
            provider_run_summary={"official_v5_count": 0, "l3_count": 0, "primary_provider": None},
            authoritative_scored=0,
            source_counts={},
        )
        blocker, reason = _compute_blocker(health, empty_run)
        self.assertTrue(blocker, "no official evidence at all must still block")
        self.assertIn("transient", (reason or "").lower())

    def test_probe_only_call_signature_unchanged(self):
        """Standalone --job trend-provider-health passes no run data; verdict unchanged."""
        health = self._health_probe_rate_limited()
        blocker, reason = _compute_blocker(health)
        self.assertTrue(blocker)
        self.assertIsNotNone(reason)

    def test_transient_classification(self):
        self.assertTrue(_probe_transient({"enabled": True, "status": "http_error", "httpStatus": 429}))
        self.assertTrue(_probe_transient({"enabled": True, "status": "http_error", "httpStatus": 503}))
        self.assertFalse(_probe_transient({"enabled": True, "status": "unavailable_auth_or_access", "httpStatus": 401}))
        self.assertFalse(_probe_transient({"enabled": True, "status": "unavailable_auth_or_access", "httpStatus": 403}))
        self.assertFalse(_probe_transient({"enabled": True, "status": "http_error", "httpStatus": 404}))
        self.assertFalse(_probe_transient({"enabled": False, "status": "disabled"}))
        self.assertFalse(_probe_transient({"enabled": True, "status": "ok", "httpStatus": 200}))

    def test_summarize_prefers_post_filter_official_count(self):
        """officialSeedsScored is the post-filter count; fetched is kept only for reporting."""
        s = summarize_actual_run(
            provider_run_summary={"official_v5_count": 1932, "l1_count": 5, "l2_count": 2, "l3_count": 0},
            authoritative_scored=53,
            source_counts={"L3": 0},
        )
        self.assertEqual(s["officialSeedsScored"], 53)
        self.assertEqual(s["officialSeedsFetched"], 1939)
        self.assertEqual(s["l3SeedsScored"], 0)

    def test_all_official_fetched_but_none_survived_filters_with_l3_blocks(self):
        """Mixed edge case fails safe: 1932 official fetched, 0 scored, L3 rows present."""
        health = self._health_probe_rate_limited()
        actual_run = summarize_actual_run(
            provider_run_summary={
                "official_v5_count": 1932,
                "l3_count": 12,
                "primary_provider": "official_v5",
            },
            authoritative_scored=0,
            source_counts={"L3": 12},
        )
        blocker, reason = _compute_blocker(health, actual_run)
        self.assertTrue(blocker, "if only L3 survived filters, the red line still applies")
        self.assertIn("0 official seeds", reason or "")


class TestProviderHealthReportsDecisionPath(unittest.TestCase):
    """A failure (or a rescued run) must be readable from the report."""

    def _run(self, actual_run):
        import asyncio
        import trend_provider_health as tph

        async def fake_v5(region="US"):
            return {
                "enabled": True,
                "authPresent": True,
                "sampleCount": 0,
                "status": "http_error",
                "httpStatus": 429,
                "error": "HTTP 429",
                "usableSeedCount": 0,
                "transient": True,
                "transientKind": "rate_limited",
            }

        async def fake_off(region="US"):
            return {"enabled": False, "status": "disabled", "sampleCount": 0, "httpStatus": None}

        async def fake_l3(region="US"):
            return {"enabled": True, "status": "ok", "sampleCount": 4, "httpStatus": None}

        with patch.object(tph, "probe_official_v5", fake_v5), \
             patch.object(tph, "probe_internal_l1", fake_off), \
             patch.object(tph, "probe_internal_l2", fake_off), \
             patch.object(tph, "probe_l3_typeahead", fake_l3), \
             patch.object(tph, "audit_config", lambda: {"enabled": True, "authPresent": True}), \
             patch.object(tph, "resolve_v5_access_token", lambda: (None, "test")):
            return asyncio.run(tph.run_provider_health(region="US", actual_run=actual_run))

    def test_override_path_is_visible_and_names_the_real_source(self):
        health = self._run(summarize_actual_run(
            provider_run_summary={"official_v5_count": 1932, "primary_provider": "official_v5"},
            authoritative_scored=53,
            source_counts={"L3": 0},
        ))
        self.assertFalse(health["blocker"])
        self.assertEqual(health["blockerDecisionBasis"], "actual_run")
        self.assertEqual(health["probePrimaryProvider"], "l3_typeahead")
        self.assertEqual(health["selectedPrimaryProvider"], "official_v5")
        self.assertTrue(health["probeTransientFailure"])
        self.assertIn("53 official seeds", health["probeOverride"])

    def test_blocked_path_is_visible_and_has_no_override(self):
        health = self._run(summarize_actual_run(
            provider_run_summary={"official_v5_count": 0, "l3_count": 40, "primary_provider": "l3_typeahead"},
            authoritative_scored=0,
            source_counts={"L3": 40},
        ))
        self.assertTrue(health["blocker"])
        self.assertEqual(health["blockerDecisionBasis"], "actual_run")
        self.assertEqual(health["selectedPrimaryProvider"], "l3_typeahead")
        self.assertIsNone(health.get("probeOverride"))
        self.assertIn("0 official seeds", health["blockerReason"])

    def test_probe_only_path_labelled_probe(self):
        health = self._run(None)
        self.assertTrue(health["blocker"])
        self.assertEqual(health["blockerDecisionBasis"], "probe")
        self.assertEqual(health["selectedPrimaryProvider"], "l3_typeahead")
        self.assertNotIn("actualRun", health)


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
