import datetime as dt
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from scripts import preflight_product_supply as preflight


class TestMeasuredProductSupplyCooldown(unittest.TestCase):
    NOW = dt.datetime(2026, 8, 26, 6, 0, tzinfo=dt.timezone.utc)

    def write_log(self, directory: Path, name: str, body: str, minutes_ago: int) -> Path:
        path = directory / name
        path.write_text(body, encoding="utf-8")
        modified = (self.NOW - dt.timedelta(minutes=minutes_ago)).timestamp()
        os.utime(path, (modified, modified))
        return path

    def state(self, directory: Path) -> dict:
        with patch.object(preflight, "LOG_DIRS", [directory]):
            return preflight.cooldown_state(120, now=self.NOW)

    def test_completed_activity_older_than_120_minutes_is_safe(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            activity = self.write_log(
                directory,
                "cloud_run_dry-run_20260826_030000Z.log",
                "[runner] launch: python run_worker.py --job product-supply\n",
                121,
            )
            state = self.state(directory)
            self.assertTrue(state["known"])
            self.assertTrue(state["satisfied"])
            self.assertEqual(state["evidenceLog"], str(activity))

    def test_recent_completed_activity_remains_blocked(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            self.write_log(
                directory,
                "cloud_run_pin_crawl_20260826_050000Z.log",
                "CRAWL: run_worker --job crawl\n",
                119,
            )
            state = self.state(directory)
            self.assertTrue(state["known"])
            self.assertFalse(state["satisfied"])
            self.assertEqual(state["elapsedMinutes"], 119.0)

    def test_failed_apply_before_worker_launch_does_not_reset_clock(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            older = self.write_log(
                directory,
                "cloud_run_apply_20260826_030000Z.log",
                "[runner] launch: python run_worker.py --job product-supply\n",
                125,
            )
            self.write_log(
                directory,
                "cloud_run_apply_20260826_055900Z.log",
                "[runner] STOP — apply requires SAFE_FOR_APPLY\n",
                1,
            )
            state = self.state(directory)
            self.assertTrue(state["satisfied"])
            self.assertEqual(state["evidenceLog"], str(older))

    def test_preflight_only_logs_are_not_activity(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            self.write_log(
                directory,
                "cloud_run_preflight_20260826_030000Z.log",
                "preflight-only mode: safe\n",
                180,
            )
            self.assertEqual(
                self.state(directory),
                {
                    "known": False,
                    "satisfied": False,
                    "requiredMinutes": 120,
                    "reason": "no trustworthy completed Pinterest activity log",
                },
            )

    def test_latest_real_activity_wins_across_job_types(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            self.write_log(
                directory,
                "cloud_run_keyword_trends_20260826_030000Z.log",
                "TRENDS: run_worker --job trends\n",
                180,
            )
            latest = self.write_log(
                directory,
                "cloud_run_apply_20260826_040000Z.log",
                "[runner] launch: python run_worker.py --job product-supply\n",
                90,
            )
            state = self.state(directory)
            self.assertFalse(state["satisfied"])
            self.assertEqual(state["evidenceLog"], str(latest))


if __name__ == "__main__":
    unittest.main()
