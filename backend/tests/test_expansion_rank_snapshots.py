"""Phase-3 tests: keyword_expansions.rank writer + pin_save_snapshots writer.

Fully OFFLINE — the db.upsert boundary is mocked; no Supabase, no Pinterest.
"""

import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import scraper_v2

sys.path.insert(0, str(Path(scraper_v2.ROOT) / "db"))
import db as db_mod  # noqa: E402


class TestExpansionRank(unittest.TestCase):
    def test_rank_is_one_based_dropdown_position(self):
        calls = []

        def _upsert(table, rows, on_conflict=""):
            calls.append((table, rows, on_conflict))
            return rows

        with patch.object(db_mod, "upsert", side_effect=_upsert):
            n = scraper_v2.upsert_keyword_expansions(
                "digital planner", ["digital planner template", "digital planner", "digital planner goodnotes"],
            )
        self.assertEqual(n, 2)
        table, rows, oc = calls[0]
        self.assertEqual(table, "keyword_expansions")
        self.assertEqual(oc, "seed_keyword,expanded_keyword")
        # Seed itself skipped; rank follows the DROPDOWN position of kept rows.
        self.assertEqual([(r["expanded_keyword"], r["rank"]) for r in rows],
                         [("digital planner template", 1), ("digital planner goodnotes", 2)])

    def test_pre_v36_schema_falls_back_without_rank(self):
        calls = []

        def _upsert(table, rows, on_conflict=""):
            calls.append([dict(r) for r in rows])
            if any("rank" in r for r in rows):
                raise RuntimeError('column keyword_expansions.rank does not exist (42703, "rank")')
            return rows

        with patch.object(db_mod, "upsert", side_effect=_upsert):
            n = scraper_v2.upsert_keyword_expansions("seed kw", ["a", "b"])
        self.assertEqual(n, 2)
        self.assertEqual(len(calls), 2)                    # first try + rank-less retry
        self.assertTrue(all("rank" not in r for r in calls[1]))
        self.assertEqual([r["expanded_keyword"] for r in calls[1]], ["a", "b"])


class TestSaveSnapshots(unittest.TestCase):
    def test_one_snapshot_per_pin_per_day_deduped(self):
        calls = []

        def _upsert(table, rows, on_conflict=""):
            calls.append((table, rows, on_conflict))
            return rows

        records = [
            {"pin_id": "p1", "save_count": 100, "reaction_count": 5},
            {"pin_id": "p1", "save_count": 100, "reaction_count": 5},   # dup in-batch
            {"pin_id": "p2", "save_count": 0},
            {"pin_id": "",   "save_count": 9},                          # no pin_id → skipped
        ]
        with patch.object(db_mod, "upsert", side_effect=_upsert):
            n = scraper_v2.record_save_snapshots(records)
        self.assertEqual(n, 2)
        table, rows, oc = calls[0]
        self.assertEqual(table, "pin_save_snapshots")
        self.assertEqual(oc, "pin_id,captured_on")
        self.assertEqual([r["pin_id"] for r in rows], ["p1", "p2"])
        # A real measured 0 is preserved; captured_on is a UTC date string.
        self.assertEqual(rows[1]["save_count"], 0)
        self.assertRegex(rows[0]["captured_on"], r"^\d{4}-\d{2}-\d{2}$")

    def test_missing_table_is_non_fatal(self):
        def _upsert(table, rows, on_conflict=""):
            raise RuntimeError('relation "pin_save_snapshots" does not exist')

        with patch.object(db_mod, "upsert", side_effect=_upsert):
            n = scraper_v2.record_save_snapshots([{"pin_id": "p1", "save_count": 1}])
        self.assertEqual(n, 0)  # returns 0, never raises → crawl unaffected


if __name__ == "__main__":
    unittest.main()
