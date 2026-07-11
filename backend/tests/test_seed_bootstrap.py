"""Tests for the manual/CSV seed bootstrap path (seed_bootstrap.py)."""

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import seed_bootstrap
from seed_bootstrap import (
    parse_seed_csv,
    run_bootstrap,
    score_seed_rows,
)
from seed_report import build_source_separation, classify_source_bucket

# Columns: keyword,category,region,source,trend_type,search_volume,
#          weekly_growth,monthly_growth,yearly_growth,curator_priority,curator_note,
#          seasonality_hint,commercial_intent_hint,product_potential_hint,reference_potential_hint
HEADER = (
    "keyword,category,region,source,trend_type,search_volume,"
    "weekly_growth,monthly_growth,yearly_growth,curator_priority,curator_note,"
    "seasonality_hint,commercial_intent_hint,product_potential_hint,reference_potential_hint"
)


def _row(keyword, category, *, source="manual_bootstrap", trend_type="evergreen",
         search_volume="", weekly="", monthly="", yearly="",
         curator_priority="", curator_note="", seasonality="",
         commercial="", product="", reference=""):
    return ",".join([
        keyword, category, "US", source, trend_type, str(search_volume),
        str(weekly), str(monthly), str(yearly), curator_priority, curator_note,
        seasonality, commercial, product, reference,
    ])


def _csv(*rows: str) -> str:
    return "\n".join([HEADER, *rows]) + "\n"


class TestCsvParsing(unittest.TestCase):
    def test_parses_valid_rows(self):
        text = _csv(
            _row("boho living room decor ideas", "home-decor", search_volume="12000"),
            _row("clean girl makeup look", "beauty"),
        )
        valid, invalid = parse_seed_csv(text)
        self.assertEqual(len(valid), 2)
        self.assertEqual(len(invalid), 0)
        self.assertEqual(valid[0]["numeric_search_volume"], 12000.0)
        self.assertEqual(valid[0]["volume_score"], 3)  # 12000 → bin 3
        self.assertIsNone(valid[1]["numeric_search_volume"])
        self.assertEqual(valid[1]["volume_score"], 0)

    def test_non_numeric_search_volume_ignored(self):
        text = _csv(_row("quiet luxury outfit ideas", "fashion", search_volume="high"))
        valid, _ = parse_seed_csv(text)
        self.assertIsNone(valid[0]["numeric_search_volume"])
        self.assertEqual(valid[0]["volume_score"], 0)
        self.assertTrue(any("non-numeric search_volume" in w for w in valid[0]["warnings"]))

    def test_tolerates_unknown_columns(self):
        header = HEADER + ",bogus_col"
        text = "\n".join([
            header,
            _row("quiet luxury outfit ideas", "fashion") + ",junk",
        ]) + "\n"
        valid, _ = parse_seed_csv(text)
        self.assertEqual(len(valid), 1)
        self.assertTrue(any("unknown columns" in w for w in valid[0]["warnings"]))


class TestInvalidRows(unittest.TestCase):
    def test_missing_keyword_and_category(self):
        text = _csv(
            _row("", "home-decor"),
            _row("some keyword", ""),
        )
        valid, invalid = parse_seed_csv(text)
        self.assertEqual(len(valid), 0)
        self.assertEqual(len(invalid), 2)
        self.assertIn("missing keyword", invalid[0]["reasons"])
        self.assertIn("missing category", invalid[1]["reasons"])


class TestCategoryNormalization(unittest.TestCase):
    def test_normalizes_legacy_category(self):
        text = _csv(_row("cozy reading nook ideas", "home_decor"))
        valid, _ = parse_seed_csv(text)
        self.assertEqual(valid[0]["normalized_category"], "home-decor")


class TestScoringIntegration(unittest.TestCase):
    def test_blank_metrics_curated_seed_is_queue_eligible(self):
        text = _csv(_row("entryway decor ideas", "home-decor"))
        valid, _ = parse_seed_csv(text)
        seeds, _ = score_seed_rows(valid)
        s = seeds[0]
        self.assertGreaterEqual(s.trend_seed_score, 22.0)  # human-approval crawl floor
        self.assertLessEqual(s.trend_seed_score, 100.0)
        self.assertTrue(s.crawl_queue_eligible)
        self.assertIn(s.crawl_priority, ("low", "medium", "high"))

    def test_numeric_volume_raises_score(self):
        blank = _csv(_row("plain entryway shelf", "home-decor"))
        highv = _csv(_row("plain entryway shelf", "home-decor", search_volume="60000"))
        s_blank = score_seed_rows(parse_seed_csv(blank)[0])[0][0]
        s_high = score_seed_rows(parse_seed_csv(highv)[0])[0][0]
        self.assertGreater(s_high.trend_seed_score, s_blank.trend_seed_score)

    def test_curator_priority_high_sets_every_3_days(self):
        text = _csv(_row("entryway decor ideas", "home-decor", curator_priority="high"))
        seeds, _ = score_seed_rows(parse_seed_csv(text)[0])
        self.assertEqual(seeds[0].refresh_cadence, "every_3_days")

    def test_curator_priority_does_not_change_score(self):
        """Curator priority is cadence-only — it must never alter trend_seed_score."""
        with_pri = _csv(_row("entryway decor ideas", "home-decor", curator_priority="high"))
        without = _csv(_row("entryway decor ideas", "home-decor"))
        s_with = score_seed_rows(parse_seed_csv(with_pri)[0])[0][0]
        s_without = score_seed_rows(parse_seed_csv(without)[0])[0][0]
        self.assertEqual(s_with.trend_seed_score, s_without.trend_seed_score)


class TestSourceLabeling(unittest.TestCase):
    def test_manual_rows_never_official(self):
        text = _csv(
            _row("quiet luxury outfit ideas", "fashion", source="manual_bootstrap"),
            _row("printable budget planner template", "digital-products", source="csv_bootstrap"),
        )
        valid, _ = parse_seed_csv(text)
        seeds, _ = score_seed_rows(valid)
        for s in seeds:
            self.assertIn(s.raw["trend_source"], ("manual_bootstrap", "csv_bootstrap"))

    def test_forbidden_source_coerced_to_manual(self):
        text = _csv(_row("quiet luxury outfit ideas", "fashion", source="official_v5"))
        valid, _ = parse_seed_csv(text)
        self.assertEqual(valid[0]["source"], "manual_bootstrap")
        self.assertTrue(any("forced to manual_bootstrap" in w for w in valid[0]["warnings"]))

    def test_built_db_row_labels_manual_and_nulls_exact_volume(self):
        """Even with a numeric search_volume, the DB row stays manual + no exact volume."""
        from trend_fetcher import build_trend_keyword_row
        text = _csv(_row("quiet luxury outfit ideas", "fashion", search_volume="40000"))
        valid, _ = parse_seed_csv(text)
        seeds, _ = score_seed_rows(valid)
        row = build_trend_keyword_row(seeds[0].to_keyword_dict(), "fashion")
        self.assertEqual(row["source"], "manual_bootstrap")
        self.assertEqual(row["source_layer"], "manual_bootstrap")
        self.assertNotIn("official", row["source"])
        self.assertIsNone(row["search_volume"])  # never an exact authoritative volume


class TestDuplicateHandling(unittest.TestCase):
    def test_in_file_duplicates_skipped(self):
        text = _csv(
            _row("summer nail aesthetic", "beauty"),
            _row("summer nail aesthetic", "beauty", search_volume="9000"),
        )
        valid, _ = parse_seed_csv(text)
        seeds, dups = score_seed_rows(valid)
        self.assertEqual(len(seeds), 1)
        self.assertEqual(len(dups), 1)


class TestDryRunReport(unittest.TestCase):
    def _write_temp(self, text: str) -> str:
        fd, path = tempfile.mkstemp(suffix=".csv")
        os.close(fd)
        Path(path).write_text(text, encoding="utf-8")
        return path

    def test_dry_run_writes_nothing(self):
        text = _csv(
            _row("boho living room decor ideas", "home-decor", curator_priority="high"),
            _row("clean girl makeup look", "beauty"),
        )
        path = self._write_temp(text)
        try:
            with patch.object(seed_bootstrap, "_apply_writes", side_effect=AssertionError("no write in dry-run")) as mock_write:
                report = run_bootstrap(path, apply=False)
            mock_write.assert_not_called()
            self.assertEqual(report["mode"], "dry-run")
            self.assertEqual(report["seedsScored"], 2)
            self.assertEqual(report["searchVolumeNullCount"], 2)
            self.assertGreaterEqual(report["projectedCrawlQueueEntries"], 1)
        finally:
            os.unlink(path)

    def test_p0_coverage_reported_distinct(self):
        text = _csv(
            _row("quiet luxury outfit ideas", "fashion"),
            _row("fall capsule wardrobe women", "womens-fashion"),
            _row("boho living room decor ideas", "home-decor"),
            _row("clean girl makeup look", "beauty"),
            _row("printable budget planner template", "digital-products", source="csv_bootstrap"),
        )
        path = self._write_temp(text)
        try:
            report = run_bootstrap(path, apply=False)
            cov = report["p0CategoryCoverage"]
            present = set(cov["present"])
            self.assertTrue({"fashion", "home-decor", "beauty", "digital-products"} <= present)
            # fashion and womens-fashion are distinct, not double-counted
            self.assertTrue(cov["fashionFamily"]["fashionPresent"])
            self.assertTrue(cov["fashionFamily"]["womensFashionSubcategoryPresent"])
            self.assertEqual(report["categoryDistribution"]["fashion"], 1)
            self.assertEqual(report["categoryDistribution"]["womens-fashion"], 1)
        finally:
            os.unlink(path)

    def test_missing_file_raises(self):
        with self.assertRaises(FileNotFoundError):
            run_bootstrap("does/not/exist.csv", apply=False)


class TestSourceSeparation(unittest.TestCase):
    def test_sub_buckets_distinct(self):
        rows = [
            {"source_layer": "official_v5", "keyword": "boho decor"},
            {"source_layer": "manual_bootstrap", "keyword": "quiet luxury outfit"},
            {"source_layer": "csv_bootstrap", "keyword": "printable planner"},
            {"source_layer": "l3_typeahead_degraded", "keyword": "soft aesthetic"},
            {"source_layer": "L3", "keyword": "pastel vibes"},
            {"source_layer": "manual_bootstrap", "keyword": "e2e-fixture-test"},
        ]
        sep = build_source_separation(rows)
        self.assertEqual(sep["official_v5"], 1)
        self.assertEqual(sep["manual_bootstrap"], 1)   # csv kept separate
        self.assertEqual(sep["csv_bootstrap"], 1)
        self.assertEqual(sep["l3_typeahead_degraded"], 1)
        self.assertEqual(sep["l3_typeahead"], 1)
        self.assertEqual(sep["fixture"], 1)            # fixture wins over manual layer
        self.assertEqual(sep["bootstrapTotal"], 2)     # manual + csv, no official/degraded

    def test_classify_fixture_wins(self):
        self.assertEqual(classify_source_bucket("manual_bootstrap", "e2e-thing"), "fixture")
        self.assertEqual(classify_source_bucket("csv_bootstrap", "real keyword"), "csv_bootstrap")


class TestSampleCsv(unittest.TestCase):
    def test_sample_csv_dry_run_covers_all_p0(self):
        sample = Path(__file__).parent.parent / "data" / "manual_trend_seeds.sample.csv"
        if not sample.exists():
            self.skipTest("sample CSV not present")
        report = run_bootstrap(str(sample), apply=False)
        self.assertGreaterEqual(report["validRows"], 40)
        present = set(report["p0CategoryCoverage"]["present"])
        self.assertTrue({"fashion", "home-decor", "beauty", "digital-products"} <= present)
        self.assertGreaterEqual(report["projectedCrawlQueueEntries"], 40)
        # Sample asserts NO authoritative volumes — all search_volume blank
        self.assertEqual(report["searchVolumeNumericCount"], 0)
        self.assertEqual(report["searchVolumeNullCount"], report["validRows"])


if __name__ == "__main__":
    unittest.main()
