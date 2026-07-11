"""Unit tests for trend source labeling."""

import unittest
from unittest.mock import AsyncMock, patch

import trend_fetcher
from trend_fetcher import SOURCE_LABELS, build_trend_keyword_row, source_metadata


class TestTrendSourceLabels(unittest.TestCase):
    def test_official_api_label(self):
        src, quality, confidence = source_metadata("pinterest_trends_api")
        self.assertEqual(src, "pinterest_trends_official")
        self.assertEqual(quality, "official")
        self.assertEqual(confidence, "high")

    def test_resource_label(self):
        src, quality, confidence = source_metadata("internal_resource")
        self.assertEqual(src, "pinterest_resource")
        self.assertEqual(quality, "resource")
        self.assertEqual(confidence, "medium")

    def test_typeahead_label(self):
        src, quality, confidence = source_metadata("typeahead_estimate")
        self.assertEqual(src, "pinterest_typeahead_estimated")
        self.assertEqual(quality, "estimated")
        self.assertEqual(confidence, "low")

    def test_unknown_defaults_to_estimated(self):
        src, quality, _ = source_metadata("unknown_layer")
        self.assertEqual(src, "pinterest_typeahead_estimated")
        self.assertEqual(quality, "estimated")

    def test_all_layers_mapped(self):
        self.assertIn("pinterest_trends_api", SOURCE_LABELS)
        self.assertIn("internal_resource", SOURCE_LABELS)
        self.assertIn("typeahead_estimate", SOURCE_LABELS)

    def test_l1_row_metadata(self):
        row = build_trend_keyword_row({
            "keyword": "summer nails",
            "trend_source": "pinterest_trends_api",
            "pct_growth_yoy": 120,
            "pct_growth_wow": 5,
            "volume_score": 3,
            "search_volume_level": "high",
            "search_volume": 12345,
        }, "beauty")
        self.assertEqual(row["source"], "pinterest_trends_official")
        self.assertEqual(row["data_quality"], "official")
        self.assertEqual(row["confidence"], "high")
        self.assertEqual(row["source_layer"], "L1")
        self.assertEqual(row["search_volume"], 12345)

    def test_l2_row_metadata(self):
        row = build_trend_keyword_row({
            "keyword": "room decor",
            "trend_source": "internal_resource",
            "pct_growth_yoy": 120,
            "pct_growth_wow": 1,
            "volume_score": 2,
            "search_volume_level": "medium",
        }, "home-decor")
        self.assertEqual(row["source"], "pinterest_resource")
        self.assertEqual(row["data_quality"], "resource")
        self.assertEqual(row["confidence"], "medium")
        self.assertEqual(row["source_layer"], "L2")

    def test_l3_row_metadata_does_not_write_exact_search_volume(self):
        row = build_trend_keyword_row({
            "keyword": "printable planner",
            "trend_source": "typeahead_estimate",
            "pct_growth_yoy": 500,
            "pct_growth_wow": 10,
            "volume_score": 4,
            "search_volume_level": "very_high",
            "search_volume": 999999,
        }, "digital-products")
        self.assertEqual(row["source"], "pinterest_typeahead_estimated")
        self.assertEqual(row["data_quality"], "estimated")
        self.assertIn(row["confidence"], ("low", "medium"))
        self.assertEqual(row["source_layer"], "L3")
        self.assertEqual(row["volume_signal"], "very_high")
        self.assertIsNone(row["search_volume"])


class TestLayerFeatureFlags(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.old = (
            trend_fetcher.ENABLE_PINTEREST_TRENDS_L1,
            trend_fetcher.ENABLE_PINTEREST_RESOURCE_L2,
            trend_fetcher.ENABLE_TYPEAHEAD_L3,
        )

    async def asyncTearDown(self):
        (
            trend_fetcher.ENABLE_PINTEREST_TRENDS_L1,
            trend_fetcher.ENABLE_PINTEREST_RESOURCE_L2,
            trend_fetcher.ENABLE_TYPEAHEAD_L3,
        ) = self.old

    async def test_disabling_l1_skips_l1(self):
        trend_fetcher.ENABLE_PINTEREST_TRENDS_L1 = False
        trend_fetcher.ENABLE_PINTEREST_RESOURCE_L2 = False
        trend_fetcher.ENABLE_TYPEAHEAD_L3 = True
        session = type("S", (), {"stats": {"l1_disabled": 0, "l2_disabled": 0, "l3_disabled": 0}})()
        with patch.object(trend_fetcher, "layer3_typeahead_scoring", new=AsyncMock(return_value=[])):
            await trend_fetcher.discover_trends_for_interest("home_decor", "home-decor", session=session)
        self.assertEqual(session.stats["l1_disabled"], 1)

    async def test_disabling_l2_skips_l2(self):
        trend_fetcher.ENABLE_PINTEREST_TRENDS_L1 = False
        trend_fetcher.ENABLE_PINTEREST_RESOURCE_L2 = False
        trend_fetcher.ENABLE_TYPEAHEAD_L3 = True
        session = type("S", (), {"stats": {"l1_disabled": 0, "l2_disabled": 0, "l3_disabled": 0}})()
        with patch.object(trend_fetcher, "layer3_typeahead_scoring", new=AsyncMock(return_value=[])):
            await trend_fetcher.discover_trends_for_interest("home_decor", "home-decor", session=session)
        self.assertEqual(session.stats["l2_disabled"], 1)

    async def test_disabling_l3_skips_l3(self):
        trend_fetcher.ENABLE_PINTEREST_TRENDS_L1 = False
        trend_fetcher.ENABLE_PINTEREST_RESOURCE_L2 = False
        trend_fetcher.ENABLE_TYPEAHEAD_L3 = False
        session = type("S", (), {"stats": {"l1_disabled": 0, "l2_disabled": 0, "l3_disabled": 0}})()
        rows = await trend_fetcher.discover_trends_for_interest("home_decor", "home-decor", session=session)
        self.assertEqual(rows, [])
        self.assertEqual(session.stats["l3_disabled"], 1)

    async def test_all_layers_disabled_exits_cleanly(self):
        trend_fetcher.ENABLE_PINTEREST_TRENDS_L1 = False
        trend_fetcher.ENABLE_PINTEREST_RESOURCE_L2 = False
        trend_fetcher.ENABLE_TYPEAHEAD_L3 = False
        session = type("S", (), {"stats": {"l1_disabled": 0, "l2_disabled": 0, "l3_disabled": 0}})()
        rows = await trend_fetcher.discover_trends_for_interest("home_decor", "home-decor", session=session)
        self.assertEqual(rows, [])
        self.assertEqual(session.stats["l1_disabled"], 1)
        self.assertEqual(session.stats["l2_disabled"], 1)
        self.assertEqual(session.stats["l3_disabled"], 1)


if __name__ == "__main__":
    unittest.main()
